import * as vscode from 'vscode';
import { XsdReference, EnhancedAttributeInfo } from 'xsd-lookup';
import { xmlTracker, XmlElement } from '../xml/xmlStructureTracker';
import { getDocumentScriptType } from './scriptsMetadata';
import { ScriptProperties } from './scriptProperties';
import { ScriptReferencedCompletion, checkReferencedItemAttributeType, scriptReferencedItemsRegistry } from './scriptReferencedItems';
import { VariableTracker, ScriptVariableAtPosition } from './scriptVariables';
import { getNearestBreakSymbolIndexForExpressions, isInsideSingleQuotedString, isSingleQuoteExclusion } from './scriptUtilities';
import { logger } from '../logger/logger';

export type CompletionsMap = Map<string, vscode.CompletionItem>;

export class ScriptCompletion implements vscode.CompletionItemProvider {
  private static readonly completionTypes: Map<string, vscode.CompletionItemKind> = new Map([
    ['element', vscode.CompletionItemKind.Function],
    ['attribute', vscode.CompletionItemKind.Property],
    ['property', vscode.CompletionItemKind.Struct],
    ['label', vscode.CompletionItemKind.Reference],
    ['actions', vscode.CompletionItemKind.Module],
    ['variable', vscode.CompletionItemKind.Variable],
    ['value', vscode.CompletionItemKind.Value],
  ]);

  private xsdReference: XsdReference;
  private scriptProperties: ScriptProperties;
  private variablesTracker: VariableTracker;
  private processQueuedDocumentChanges: () => void;

  constructor(xsdReference: XsdReference, scriptProperties: ScriptProperties, variablesTracker: VariableTracker, processQueuedDocumentChanges: () => void) {
    this.xsdReference = xsdReference;
    this.scriptProperties = scriptProperties;
    this.variablesTracker = variablesTracker;
    this.processQueuedDocumentChanges = processQueuedDocumentChanges;
  }

  private static getType(type: string): vscode.CompletionItemKind {
    return this.completionTypes.get(type) || vscode.CompletionItemKind.Text;
  }

  public static addItem(items: Map<string, vscode.CompletionItem>, type: string, completion: string, info?: vscode.MarkdownString, range?: vscode.Range): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(completion) > -1) {
      return;
    }

    if (items.has(completion)) {
      logger.debug('\t\tSkipped existing completion: ', completion);
      return;
    }

    const item = new vscode.CompletionItem(completion, this.getType(type));
    if (info) {
      item.documentation = info;
    }
    if (range) {
      item.range = range;
    }
    logger.debug('\t\tAdded completion: ' + completion + ' info: ' + item.detail);
    items.set(completion, item);
  }

  // ! TODO: Add a ranges to completions items

  private static emptyCompletion = new vscode.CompletionList([], false);

  private static makeCompletionList(items: CompletionsMap, prefix: string = '', isIncomplete: boolean = true): vscode.CompletionList {
    if (items.size === 0) {
      return this.emptyCompletion;
    } else if (items.size === 1 && prefix !== '' && items.has(prefix)) {
      return this.emptyCompletion;
    }
    return new vscode.CompletionList(Array.from(items.values()), isIncomplete);
  }
  private static movePositionLeft(position: vscode.Position, document: vscode.TextDocument): vscode.Position | undefined {
    if (position.character > 0) {
      // Move left within the same line
      return position.translate(0, -1);
    } else if (position.line > 0) {
      // Move to the end of the previous line
      const prevLine = position.line - 1;
      const prevLineLength = document.lineAt(prevLine).text.length;
      return new vscode.Position(prevLine, prevLineLength);
    } else {
      // At beginning of document, can't move left
      return undefined;
    }
  }

  private elementNameCompletion(
    schema: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    element: XmlElement,
    parent: XmlElement | undefined,
    range?: vscode.Range
  ): vscode.CompletionList {
    const items: CompletionsMap = new Map();
    const parentName = parent ? parent.name : '';
    const parentHierarchy = parent ? parent.hierarchy : [];
    const currentElement: XmlElement | undefined = element;
    let previousElement: XmlElement | undefined = element?.previous || undefined;
    if (currentElement === undefined && parent !== undefined) {
      const documentText = document.getText();
      const previousElementEndIndex = documentText.lastIndexOf('>', document.offsetAt(position) - 1);
      previousElement = xmlTracker.elementWithPosIn(document, document.positionAt(previousElementEndIndex));
      if (previousElement && previousElement.parent !== parent) {
        previousElement = undefined;
      }
    }
    logger.debug(`Current element: ${currentElement?.name}, Previous element: ${previousElement?.name}, Parent element: ${parent?.name}`);
    const possibleElements = this.xsdReference.getPossibleChildElements(
      schema,
      parentName,
      parentHierarchy,
      previousElement ? previousElement.name : undefined
    );
    if (possibleElements !== undefined) {
      logger.debug(`Possible elements for ${parentName}:`, possibleElements);
      const currentLinePrefix = document.lineAt(position).text.substring(0, position.character);
      const startTagIndex = currentLinePrefix.lastIndexOf('<');
      if (startTagIndex === -1) {
        logger.debug('No start tag found in current line prefix:', currentLinePrefix);
        return ScriptCompletion.emptyCompletion; // Skip if no start tag found
      }
      let prefix = currentLinePrefix.slice(currentLinePrefix.lastIndexOf('<') + 1);
      if (prefix.includes(' ')) {
        logger.debug('Start tag inside prefix contains space, skipping:', prefix);
        return ScriptCompletion.emptyCompletion; // Skip if the start tag inside prefix contains a space
      }
      if (prefix === '' && element !== undefined && element.name !== '') {
        prefix = element.name;
      }
      for (const [value, info] of possibleElements.entries()) {
        if (!prefix || value.startsWith(prefix)) {
          ScriptCompletion.addItem(items, 'element', `${value}`, new vscode.MarkdownString(info), range);
        }
      }
      return ScriptCompletion.makeCompletionList(items, prefix);
      // return new vscode.CompletionList(Array.from(items.values()), false);
    } else {
      logger.debug('No possible elements found for:', parentName);
    }
  }

  private static attributeNameCompletion(
    element: XmlElement,
    elementAttributes: EnhancedAttributeInfo[],
    prefix: string = '',
    range?: vscode.Range
  ): vscode.CompletionList {
    const items: CompletionsMap = new Map();
    for (const attr of elementAttributes) {
      if (!element.attributes.some((a) => a.name === attr.name) && (prefix == '' || attr.name.startsWith(prefix))) {
        ScriptCompletion.addItem(
          items,
          'attribute',
          attr.name,
          new vscode.MarkdownString(`${attr.annotation || ''}  \n**Required**: ${attr.required ? '**Yes**' : 'No'}  \n**Type**: ${attr.type || 'unknown'}`),
          range
        );
      }
    }
    if (items.size > 0) {
      return ScriptCompletion.makeCompletionList(items, prefix);
    }
    return this.emptyCompletion;
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
    context?: vscode.CompletionContext
  ): vscode.CompletionItem[] | vscode.CompletionList | undefined {
    if (token?.isCancellationRequested) {
      return undefined;
    }
    logger.debug(`Providing completion items for document: ${document.uri} with context: ${JSON.stringify(context)}`);
    const schema = getDocumentScriptType(document);
    if (schema == '') {
      return ScriptCompletion.emptyCompletion; // Skip if the document is not valid
    }
    if (context.triggerKind > vscode.CompletionTriggerKind.Invoke && this.processQueuedDocumentChanges) {
      this.processQueuedDocumentChanges();
    }
    const items = new Map<string, vscode.CompletionItem>();
    const currentLine = position.line;

    const characterAtPosition = document.getText(new vscode.Range(position, position.translate(0, 1)));

    const element = xmlTracker.elementWithPosInStartTag(document, position);
    if (element) {
      logger.debug(`Completion requested in element: ${element.name}`);

      const elementByName = xmlTracker.elementWithPosInName(document, position, element);
      if (elementByName) {
        if (element.parent !== undefined) {
          return this.elementNameCompletion(schema, document, position, element, element.parent, element.nameRange);
        }
      }

      const elementAttributes: EnhancedAttributeInfo[] = this.xsdReference.getElementAttributesWithTypes(schema, element.name, element.hierarchy);

      let attribute = xmlTracker.attributeWithPosInName(document, position, element);
      if (attribute) {
        logger.debug(`Completion requested in attribute name: ${attribute.element.name}.${attribute.name}`);
      }
      if (attribute) {
        if (elementAttributes !== undefined) {
          let prefix = document.getText(new vscode.Range(attribute.nameRange.start, position));
          if (prefix === '' && attribute.name !== '') {
            prefix = attribute.name; // If the prefix is empty, use the current attribute name
          }
          return ScriptCompletion.attributeNameCompletion(element, elementAttributes, prefix, attribute.nameRange);
        }
      }

      // Check if we're in an attribute value for context-aware completions
      attribute = xmlTracker.attributeWithPosInValue(document, position);
      if (attribute) {
        logger.debug(`Completion requested in attribute value: ${attribute.element.name}.${attribute.name}`);
      }
      if (attribute === undefined) {
        if (characterAtPosition !== '=' && elementAttributes !== undefined) {
          return ScriptCompletion.attributeNameCompletion(element, elementAttributes);
        } else {
          return ScriptCompletion.emptyCompletion; // Skip if not in an attribute value
        }
      }

      // If we're in an attribute value, check if it's a single-quoted string
      if (
        attribute.name === 'comment' ||
        (!isSingleQuoteExclusion(element.name, attribute.name) &&
          isInsideSingleQuotedString(document.getText(attribute.valueRange), document.offsetAt(position) - document.offsetAt(attribute.valueRange.start)))
      ) {
        logger.debug(`Completion requested in comment or single-quoted attribute value: ${attribute.element.name}.${attribute.name}`);
        return undefined;
      }

      const attributeInfo = elementAttributes.find((attr) => attr.name === attribute.name);
      const attributeValue = attribute.value || '';

      // If we're in an attribute value, we need to check for possible values
      const attributeValues: Map<string, string> = elementAttributes
        ? XsdReference.getAttributePossibleValues(elementAttributes, attribute.name)
        : new Map<string, string>();
      if (attributeValues.size > 0) {
        // If the attribute has predefined values, return them as completions
        let prefix = document.getText(new vscode.Range(attribute.valueRange.start, position));
        if (prefix === '' && attributeValue !== '') {
          prefix = attributeValue; // If the prefix is empty, use the current attribute value
        }
        for (const [value, info] of attributeValues.entries()) {
          if (token?.isCancellationRequested) return undefined;
          if (prefix == '' || value.startsWith(prefix)) {
            // Only add the item if it matches the prefix
            ScriptCompletion.addItem(items, 'value', value, new vscode.MarkdownString(info), attribute.valueRange);
          }
        }
        return ScriptCompletion.makeCompletionList(items, prefix);
      }
      const referencedItemAttributeDetected = checkReferencedItemAttributeType(schema, element, attribute.name, attributeInfo.type || 'undefined');
      let valueCompletion: ScriptReferencedCompletion = new Map();
      // Check if we're in a label or action context
      if (referencedItemAttributeDetected && !referencedItemAttributeDetected.noCompletion && !attributeValue.includes('$')) {
        let prefix = document.getText(new vscode.Range(attribute.valueRange.start, position));
        if (prefix === '' && attributeValue !== '') {
          prefix = attributeValue; // If the prefix is empty, use the current attribute value
        }
        if (scriptReferencedItemsRegistry.has(referencedItemAttributeDetected.type)) {
          logger.debug(`Completion requested in referenced item attribute: ${element.name}.${attribute.name} of type ${referencedItemAttributeDetected.type}`);
          const trackerInfo = scriptReferencedItemsRegistry.get(referencedItemAttributeDetected.type);
          if (trackerInfo) {
            valueCompletion = trackerInfo.tracker.getAllItemsForCompletion(document, prefix);
          } else {
            logger.warn(`No tracker found for referenced item type: ${referencedItemAttributeDetected.type}`);
          }
        }

        if (valueCompletion.size > 0) {
          for (const [value, info] of valueCompletion.entries()) {
            if (token?.isCancellationRequested) return undefined;
            ScriptCompletion.addItem(items, referencedItemAttributeDetected.type, value, info, attribute.valueRange);
          }
          return ScriptCompletion.makeCompletionList(items, prefix);
        }
        return ScriptCompletion.emptyCompletion; // Skip if no items found
      }

      const documentLine = document.lineAt(position);
      let textToProcessBefore = document.lineAt(position).text;
      let textToProcessAfter = '';
      if (currentLine === attribute.valueRange.start.line && currentLine === attribute.valueRange.end.line) {
        // If we're on the same line as the attribute value, use the current line text
        if (position.character < attribute.valueRange.end.character) {
          // If the position is before the end of the attribute value, use the rest of the line
          textToProcessAfter = textToProcessBefore.substring(position.character, attribute.valueRange.end.character);
        }
        textToProcessBefore = textToProcessBefore.substring(attribute.valueRange.start.character, position.character);
      } else if (currentLine === attribute.valueRange.start.line) {
        // If we're on the start line of the attribute value, use the text from the start character to the end of the line
        if (position.character < attribute.valueRange.start.character) {
          textToProcessAfter = textToProcessBefore.substring(position.character);
        }
        textToProcessBefore = textToProcessBefore.substring(attribute.valueRange.start.character, position.character);
      } else if (currentLine === attribute.valueRange.end.line) {
        if (position.character < attribute.valueRange.end.character) {
          textToProcessAfter = textToProcessBefore.substring(position.character, attribute.valueRange.end.character);
        }
        textToProcessBefore = textToProcessBefore.substring(0, position.character);
      } else {
        if (position.character < documentLine.range.end.character) {
          textToProcessAfter = textToProcessBefore.substring(position.character);
        }
        textToProcessBefore = textToProcessBefore.substring(0, position.character);
      }

      const lastBreakIndex = getNearestBreakSymbolIndexForExpressions(textToProcessBefore, true);
      const firstBreakIndex = getNearestBreakSymbolIndexForExpressions(textToProcessAfter, false);

      const lastDollarIndex = textToProcessBefore.lastIndexOf('$');
      const prefix = lastDollarIndex < textToProcessBefore.length ? textToProcessBefore.substring(lastDollarIndex + 1) : '';
      if (lastDollarIndex >= 0 && lastDollarIndex > lastBreakIndex && (prefix === '' || /^[a-zA-Z0-9_]*$/.test(prefix))) {
        if (firstBreakIndex >= 0) {
          textToProcessAfter = textToProcessAfter.substring(0, firstBreakIndex);
        }
        const variableRange = new vscode.Range(
          position.translate(0, -textToProcessBefore.length + lastDollarIndex + 1),
          position.translate(0, textToProcessAfter.length)
        );
        const variableCompletion = this.variablesTracker.getAllVariablesForDocumentMap(document, position, prefix);

        if (token?.isCancellationRequested) return undefined;

        for (const [variableName, info] of variableCompletion.entries()) {
          ScriptCompletion.addItem(items, 'variable', variableName, info, variableRange);
        }

        if (token?.isCancellationRequested) return undefined;

        return ScriptCompletion.makeCompletionList(items, prefix);
      } else {
        // If cursor is inside a single-quoted string, don't provide script properties completions
        const lineText = document.lineAt(position.line).text;
        const upto = lineText.slice(0, position.character);
        let inSingle = false,
          inDouble = false;
        for (let i = 0; i < upto.length; i++) {
          const ch = upto[i];
          if (ch === '"' && !inSingle) inDouble = !inDouble;
          else if (ch === "'" && !inDouble) inSingle = !inSingle;
        }
        if (inSingle) {
          return ScriptCompletion.emptyCompletion;
        }
        return this.scriptProperties.makeCompletionsFromExpression(
          textToProcessBefore,
          textToProcessAfter,
          attributeInfo?.type || 'undefined',
          schema,
          position,
          token,
          context
        );
      }
    } else {
      const element = xmlTracker.elementWithPosIn(document, position);
      if (token?.isCancellationRequested) return undefined;
      if (element) {
        logger.debug(`Completion requested in element range: ${element.name}`);
        return this.elementNameCompletion(schema, document, position, undefined, element);
      }
    }
    return ScriptCompletion.emptyCompletion; // Skip if not in an element range
  }

  dispose() {}
}
