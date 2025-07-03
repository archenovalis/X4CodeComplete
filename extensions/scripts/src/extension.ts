// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as sax from 'sax';
import { xmlTracker, XmlElement, XmlStructureTracker } from './xml/xmlStructureTracker';
import { logger, setLoggerLevel } from './logger/logger';
import { XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from 'xsd-lookup';
import { ReferencedItemsTracker, findSimilarItems, checkReferencedItemAttributeType, ScriptReferencedCompletion } from './scripts/scriptReferencedItems';
import { ScriptProperties } from './scripts/scriptProperties';
import { getDocumentScriptType, scriptsMetadata, aiScriptId, mdScriptId, scriptNodes, scriptsMetadataSet, scriptsMetadataClearAll } from './scripts/scriptsMetadata';
import { VariableTracker } from './scripts/scriptVariables';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
let isDebugEnabled = false;
let rootpath: string;
let extensionsFolder: string;
let forcedCompletion: boolean = false;
let languageData: Map<string, Map<string, string>> = new Map();
let xsdReference: XsdReference;
let scriptProperties: ScriptProperties;





// Flag to indicate if specialized completion is active
// let isSpecializedCompletion: boolean = false;

// Map to store languageSubId for each document
const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]+)/g;
const tableKeyPattern = /table\[/;



// Add settings validation function
function validateSettings(config: vscode.WorkspaceConfiguration): boolean {
  const requiredSettings = ['unpackedFileLocation', 'extensionsFolder'];

  let isValid = true;
  requiredSettings.forEach((setting) => {
    if (!config.get(setting)) {
      vscode.window.showErrorMessage(`Missing required setting: ${setting}. Please update your VSCode settings.`);
      isValid = false;
    }
  });

  return isValid;
}

type CompletionsMap = Map<string, vscode.CompletionItem>;


const variableTracker = new VariableTracker();
const labelTracker = new ReferencedItemsTracker('label');
const actionsTracker = new ReferencedItemsTracker('actions');


type ExternalPositions = Map<string, number>;
type ExternalActions = Map<string, ExternalPositions>;
// ActionTracker class for tracking AIScript actions



class ScriptCompletion implements vscode.CompletionItemProvider {

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
  private xmlTracker: XmlStructureTracker;
  private scriptProperties: ScriptProperties;
  private labelTracker: ReferencedItemsTracker;
  private actionsTracker: ReferencedItemsTracker;
  private variablesTracker: VariableTracker;

  constructor(xsdReference: XsdReference, xmlStructureTracker: XmlStructureTracker, scriptProperties: ScriptProperties, labelTracker: ReferencedItemsTracker, actionsTracker: ReferencedItemsTracker, variablesTracker: VariableTracker) {
    this.xsdReference = xsdReference;
    this.xmlTracker = xmlStructureTracker;
    this.scriptProperties = scriptProperties;
    this.labelTracker = labelTracker;
    this.actionsTracker = actionsTracker;
    this.variablesTracker = variablesTracker;
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

    const item = new vscode.CompletionItem(completion, this.getType(type) );
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

  private elementNameCompletion(schema: string, document: vscode.TextDocument, position: vscode.Position, element: XmlElement, parentName: string, parentHierarchy: string[], range?: vscode.Range): vscode.CompletionList {
    const items: CompletionsMap = new Map();
    const possibleElements = this.xsdReference.getPossibleChildElements(schema, parentName, parentHierarchy);
    if (possibleElements !== undefined) {
      logger.debug(`Possible elements for ${parentName}:`, possibleElements);
      const currentLinePrefix =  document.lineAt(position).text.substring(0, position.character);
      const startTagIndex = currentLinePrefix.lastIndexOf('<');
      if (startTagIndex === -1) {
        logger.debug('No start tag found in current line prefix:', currentLinePrefix);
        return ScriptCompletion.emptyCompletion;; // Skip if no start tag found
      }
      let prefix = currentLinePrefix.slice(currentLinePrefix.lastIndexOf('<') + 1);
      if (prefix.includes(' ')) {
        logger.debug('Start tag inside prefix contains space, skipping:', prefix);
        return ScriptCompletion.emptyCompletion;; // Skip if the start tag inside prefix contains a space
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

  private static attributeNameCompletion(element: XmlElement, elementAttributes: EnhancedAttributeInfo[], prefix: string = '', range?: vscode.Range): vscode.CompletionList {
    const items: CompletionsMap = new Map();
    for (const attr of elementAttributes) {
      if (!element.attributes.some((a) => a.name === attr.name) && (prefix == '' || attr.name.startsWith(prefix))) {
        ScriptCompletion.addItem(
          items,
          'attribute',
          attr.name,
          new vscode.MarkdownString(`${attr.annotation || ''}\n\n**Required**: ${attr.required ? '**Yes**' : 'No'}\n\n**Type**: ${attr.type || 'unknown'}`),
          range
        );
      }
    }
    if (items.size > 0) {
      return ScriptCompletion.makeCompletionList(items, prefix);
    }
    return this.emptyCompletion;
  }

  public prepareCompletion(document: vscode.TextDocument, position: vscode.Position, checkOnly: boolean, token?: vscode.CancellationToken, context?: vscode.CompletionContext): vscode.CompletionItem[] | vscode.CompletionList | undefined {
    const schema = getDocumentScriptType(document);
    if (schema == '') {
      return ScriptCompletion.emptyCompletion;; // Skip if the document is not valid
    }
    const items = new Map<string, vscode.CompletionItem>();
    const currentLine = position.line;

    const characterAtPosition = document.getText(new vscode.Range(position, position.translate(0, 1)));

    const element = this.xmlTracker.elementWithPosInStartTag(document, position);
    if (element) {
      logger.debug(`Completion requested in element: ${element.name}`);

      const elementByName = this.xmlTracker.elementWithPosInName(document, position);
      if (elementByName) {
        if (checkOnly) {
          return []; // Return empty list if only checking
        } else {
          if (element.parent !== undefined) {
            return this.elementNameCompletion(schema, document, position, element, element.parent.name, element.parent.hierarchy, element.nameRange);
          }
        }
      }

      const elementAttributes: EnhancedAttributeInfo[] = this.xsdReference.getElementAttributesWithTypes(
        schema,
        element.name,
        element.hierarchy
      );

      let attribute = this.xmlTracker.attributeWithPosInName(document, position);
      if (attribute) {
        logger.debug(`Completion requested in attribute name: ${attribute.element.name}.${attribute.name}`);
      }
      if (attribute) {
        if (checkOnly) {
          return []; // Return empty list if only checking
        }
        if (elementAttributes !== undefined) {
          let prefix = document.getText(new vscode.Range(attribute.nameRange.start, position));
          if (prefix === '' && attribute.name !== '') {
            prefix = attribute.name; // If the prefix is empty, use the current attribute name
          }
          return ScriptCompletion.attributeNameCompletion(element, elementAttributes, prefix, attribute.nameRange);
        }
      }

      // Check if we're in an attribute value for context-aware completions
      attribute = this.xmlTracker.attributeWithPosInValue(document, position);
      if (attribute) {
        logger.debug(`Completion requested in attribute value: ${attribute.element.name}.${attribute.name}`);
      }
      if (attribute === undefined) {
        if (checkOnly) {
          return undefined; // Return undefined if only checking
        }
        if (characterAtPosition !== '=' && elementAttributes !== undefined) {
          return ScriptCompletion.attributeNameCompletion(element, elementAttributes);
        } else {
          return ScriptCompletion.emptyCompletion; // Skip if not in an attribute value
        }
      }
      if (checkOnly) {
        return []; // Return empty list if only checking
      }

      const attributeValue = document.getText(attribute.valueRange);

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
          if (prefix == '' || value.startsWith(prefix)) {
            // Only add the item if it matches the prefix
            ScriptCompletion.addItem(items, 'value', value, new vscode.MarkdownString(info), attribute.valueRange);
          }
        }
        return ScriptCompletion.makeCompletionList(items, prefix);
      }
      const referencedItemAttributeDetected = checkReferencedItemAttributeType(element.name, attribute.name);
      let valueCompletion: ScriptReferencedCompletion = new Map();
      // Check if we're in a label or action context
      if (referencedItemAttributeDetected) {
        let prefix = document.getText(new vscode.Range(attribute.valueRange.start, position));
        if (prefix === '' && attributeValue !== '') {
          prefix = attributeValue; // If the prefix is empty, use the current attribute value
        }

        switch (referencedItemAttributeDetected.type) {
          case 'label':
            logger.debug(`Completion requested in label attribute: ${element.name}.${attribute.name}`);
            valueCompletion = this.labelTracker.getAllItemsForCompletion(document, prefix);
            break;
          case 'actions':
            logger.debug(`Completion requested in actions attribute: ${element.name}.${attribute.name}`);
            valueCompletion = this.actionsTracker.getAllItemsForCompletion(document, prefix);
            break;
        }

        if (valueCompletion.size > 0) {
          for (const [value, info] of valueCompletion.entries()) {
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
      const lastDollarIndex = textToProcessBefore.lastIndexOf('$');
      if (lastDollarIndex >= 0) {
        const prefix = lastDollarIndex < textToProcessBefore.length ? textToProcessBefore.substring(lastDollarIndex + 1) : '';
        if (prefix === '' || /^[a-zA-Z0-9_]*$/.test(prefix)) {
          let suffixLength = textToProcessAfter.length;
          for (const breakSymbol of [' ', '.', '[', ']', '{', '}', '(', ')']) {
            const breakIndex = textToProcessAfter.indexOf(breakSymbol);
            if (breakIndex >= 0 && breakIndex < suffixLength) {
              suffixLength = breakIndex;
              break;
            }
          }
          const variableRange = new vscode.Range(
            position.translate(0, -textToProcessBefore.length + lastDollarIndex + 1),
            position.translate(0, suffixLength)
          );
        const variableCompletion = this.variablesTracker.getAllVariablesForDocumentMap(document, prefix);
          for (const [variableName, info] of variableCompletion.entries()) {
            ScriptCompletion.addItem(items, 'variable', variableName, info, variableRange);
          }
          return ScriptCompletion.makeCompletionList(items, prefix);
        }
      }
      return this.scriptProperties.processText(textToProcessBefore);
    } else {
      if (checkOnly) {
        return undefined; // Return empty list if only checking
      }
      const element = this.xmlTracker.elementWithPosIn(document, position);
      if (element) {
        logger.debug(`Completion requested in element range: ${element.name}`);
        return this.elementNameCompletion(schema, document, position, undefined, element.name, element.hierarchy);
      }
    }
    if (checkOnly) {
      return undefined; // Return empty list if only checking
    }
    return ScriptCompletion.emptyCompletion;; // Skip if not in an element range
  }

  public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context?: vscode.CompletionContext
  )  {
    return this.prepareCompletion(document, position, false, token, context);
  }
}

// Diagnostic collection for tracking errors
let diagnosticCollection: vscode.DiagnosticCollection;

function validateReferences(document: vscode.TextDocument): vscode.Diagnostic[] {

  const diagnostics: vscode.Diagnostic[] = [];

  diagnostics.push(...labelTracker.validateItems(document));
  diagnostics.push(...actionsTracker.validateItems(document));

  return diagnostics;
}

function trackScriptDocument(document: vscode.TextDocument, update: boolean = false, position?: vscode.Position): void {
  const schema = getDocumentScriptType(document);
  if (schema == '') {
    return; // Skip processing if the document is not valid
  }
  const diagnostics: vscode.Diagnostic[] = [];

  const isXMLParsed = xmlTracker.checkDocumentParsed(document);
  if (isXMLParsed && !update) {
    logger.warn(`Document ${document.uri.toString()} is already parsed.`);
    return; // Skip if the document is already parsed
  }

  const lValueTypes = ['lvalueexpression', ...xsdReference.getSimpleTypesWithBaseType(schema, 'lvalueexpression')];
  const xmlElements: XmlElement[] = xmlTracker.parseDocument(document);
  const offsets = xmlTracker.getOffsets(document);
  for (const offset of offsets) {
    const documentLine = document.lineAt(document.positionAt(offset.index).line - 1);
    const tagStart = documentLine.text.lastIndexOf('<', offset.index);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        documentLine.range.start.translate(0, tagStart),
        documentLine.range.end
      ),
      'Unclosed XML tag',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostics.push(diagnostic);
  }

  // Clear existing data for this document
  variableTracker.clearVariablesForDocument(document);
  labelTracker.clearItemsForDocument(document);
  actionsTracker.clearItemsForDocument(document);

  // Use the XML structure to find labels, actions, and variables more efficiently
  const text = document.getText();

  // Process all elements recursively
  const processElement = (element: XmlElement) => {
    const parentName = element.parent?.name || '';
    const elementDefinition = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
    if (elementDefinition === undefined) {
      const diagnostic = new vscode.Diagnostic(
        element.range,
        `Unknown element '${element.name}' in script type '${schema}'`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = 'unknown-element';
      diagnostic.source = 'X4CodeComplete';
      diagnostics.push(diagnostic);
    } else {
      const schemaAttributes = xsdReference.getElementAttributesWithTypes(schema, element.name, element.hierarchy);
      const attributes = element.attributes
        .map((attr) => attr.name)
        .filter((name) => !(name.startsWith('xmlns:') || name.startsWith('xsi:') || name === 'xmlns'));
      // Use the static method to validate attribute names
      const nameValidation = XsdReference.validateAttributeNames(schemaAttributes, attributes);
      // Handle wrong attributes (attributes not in schema)
      if (nameValidation.wrongAttributes.length > 0) {
        nameValidation.wrongAttributes.forEach((attr) => {
          const diagnostic = new vscode.Diagnostic(
            element.range,
            `Unknown attribute '${attr}' in element '${element.name}'`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'unknown-attribute';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }
      // Process attributes for references and variables
      element.attributes.forEach((attr) => {
        if (nameValidation.missingRequiredAttributes.includes(attr.name)) {
          const diagnostic = new vscode.Diagnostic(
            attr.nameRange,
            `Missing required attribute '${attr.name}' in element '${element.name}'`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'missing-required-attribute';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic); // Skip further processing for this attribute
        } else {
          const attrDefinition = schemaAttributes.find((a) => a.name === attr.name);
          const attributeValue = text.substring(
            document.offsetAt(attr.valueRange.start),
            document.offsetAt(attr.valueRange.end)
          );
          if (!(attr.name.startsWith('xmlns:') || attr.name.startsWith('xsi:') || attr.name === 'xmlns')) {
            const valueValidation = XsdReference.validateAttributeValueAgainstRules(
              schemaAttributes,
              attr.name,
              attributeValue
            );
            if (!valueValidation.isValid) {
              const diagnostic = new vscode.Diagnostic(
                attr.valueRange,
                `Invalid value '${attributeValue}' for attribute '${attr.name}' in element '${element.name}'`,
                vscode.DiagnosticSeverity.Error
              );
              diagnostic.code = 'invalid-attribute-value';
              diagnostic.source = 'X4CodeComplete';
              diagnostics.push(diagnostic);
            }
          }

          // Check for variables inside attribute values
          const attrValue = text.substring(
            document.offsetAt(attr.valueRange.start),
            document.offsetAt(attr.valueRange.end)
          );

          const referencedItemAttributeDetected = checkReferencedItemAttributeType(element.name, attr.name);
          if (referencedItemAttributeDetected) {
            switch (referencedItemAttributeDetected.type) {
              case 'label':
                switch (referencedItemAttributeDetected.attrType) {
                  case 'definition':
                    labelTracker.addItemDefinition(attrValue, document, attr.valueRange);
                    break;
                  case 'reference':
                    labelTracker.addItemReference(attrValue, document, attr.valueRange);
                    break;
                }
                break;
              case 'actions':
                switch (referencedItemAttributeDetected.attrType) {
                  case 'definition':
                    actionsTracker.addItemDefinition(attrValue, document, attr.valueRange);
                    break;
                  case 'reference':
                    actionsTracker.addItemReference(attrValue, document, attr.valueRange);
                    break;
                }
                break;
            }
          }

          if (schema === aiScriptId && element.name === 'param' && attr.name === 'name' && element.hierarchy.length > 0 && element.hierarchy[0] === 'params') {
            variableTracker.addVariable(
              'normal',
              attrValue,
              schema,
              document,
              new vscode.Range(attr.valueRange.start, attr.valueRange.end),
              true, // isDefinition
              0
            );
          }

          const tableIsFound = tableKeyPattern.test(attrValue);
          let match: RegExpExecArray | null;
          const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
          let priority = -1;
          const isLValueAttribute: boolean = lValueTypes.includes(attrDefinition?.type || '');
          if (schema === aiScriptId && isLValueAttribute) {
            if (element.hierarchy.includes('library')) {
              priority = 10;
            } else if (element.hierarchy.includes('init')) {
              priority = 20;
            } else if (element.hierarchy.includes('patch')) {
              priority = 30;
            } else if (element.hierarchy.includes('attention')) {
              priority = 40;
            }
          }
          while ((match = variablePattern.exec(attrValue)) !== null) {
            const variableName = match[1];
            const variableStartOffset = document.offsetAt(attr.valueRange.start) + match.index;
            const variableEndOffset = variableStartOffset + match[0].length;

            const start = document.positionAt(variableStartOffset);
            const end = document.positionAt(variableEndOffset);

            // Simple version of the existing variable type detection
            const variableType = tableIsFound ? 'tableKey' : 'normal';
            const variableRange = new vscode.Range(start, end);
            if (!(position && variableRange.contains(position))) {
              if (end.isEqual(attr.valueRange.end) && priority >= 0) {
                variableTracker.addVariable(
                  variableType,
                  variableName,
                  schema,
                  document,
                  new vscode.Range(start, end),
                  true, // isDefinition
                  priority
                );
              } else {
                variableTracker.addVariable(
                  variableType,
                  variableName,
                  schema,
                  document,
                  new vscode.Range(start, end)
                );
              }
            }
          }
        }
      });
    }
  };

  // Start processing from root elements
  xmlElements.forEach(processElement);

  // Validate references after tracking is complete
  diagnostics.push(...validateReferences(document));

  // Set diagnostics for the document
  diagnosticCollection.set(document.uri, diagnostics);
  logger.info(`Document ${document.uri.toString()} tracked.`);
}


let scriptCompletionProvider : ScriptCompletion;

// load and parse language files
function loadLanguageFiles(basePath: string, extensionsFolder: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('x4CodeComplete');
  const preferredLanguage: string = config.get('languageNumber') || '44';
  const limitLanguage: boolean = config.get('limitLanguageOutput') || false;
  languageData = new Map();
  logger.info('Loading Language Files.');
  return new Promise((resolve, reject) => {
    try {
      const tDirectories: string[] = [];
      let pendingFiles = 0; // Counter to track pending file parsing operations
      let countProcessed = 0; // Counter to track processed files

      // Collect all valid 't' directories
      const rootTPath = path.join(basePath, 't');
      if (fs.existsSync(rootTPath) && fs.statSync(rootTPath).isDirectory()) {
        tDirectories.push(rootTPath);
      }
      // Check 't' directories under languageFilesFolder subdirectories
      if (fs.existsSync(extensionsFolder) && fs.statSync(extensionsFolder).isDirectory()) {
        const subdirectories = fs
          .readdirSync(extensionsFolder, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => item.name);

        for (const subdir of subdirectories) {
          const tPath = path.join(extensionsFolder, subdir, 't');
          if (fs.existsSync(tPath) && fs.statSync(tPath).isDirectory()) {
            tDirectories.push(tPath);
          }
        }
      }

      // Process all found 't' directories
      for (const tDir of tDirectories) {
        const files = fs.readdirSync(tDir).filter((file) => file.startsWith('0001') && file.endsWith('.xml'));

        for (const file of files) {
          const languageId = getLanguageIdFromFileName(file);
          if (limitLanguage && languageId !== preferredLanguage && languageId !== '*' && languageId !== '44') {
            // always show 0001.xml and 0001-0044.xml (any language and english, to assist with creating translations)
            continue;
          }
          const filePath = path.join(tDir, file);
          pendingFiles++; // Increment the counter for each file being processed
          try {
            parseLanguageFile(filePath, () => {
              pendingFiles--; // Decrement the counter when a file is processed
              countProcessed++; // Increment the counter for processed files
              if (pendingFiles === 0) {
                logger.info(`Loaded ${countProcessed} language files from ${tDirectories.length} 't' directories.`);
                resolve(); // Resolve the promise when all files are processed
              }
            });
          } catch (fileError) {
            logger.info(`Error reading ${file} in ${tDir}: ${fileError}`);
            pendingFiles--; // Decrement the counter even if there's an error
            if (pendingFiles === 0) {
              resolve(); // Resolve the promise when all files are processed
            }
          }
        }
      }

      if (pendingFiles === 0) {
        resolve(); // Resolve immediately if no files are found
      }
    } catch (error) {
      logger.info(`Error loading language files: ${error}`);
      reject(error); // Reject the promise if there's an error
    }
  });
}

function getLanguageIdFromFileName(fileName: string): string {
  const match = fileName.match(/0001-[lL]?(\d+).xml/);
  return match && match[1] ? match[1].replace(/^0+/, '') : '*';
}

function parseLanguageFile(filePath: string, onComplete: () => void) {
  const parser = sax.createStream(true); // Create a streaming parser in strict mode
  let currentPageId: string | null = null;
  let currentTextId: string | null = null;
  const fileName: string = path.basename(filePath);
  const languageId: string = getLanguageIdFromFileName(fileName);

  parser.on('opentag', (node) => {
    if (node.name === 'page' && node.attributes.id) {
      currentPageId = node.attributes.id as string;
    } else if (node.name === 't' && currentPageId && node.attributes.id) {
      currentTextId = node.attributes.id as string;
    }
  });

  parser.on('text', (text) => {
    if (currentPageId && currentTextId) {
      const key = `${currentPageId}:${currentTextId}`;
      const textData: Map<string, string> = languageData.get(key) || new Map<string, string>();
      textData.set(languageId, text.trim());
      languageData.set(key, textData);
    }
  });

  parser.on('closetag', (nodeName) => {
    if (nodeName === 't') {
      currentTextId = null; // Reset text ID after closing the tag
    } else if (nodeName === 'page') {
      currentPageId = null; // Reset page ID after closing the tag
    }
  });

  parser.on('end', () => {
    onComplete(); // Notify that this file has been fully processed
  });

  parser.on('error', (err) => {
    logger.info(`Error parsing standard language file ${filePath}: ${err.message}`);
    onComplete(); // Notify even if there's an error
  });

  fs.createReadStream(filePath).pipe(parser);
}

function findLanguageText(pageId: string, textId: string): string {
  const config = vscode.workspace.getConfiguration('x4CodeComplete');
  let preferredLanguage: string = config.get('languageNumber') || '44';
  const limitLanguage: boolean = config.get('limitLanguageOutput') || false;

  const textData: Map<string, string> = languageData.get(`${pageId}:${textId}`);
  let result: string = '';
  if (textData) {
    const textDataKeys = Array.from(textData.keys()).sort((a, b) =>
      a === preferredLanguage
        ? -1
        : b === preferredLanguage
          ? 1
          : (a === '*' ? 0 : parseInt(a)) - (b === '*' ? 0 : parseInt(b))
    );
    if (limitLanguage && !textData.has(preferredLanguage)) {
      if (textData.has('*')) {
        preferredLanguage = '*';
      } else if (textData.has('44')) {
        preferredLanguage = '44';
      }
    }
    for (const language of textDataKeys) {
      if (!limitLanguage || language == preferredLanguage) {
        result += (result == '' ? '' : `\n\n`) + `${language}: ${textData.get(language)}`;
      }
    }
  }
  return result;
}


export function activate(context: vscode.ExtensionContext) {
  let config = vscode.workspace.getConfiguration('x4CodeComplete');
  if (!config || !validateSettings(config)) {
    return;
  }
  extensionsFolder = config.get('extensionsFolder') || '';
  if (config.get('debug') || false) {
    isDebugEnabled = true;
    setLoggerLevel('debug'); // Set logger level to debug for detailed output
  } else {
    setLoggerLevel('info'); // Set logger level to info for normal operation
  }
  logger.debug('X4CodeComplete activation started.');

  rootpath = config.get('unpackedFileLocation') || '';
  forcedCompletion = config.get('forcedCompletion') || false;

  // Create diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('x4CodeComplete');
  context.subscriptions.push(diagnosticCollection);
 // Load language files and wait for completion
  loadLanguageFiles(rootpath, extensionsFolder)
    .then(() => {
      logger.info('Language files loaded successfully.');
      // Proceed with the rest of the activation logic
    })
    .catch((error) => {
      logger.error('Error loading language files:', error);
      vscode.window.showErrorMessage('Error loading language files: ' + error);
    });
  // Load script properties
  scriptProperties = new ScriptProperties( path.join(rootpath, '/libraries'));
  xsdReference = new XsdReference(path.join(rootpath, 'libraries'));
  scriptCompletionProvider= new ScriptCompletion(xsdReference, xmlTracker, scriptProperties, labelTracker, actionsTracker, variableTracker)

  const sel: vscode.DocumentSelector = { language: 'xml' };

  const disposableCompleteProvider = vscode.languages.registerCompletionItemProvider(
    sel,
    // completionProvider,
    scriptCompletionProvider,
    '.',
    '"',
    '{',
    ' ',
    '<'
  );
  context.subscriptions.push(disposableCompleteProvider);

  // const disposableDefinitionProvider = vscode.languages.registerDefinitionProvider(sel, scriptProperties.definitionProvider);
  // context.subscriptions.push(disposableDefinitionProvider);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(sel, {
      provideDefinition:  async (document: vscode.TextDocument, position: vscode.Position) : Promise<vscode.Definition | undefined> => {
        const scheme = getDocumentScriptType(document);
        if (scheme === '') {
          return undefined;
        }

        // Check if we're on a variable
        const variableDefinition = variableTracker.getVariableDefinition(document, position);
        if (variableDefinition) {
          logger.debug(`Variable definition found at position: ${position.line + 1}:${position.character} for variable: ${variableDefinition.name}`);
          return variableDefinition.definition;
        }

        if (scheme == aiScriptId) {
          // Check if we're on an action (only in AI scripts)
          const actionsDefinition = actionsTracker.getItemDefinition(document, position);
          if (actionsDefinition) {
            logger.debug(`Definition found for action: ${actionsDefinition.name}`);
            return actionsDefinition.definition;
          }

          // Check if we're on a label
          const labelDefinition = labelTracker.getItemDefinition(document, position);
          if (labelDefinition) {
            logger.debug(`Definition found for label: ${labelDefinition.name}`);
            return labelDefinition.definition;
          }
        }
        // Default handling for other definitions
        return scriptProperties.provideDefinition(document, position);
      }
    })
  );

  // Hover provider to display tooltips
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, {
      provideHover: async (
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.Hover | undefined> => {
        const schema = getDocumentScriptType(document);
        if (schema == '') {
          return undefined; // Skip if the document is not valid
        }

        const tPattern =
          /\{\s*(\d+)\s*,\s*(\d+)\s*\}|readtext\.\{\s*(\d+)\s*\}\.\{\s*(\d+)\s*\}|page="(\d+)"\s+line="(\d+)"/g;
        // matches:
        // {1015,7} or {1015, 7}
        // readtext.{1015}.{7}
        // page="1015" line="7"

        const range = document.getWordRangeAtPosition(position, tPattern);
        if (range) {
          const text = document.getText(range);
          const matches = tPattern.exec(text);
          tPattern.lastIndex = 0; // Reset regex state

          if (matches && matches.length >= 3) {
            let pageId: string | undefined;
            let textId: string | undefined;
            if (matches[1] && matches[2]) {
              // {1015,7} or {1015, 7}
              pageId = matches[1];
              textId = matches[2];
            } else if (matches[3] && matches[4]) {
              // readtext.{1015}.{7}
              pageId = matches[3];
              textId = matches[4];
            } else if (matches[5] && matches[6]) {
              // page="1015" line="7"
              pageId = matches[5];
              textId = matches[6];
            }

            if (pageId && textId) {
              logger.debug(`Matched pattern: ${text}, pageId: ${pageId}, textId: ${textId}`);
              const languageText = findLanguageText(pageId, textId);
              if (languageText) {
                const hoverText = new vscode.MarkdownString();
                hoverText.appendMarkdown('```plaintext\n');
                hoverText.appendMarkdown(languageText);
                hoverText.appendMarkdown('\n```');
                return new vscode.Hover(hoverText, range);
              }
            }
            return undefined;
          }
        }

        const element = xmlTracker.elementWithPosInStartTag(document, position);
        if (element) {
          const attribute = xmlTracker.attributeWithPosInName(document, position);
          if (attribute) {
              const hoverText = new vscode.MarkdownString();
              const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(schema, attribute.element.name, attribute.element.hierarchy);
              const attributeInfo = elementAttributes.find((attr) => attr.name === attribute.name);
              if (attributeInfo) {
                hoverText.appendMarkdown(`**${attribute.name}**: ${attributeInfo.annotation ? '\`' + attributeInfo.annotation + '\`' : ''}\n\n`);
                hoverText.appendMarkdown(`**Type**: \`${attributeInfo.type}\`\n\n`);
                hoverText.appendMarkdown(`**Required**: \`${attributeInfo.required ? 'Yes' : 'No'}\`\n\n`);
              } else {
                hoverText.appendMarkdown(`**${attribute.name}**: \`Wrong attribute!\`\n\n`);
              }
              return new vscode.Hover(hoverText, attribute.nameRange);
          } else if (xmlTracker.elementWithPosInName(document, position)) {
            const elementInfo = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
            const hoverText = new vscode.MarkdownString();
            if (elementInfo) {
              const annotationText = XsdReference.extractAnnotationText(elementInfo);
              hoverText.appendMarkdown(`**${element.name}**: ${annotationText ? '\`' + annotationText + '\`' : ''}\n\n`);
            } else {
              hoverText.appendMarkdown(`**${element.name}**: \`Wrong element!\`\n\n`);
            }
            return new vscode.Hover(hoverText, element.nameRange);
          }
        }

        if (schema == aiScriptId) {
          // Check for actions (only in AI scripts)
          const actionsHover = actionsTracker.getItemHover(document, position);
          if (actionsHover) {
            return actionsHover;
          }
          // Check for labels
          const labelHover = labelTracker.getItemHover(document, position);
          if (labelHover) {
            return labelHover;
          }
        }

        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);

        if (variableAtPosition) {
          logger.debug(`Hovering over variable: ${variableAtPosition.variable.name}`);
          // Generate hover text for the variable
          const hoverText = VariableTracker.getVariableDetails(variableAtPosition.variable);
          return new vscode.Hover(hoverText, variableAtPosition.location.range); // Updated to use variableAtPosition[0].range
        }

        return scriptProperties.provideHover(document, position);
      },
    })
  );

  // Update the definition provider to support actions
  // scriptProperties.definitionProvider.provideDefinition =

  logger.info('XSD schemas loaded successfully.'); // Instead of parsing all open documents, just parse the active one
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document;
    if (scriptsMetadataSet(document)) {
      trackScriptDocument(document);
    }
  }

  // Listen for editor changes to parse documents as they become active
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && scriptsMetadataSet(editor.document)) {
        trackScriptDocument(editor.document);
      }
    })
  );

  // Keep the onDidOpenTextDocument handler for newly opened documents
  vscode.workspace.onDidOpenTextDocument((document) => {
    if (scriptsMetadataSet(document)) {
      // Only parse if this is the active document
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()) {
        trackScriptDocument(document);
      }
    }
  });

  // Update XML structure when documents change
  vscode.workspace.onDidChangeTextDocument((event) => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || event.document !== activeEditor.document) return;
    if (scriptsMetadataSet(event.document, true)) {
      if (event.contentChanges.length > 0) {
        const cursorPos = activeEditor.selection.active;

        trackScriptDocument(event.document, true, cursorPos); // Update the document structure on change
        // Check if we're in a specialized completion context
        // Move the position one character forward if possible
        if (forcedCompletion && scriptCompletionProvider.prepareCompletion(event.document, cursorPos, true) !== undefined) {
          // If the completion provider is ready, trigger suggestions
          logger.info(`Triggering suggestions for document: ${event.document.uri.toString()}`);
          vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
      }
    }
  });

  vscode.workspace.onDidSaveTextDocument((document) => {
    if (scriptsMetadataSet(document, true)) {
      trackScriptDocument(document, true); // Update the document structure on save
    }
  });

  // Clear the cached languageSubId and diagnosticCollection when a document is closed
  vscode.workspace.onDidCloseTextDocument((document) => {
    diagnosticCollection.delete(document.uri);
    logger.debug(`Removed cached data for document: ${document.uri.toString()}`);
  });

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('x4CodeComplete')) {
        logger.info('Configuration changed. Reloading settings...');
        config = vscode.workspace.getConfiguration('x4CodeComplete');

        // Update settings
        rootpath = config.get('unpackedFileLocation') || '';
        forcedCompletion = config.get('forcedCompletion') || false;
        extensionsFolder = config.get('extensionsFolder') || '';
        const debugValue = config.get('debug') || false ? true : false;
        if (debugValue !== isDebugEnabled) {
          isDebugEnabled = debugValue;
          if (isDebugEnabled) {
            setLoggerLevel('debug'); // Set logger level to debug for detailed output
          } else {
            setLoggerLevel('info'); // Set logger level to info for normal operation
          }
        }

        // Reload language files if paths have changed or reloadLanguageData is toggled
        if (
          event.affectsConfiguration('x4CodeComplete.unpackedFileLocation') ||
          event.affectsConfiguration('x4CodeComplete.extensionsFolder') ||
          event.affectsConfiguration('x4CodeComplete.languageNumber') ||
          event.affectsConfiguration('x4CodeComplete.limitLanguageOutput') ||
          event.affectsConfiguration('x4CodeComplete.reloadLanguageData')
        ) {
          logger.info('Reloading language files due to configuration changes...');
          loadLanguageFiles(rootpath, extensionsFolder)
            .then(() => {
              logger.info('Language files reloaded successfully.');
            })
            .catch((error) => {
              logger.info('Failed to reload language files:', error);
            });

          // Reset the reloadLanguageData flag to false after reloading
          if (event.affectsConfiguration('x4CodeComplete.reloadLanguageData')) {
            vscode.workspace
              .getConfiguration()
              .update('x4CodeComplete.reloadLanguageData', false, vscode.ConfigurationTarget.Global);
          }
        }
      }
    })
  );

  // Add code action provider for quick fixes
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(sel, {
      provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
      ): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === 'X4CodeComplete') {
            if (diagnostic.code === 'undefined-label') {
              // Quick fix to create label definition
              const labelName = diagnostic.message.match(/'(.+)'/)?.[1];
              if (labelName) {
                const similarLabels = labelTracker.getSimilarItems(document, labelName);
                similarLabels.forEach((similarLabel) => {
                  const replaceAction = new vscode.CodeAction(
                    `Replace with existing label '${similarLabel}'`,
                    vscode.CodeActionKind.QuickFix
                  );
                  replaceAction.edit = new vscode.WorkspaceEdit();
                  replaceAction.edit.replace(document.uri, diagnostic.range, similarLabel);
                  replaceAction.diagnostics = [diagnostic];
                  replaceAction.isPreferred = similarLabels.indexOf(similarLabel) === 0; // Mark most similar as preferred
                  actions.push(replaceAction);
                });
              }
            } else if (diagnostic.code === 'undefined-action') {
              // Quick fix to create action definition
              const actionName = diagnostic.message.match(/'(.+)'/)?.[1];
              if (actionName) {
                // Action to create new action
                const createAction = new vscode.CodeAction(
                  `Create action '${actionName}'`,
                  vscode.CodeActionKind.QuickFix
                );
                createAction.edit = new vscode.WorkspaceEdit();

                // Find library section or create one
                const text = document.getText();
                const libraryMatch = text.match(/<library>/);
                let insertPosition: vscode.Position;
                let insertText: string;

                if (libraryMatch) {
                  // Insert into existing library
                  const libraryStartIndex = text.indexOf('<library>') + '<library>'.length;
                  insertPosition = document.positionAt(libraryStartIndex);
                  insertText = `\n  <actions name="${actionName}">\n    <!-- TODO: Implement action -->\n  </actions>`;
                } else {
                  // Create new library section
                  const aiscriptMatch = text.match(/<aiscript[^>]*>/);
                  if (aiscriptMatch) {
                    const aiscriptEndIndex = text.indexOf('>', text.indexOf(aiscriptMatch[0])) + 1;
                    insertPosition = document.positionAt(aiscriptEndIndex);
                    insertText = `\n  <library>\n    <actions name="${actionName}">\n      <!-- TODO: Implement action -->\n    </actions>\n  </library>`;
                  } else {
                    insertPosition = new vscode.Position(1, 0);
                    insertText = `<library>\n  <actions name="${actionName}">\n    <!-- TODO: Implement action -->\n  </actions>\n</library>\n`;
                  }
                }

                createAction.edit.insert(document.uri, insertPosition, insertText);
                createAction.diagnostics = [diagnostic];
                actions.push(createAction);

                const similarActions = actionsTracker.getSimilarItems(document, actionName);

                similarActions.forEach((similarAction) => {
                  const replaceAction = new vscode.CodeAction(
                    `Replace with existing action '${similarAction}'`,
                    vscode.CodeActionKind.QuickFix
                  );
                  replaceAction.edit = new vscode.WorkspaceEdit();
                  replaceAction.edit.replace(document.uri, diagnostic.range, similarAction);
                  replaceAction.diagnostics = [diagnostic];
                  replaceAction.isPreferred = similarActions.indexOf(similarAction) === 0; // Mark most similar as preferred
                  actions.push(replaceAction);
                });
              }
            }
          }
        }

        return actions;
      },
    } as vscode.CodeActionProvider)
  );

  // Add reference provider for actions in AIScript
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(sel, {
      provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext) {
        const scheme = getDocumentScriptType(document);
        if (scheme == '') {
          return undefined;
        }

        // Check if we're on a variable
        const variableReferences = variableTracker.getVariableLocations(document, position);
        if (variableReferences) {
          logger.debug(`References found for variable: ${variableReferences.name}`);
          return variableReferences.references;
        }
        if (scheme == aiScriptId) {
          // Check if we're on an action
          const actionsReferences = actionsTracker.getItemReferences(document, position);
          if (actionsReferences) {
            logger.debug(`References found for action: ${actionsReferences.name}`);
            return actionsReferences.references;
          }

          // Check if we're on a label
          const labelReferences = labelTracker.getItemReferences(document, position);
          if (labelReferences) {
            logger.debug(`References found for label: ${labelReferences.name}`);
            return labelReferences.references;
          }
        }
        return [];
      },
    })
  );

  context.subscriptions.push(
    vscode.languages.registerRenameProvider(sel, {
      provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string) {
        const scheme = getDocumentScriptType(document);
        if (scheme == '') {
          return undefined; // Skip if the document is not valid
        }
        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
        if (variableAtPosition) {
          const variableName = variableAtPosition.variable.name;
          const variableType = variableAtPosition.variable.type;
          const locations = variableAtPosition.variable.locations;
          if (variableAtPosition.variable.definition) {
            // If the variable has a definition, use its range for the rename
            locations.unshift(variableAtPosition.variable.definition);
          }

          // Debug log: Print old name, new name, and locations
          logger.debug(`Renaming variable: ${variableName} -> ${newName}`); // Updated to use variableAtPosition[0]
          logger.debug(`Variable type: ${variableType}`);
          logger.debug(`Locations to update:`, locations);
          const workspaceEdit = new vscode.WorkspaceEdit();
          locations.forEach((location) => {
            // Debug log: Print each edit
            const rangeText = location.range ? document.getText(location.range) : '';
            const replacementText = rangeText.startsWith('$') ? `$${newName}` : newName;
            logger.debug(
              `Editing file: ${location.uri.fsPath}, Range: ${location.range}, Old Text: ${rangeText}, New Text: ${replacementText}`
            );
            workspaceEdit.replace(location.uri, location.range, replacementText);
          });

          // Update the tracker with the new name
          variableTracker.updateVariableName(variableType, variableName, newName, document);

          return workspaceEdit;
        }

        // Debug log: No variable name found
        logger.debug(`No variable name found at position: ${position}`);
        return undefined;
      },
    })
  );
}

// this method is called when your extension is deactivated
export function deactivate() {
  logger.info('Extension deactivation started...');

  try {

    // Clear all diagnostic collections
    if (diagnosticCollection) {
      diagnosticCollection.clear();
      diagnosticCollection.dispose();
    }

    // Clear all tracking data
    if (variableTracker) {
      // Clear all document-specific data
      // Note: WeakMap will be garbage collected automatically, but we can clear specific documents if needed
      variableTracker.dispose();
    }

    if (labelTracker) {
      // Clear all document-specific data
      // Note: WeakMap will be garbage collected automatically
      labelTracker.dispose();
    }

    if (actionsTracker) {
      // Clear all document-specific data
      // Note: WeakMap will be garbage collected automatically
      actionsTracker.dispose();
    }

    // Clear XML tracker data
    if (xmlTracker) {
      xmlTracker.dispose();
    }

    // Clear completion provider data
    if (scriptProperties) {
      scriptProperties.dispose();
    }

    // Clear script completion provider
    if (scriptCompletionProvider) {
      // Script completion provider will be garbage collected
    }

    // Clear language data
    if (languageData) {
      languageData.clear();
    }

    // Clear scripts metadata
    if (scriptsMetadata) {
      // Note: WeakMap will be garbage collected automatically
      scriptsMetadataClearAll();
    }

    // Clear XSD reference data
    if (xsdReference) {
      // XSD reference internal caches will be garbage collected
      xsdReference.dispose();
    }

    // Reset global flags
    isDebugEnabled = false;
    forcedCompletion = false;

    logger.info('Extension deactivated successfully');
  } catch (error) {
    logger.error('Error during extension deactivation:', error);
  }
}
