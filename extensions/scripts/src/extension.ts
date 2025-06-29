// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import * as path from 'path';
import * as sax from 'sax';
import { xmlTracker, ElementRange, XmlStructureTracker } from './xmlStructureTracker';
import { logger, setLoggerLevel } from './logger';
import { XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from 'xsd-lookup';
import { get } from 'http';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
let isDebugEnabled = false;
let rootpath: string;
let scriptPropertiesPath: string;
let extensionsFolder: string;
let languageData: Map<string, Map<string, string>> = new Map();
let xsdReference: XsdReference;

type ScriptMetadata = {
  scheme: string;
}

type ScriptsMetadata = WeakMap<vscode.TextDocument, ScriptMetadata>;

const scriptsMetadata: ScriptsMetadata = new WeakMap();

function scriptMetadataInit(document: vscode.TextDocument, reInit: boolean = false): ScriptMetadata | undefined {
  if (document.languageId === 'xml') {
    scriptsMetadata.delete(document); // Clear metadata if re-initializing
    const scheme = getDocumentScriptType(document);
    if (scheme) {
      return scriptsMetadata.get(document);
    }
  }
  return undefined;
}

// Extract variable completion logic into a function
function getVariableCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  if (getDocumentScriptType(document) === '') {
    return []; // Skip if the document is not valid
  }

  // Get the current line up to the cursor position
  const linePrefix = document.lineAt(position).text.substring(0, position.character);

  // First scenario: $ was just typed
  if (linePrefix.endsWith('$')) {
    return variableTracker.getAllVariablesForDocument(document);
  }

  // Second scenario: We're editing an existing variable
  // Find the last $ character before the cursor
  const lastDollarIndex = linePrefix.lastIndexOf('$');
  if (lastDollarIndex >= 0) {
    // Check if we're within a variable (no whitespace or special chars between $ and cursor)
    const textBetweenDollarAndCursor = linePrefix.substring(lastDollarIndex + 1);

    // If this text is a valid variable name part
    if (/^[a-zA-Z0-9_]*$/.test(textBetweenDollarAndCursor)) {
      // Get the partial variable name we're typing (without the $)
      const partialName = textBetweenDollarAndCursor;
      // Get all variables and filter them by the current prefix
      const allVariables = variableTracker.getAllVariablesForDocument(document, partialName);
      // Filter variables that match the partial name
      return allVariables.filter((item) => item.label.toString().toLowerCase().startsWith(partialName.toLowerCase()));
    }
  }

  return []; // No completions if not in a variable context
}

// Extract label completion logic into a function
function getLabelCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  const scheme = getDocumentScriptType(document);
  if (scheme !== aiScriptId) {
    return [];
  }

  // Check if we're inside an attribute that might use labels
  const lineText = document.lineAt(position).text;
  const textBefore = lineText.substring(0, position.character);

  // First check for element+attribute combinations using regex patterns
  for (const [element, attributes] of Object.entries(labelElementAttributeMap)) {
    for (const attr of attributes) {
      // Pattern to match <element attr="partial_text| or <element attr='partial_text|
      const elementAttrPattern = new RegExp(`<${element}[^>]*\\s+${attr}=["']([^"']*)$`);
      const match = elementAttrPattern.exec(textBefore);
      if (match) {
        const partialText = match[1];
        const allLabels = labelTracker.getAllLabelsForDocument(document);

        // If there's partial text, filter labels that start with it
        if (partialText) {
          let filtered = allLabels.filter(
            (item) =>
              item.label.toString().toLowerCase().startsWith(partialText.toLowerCase()) &&
              item.label.toString() !== partialText
          );
          if (filtered.length === 0 && partialText.length > 0) {
            // Fallback: match all items where label contains all partialText chars in order (not necessarily consecutive)
            const pattern = partialText
              .split('')
              .map((c) => escapeRegex(c))
              .join('.*?');
            const regex = new RegExp(pattern, 'i');
            filtered = allLabels.filter((item) => regex.test(item.label.toString()));
          }
          return filtered;
        }

        // Return all labels if no partial text
        return allLabels;
      }
    }
  }

  return [];
}

// Extract action completion logic into a function
function getActionCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  const scheme = getDocumentScriptType(document);
  if (scheme !== aiScriptId) {
    return [];
  }

  // Check if we're inside an attribute that might use actions
  const lineText = document.lineAt(position).text;
  const textBefore = lineText.substring(0, position.character);

  // Check for being inside an action-using attribute value
  for (const [element, attributes] of Object.entries(actionElementAttributeMap)) {
    for (const attr of attributes) {
      // Pattern to match <element attr="partial_text| or <element attr='partial_text|
      const elementAttrPattern = new RegExp(`<${element}[^>]*\\s+${attr}=["']([^"']*)$`);
      const match = elementAttrPattern.exec(textBefore);
      if (match) {
        const partialText = match[1];
        const allActions = actionTracker.getAllActionsForDocument(document);

        // If there's partial text, filter actions that start with it
        if (partialText) {
          let filtered = allActions.filter(
            (item) =>
              item.label.toString().toLowerCase().startsWith(partialText.toLowerCase()) &&
              item.label.toString() !== partialText
          );
          if (filtered.length === 0 && partialText.length > 0) {
            // Fallback: match all items where actions contains all partialText chars in order (not necessarily consecutive)
            const pattern = partialText
              .split('')
              .map((c) => escapeRegex(c))
              .join('.*?');
            const regex = new RegExp(pattern, 'i');
            filtered = allActions.filter((item) => regex.test(item.label.toString()));
          }
          return filtered;
        }

        // Return all actions if no partial text
        return allActions;
      }
    }
  }

  return [];
}

// Function to check if we're in a specialized completion context
function specializedCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.CompletionItem[] {
  const attributeRange = xmlTracker.isInAttributeValue(document, position);
  if (attributeRange) {
    const elementName = attributeRange.elementName;
    const attributeName = attributeRange.name;
    // Check if any of the specialized completion functions return results
    const variableCompletions = getVariableCompletions(document, position);
    if (variableCompletions.length > 0) {
      return variableCompletions;
    }

    const labelCompletions = getLabelCompletions(document, position);
    if (labelCompletions.length > 0) {
      return labelCompletions;
    }

    const actionCompletions = getActionCompletions(document, position);
    if (actionCompletions.length > 0) {
      return actionCompletions;
    }
  }
  return [];
}

// Flag to indicate if specialized completion is active
// let isSpecializedCompletion: boolean = false;

// Map to store languageSubId for each document
const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]+)/g;
const tableKeyPattern = /table\[/;
const variableTypes = {
  normal: 'usual variable',
  tableKey: 'remote or table variable',
};
const aiScriptId = 'aiscripts';
const mdScriptId = 'md';
const scriptNodes = {
  'aiscript': {
    id: aiScriptId,
    info: 'AI Scripts',
  },
  'mdscript': {
    id: mdScriptId,
    info: 'Mission Director Scripts',
  }
};
const scriptNodesNames = Object.keys(scriptNodes);
const scriptTypesToSchema = {
  [aiScriptId]: 'aiscripts',
  [mdScriptId]: 'md',
};

// Map of elements and their attributes that can contain label references
const labelElementAttributeMap: { [element: string]: string[] } = {
  resume: ['label'],
  run_interrupt_script: ['resume'],
  abort_called_scripts: ['resume'],
};

// Map of elements and their attributes that can contain action references
const actionElementAttributeMap: { [element: string]: string[] } = {
  include_interrupt_actions: ['ref'],
};

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

function getLastSubstring(text: string, chars: string): string {
  const charsSorted = chars.split('').sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a));
  if (charsSorted.length > 0 && charsSorted[charsSorted.length - 1] !== undefined) {
    const lastChar = charsSorted[charsSorted.length - 1];
    const lastIndex = text.lastIndexOf(lastChar);
    if (lastIndex !== -1) {
      return text.substring(lastIndex + 1).trim();
    }
  }
  return '';
}

function findRelevantPortion(text: string) {
  const bracketPos = text.lastIndexOf('{');
  text = text.substring(bracketPos + 1).trim();
  const quotePos = text.lastIndexOf(`'`);
  text = text.substring(quotePos + 1).trim();
  const pos = text.lastIndexOf('.');
  if (pos === -1) {
    return null;
  }
  const newToken = text.substring(pos + 1).trim();
  const prevPos = Math.max(text.lastIndexOf('.', pos - 1), text.lastIndexOf(' ', pos - 1));
  const prevToken = text.substring(prevPos + 1, pos).trim();
  return [
    prevToken.indexOf('@') === 0 ? prevToken.slice(1) : prevToken,
    newToken.indexOf('@') === 0 ? newToken.slice(1) : newToken,
  ];
}

type CompletionsMap = Map<string, vscode.CompletionItem>;

class TypeEntry {
  properties: Map<string, string> = new Map<string, string>();
  supertype?: string;
  literals: Set<string> = new Set<string>();
  details: Map<string, string> = new Map<string, string>();
  addProperty(value: string, type: string = '') {
    this.properties.set(value, type);
  }
  addLiteral(value: string) {
    this.literals.add(value);
  }
  addDetail(key: string, value: string) {
    this.details.set(key, value);
  }
}

class CompletionDict implements vscode.CompletionItemProvider {
  typeDict: Map<string, TypeEntry> = new Map<string, TypeEntry>();
  allProp: Map<string, string> = new Map<string, string>();
  allPropItems: vscode.CompletionItem[] = [];
  keywordItems: vscode.CompletionItem[] = [];
  defaultCompletions: vscode.CompletionList;
  descriptions: Map<string, string> = new Map<string, string>();

  addType(key: string, supertype?: string): void {
    const k = cleanStr(key);
    let entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    if (supertype !== 'datatype') {
      entry.supertype = supertype;
    }
  }

  addTypeLiteral(key: string, val: string): void {
    const k = cleanStr(key);
    let v = cleanStr(val);
    if (v.indexOf(k) === 0) {
      v = v.slice(k.length + 1);
    }
    let entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    entry.addLiteral(v);
    if (this.allProp.has(v)) {
      // If the commonDict already has this property, we can skip adding it again
      return;
    } else {
      this.allProp.set(v, 'undefined');
    }
  }

  addProperty(key: string, prop: string, type?: string, details?: string): void {
    const k = cleanStr(key);
    let entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    entry.addProperty(prop, type);
    if (details !== undefined) {
      entry.addDetail(prop, details);
    }
    const shortProp = prop.split('.')[0];
    if (this.allProp.has(shortProp)) {
      // If the commonDict already has this property, we can skip adding it again
      return;
    } else if (type !== undefined) {
      this.allProp.set(shortProp, type);
      const item = new vscode.CompletionItem(shortProp);
      this.allPropItems.push(item);
    }
  }

  addDescription(name: string, description: string): void {
    if (description === undefined || description === '') {
      return; // Skip empty descriptions
    }
    if (!this.descriptions.has(cleanStr(name))) {
      this.descriptions.set(cleanStr(name), description);
    }
  }

  addElement(items: Map<string, vscode.CompletionItem>, complete: string, info?: string, range?: vscode.Range): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(complete) > -1) {
      return;
    }

    if (items.has(complete)) {
      logger.debug('\t\tSkipped existing completion: ', complete);
      return;
    }

    const item = new vscode.CompletionItem(complete, vscode.CompletionItemKind.Operator);
    item.documentation = info ? new vscode.MarkdownString(info) : undefined;
    item.range = range;

    logger.debug('\t\tAdded completion: ' + complete + ' info: ' + item.detail);
    items.set(complete, item);
  }

  public static addItem(items: Map<string, vscode.CompletionItem>, complete: string, info?: string): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(complete) > -1) {
      return;
    }

    if (items.has(complete)) {
      logger.debug('\t\tSkipped existing completion: ', complete);
      return;
    }

    const item = new vscode.CompletionItem(complete, vscode.CompletionItemKind.Property);
    item.documentation = info ? new vscode.MarkdownString(info) : undefined;

    logger.debug('\t\tAdded completion: ' + complete + ' info: ' + item.detail);
    items.set(complete, item);
  }

  buildType(prefix: string, typeName: string, items: Map<string, vscode.CompletionItem>, depth: number): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype', 'undefined'].indexOf(typeName) > -1) {
      return;
    }
    logger.debug('Building Type: ', typeName, 'depth: ', depth, 'prefix: ', prefix);
    const entry = this.typeDict.get(typeName);
    if (entry === undefined) {
      return;
    }
    if (depth > 1) {
      logger.debug('\t\tMax depth reached, returning');
      return;
    }

    if (items.size > 1000) {
      logger.debug('\t\tMax count reached, returning');
      return;
    }

    for (const prop of entry.properties.entries()) {
      CompletionDict.addItem(items, prop[0], '**' + [typeName, prop[0]].join('.') + '**: ' + entry.details.get(prop[0]));
    }
    for (const literal of entry.literals.values()) {
      CompletionDict.addItem(items, literal);
    }
    if (entry.supertype !== undefined) {
      logger.debug('Recursing on supertype: ', entry.supertype);
      this.buildType(typeName, entry.supertype, items, depth /*  + 1 */);
    }
  }
  makeCompletionList(items: Map<string, vscode.CompletionItem>): vscode.CompletionList {
    return new vscode.CompletionList(Array.from(items.values()), true);
  }

  makeKeywords(): void {
    this.keywordItems = Array.from(this.typeDict.keys()).map((key) => {
      const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Keyword);
      if (this.descriptions.has(key)) {
        item.documentation = new vscode.MarkdownString(this.descriptions.get(key));
      }
      this.keywordItems.push(item);
      return item;
    });
  }

  processText(textToProcess: string): vscode.CompletionItem[] | vscode.CompletionList | undefined {
    const items = new Map<string, vscode.CompletionItem>();
    const interesting = findRelevantPortion(textToProcess);
    if (interesting === null) {
      logger.debug('no relevant portion detected');
      return this.keywordItems;
    }
    let prevToken = interesting[0];
    const newToken = interesting[1];
    logger.debug('Previous token: ', interesting[0], ' New token: ', interesting[1]);
    // If we have a previous token & it's in the typeDictionary or a property with type, only use that's entries
    if (prevToken !== '') {
      prevToken = this.typeDict.has(prevToken)
        ? prevToken
        : this.allProp.has(prevToken)
          ? this.allProp.get(prevToken) || ''
          : '';
      if (prevToken === undefined || prevToken === '') {
        logger.debug('Missing previous token!');
        return newToken.length > 0
          ? new vscode.CompletionList(
              this.defaultCompletions.items.filter((item) => {
                const label = typeof item.label === 'string' ? item.label : item.label.label;
                return label.startsWith(newToken);
              }),
              true
            )
          : this.defaultCompletions;
      } else {
        logger.debug(`Matching on type: ${prevToken}!`);
        this.buildType('', prevToken, items, 0);
        return this.makeCompletionList(items);
      }
    }
    // Ignore tokens where all we have is a short string and no previous data to go off of
    if (prevToken === '' && newToken === '') {
      logger.debug('Ignoring short token without context!');
      return undefined;
    }
    // Now check for the special hard to complete ones
    // if (prevToken.startsWith('{')) {
    //   if (exceedinglyVerbose) {
    //     logger.info('Matching bracketed type');
    //   }
    //   const token = prevToken.substring(1);

    //   const entry = this.typeDict.get(token);
    //   if (entry === undefined) {
    //     if (exceedinglyVerbose) {
    //       logger.info('Failed to match bracketed type');
    //     }
    //   } else {
    //     entry.literals.forEach((value) => {
    //       this.addItem(items, value + '}');
    //     });
    //   }
    // }

    logger.debug('Trying fallback');
    // Otherwise fall back to looking at keys of the typeDictionary for the new string
    for (const key of this.typeDict.keys()) {
      if (!key.startsWith(newToken)) {
        continue;
      }
      this.buildType('', key, items, 0);
    }
    return this.makeCompletionList(items);
  }

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
    const schema = getDocumentScriptType(document);
    if (schema == '') {
      return undefined; // Skip if the document is not valid
    }

    const items = new Map<string, vscode.CompletionItem>();
    const currentLine = position.line;

    const elementNameCompletion = (parentName: string, parentHierarchy: string[], range?: vscode.Range) => {
      const possibleElements = xsdReference.getPossibleChildElements(schema, parentName, parentHierarchy);
      if (possibleElements !== undefined) {
        logger.debug(`Possible elements for ${parentName}:`, possibleElements);
        const currentLinePrefix =  document.lineAt(position).text.substring(0, position.character);
        const startTagIndex = currentLinePrefix.lastIndexOf('<');
        if (startTagIndex === -1) {
          logger.debug('No start tag found in current line prefix:', currentLinePrefix);
          return undefined; // Skip if no start tag found
        }
        const startTagInsidePrefix = currentLinePrefix.slice(currentLinePrefix.lastIndexOf('<') + 1);
        if (startTagInsidePrefix.includes(' ')) {
          logger.debug('Start tag inside prefix contains space, skipping:', startTagInsidePrefix);
          return undefined; // Skip if the start tag inside prefix contains a space
        }
        for (const [value, info] of possibleElements.entries()) {
          if (!startTagInsidePrefix || value.startsWith(startTagInsidePrefix)) {
            this.addElement(items, `${value}`, info, range);
          }
        }
        return this.makeCompletionList(items);
        // return new vscode.CompletionList(Array.from(items.values()), false);
      } else {
        logger.debug('No possible elements found for:', parentName);
      }
    }

    const inElementStartTag = xmlTracker.elementStartTagInPosition(document, position);
    if (inElementStartTag) {
      logger.debug(`Completion requested in element: ${inElementStartTag.name}`);

      const elementByName = xmlTracker.elementNameInPosition(document, position);
      if (elementByName) {
        const parent: ElementRange = xmlTracker.getParentElement(document, elementByName);
        return elementNameCompletion(parent.name, parent.hierarchy, inElementStartTag.nameRange);
      }

      const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(
        schema,
        inElementStartTag.name,
        inElementStartTag.hierarchy
      );

      // Check if we're in an attribute value for context-aware completions
      const attributeRange = xmlTracker.isInAttributeValue(document, position);
      if (attributeRange) {
        logger.debug(`Completion requested in attribute: ${attributeRange.elementName}.${attributeRange.name}`);
      }
      if (attributeRange === undefined) {
        if (elementAttributes !== undefined) {
          for (const attr of elementAttributes) {
            if (!inElementStartTag.attributes.some((a) => a.name === attr.name)) {
              CompletionDict.addItem(
                items,
                attr.name,
                `${attr.annotation || ''}\n\n**Required**: ${attr.required ? '**Yes**' : 'No'}\n\n**Type**: ${attr.type || 'unknown'}`
              );
            }
          }
          return this.makeCompletionList(items);
        } else {
          return undefined; // Skip if not in an attribute value
        }
      }
      const attributeValues: Map<string, string> = elementAttributes
        ? XsdReference.getAttributePossibleValues(elementAttributes, attributeRange.name)
        : new Map<string, string>();
      if (attributeValues) {
        // If the attribute has predefined values, return them as completions
        const items = new Map<string, vscode.CompletionItem>();
        for (const [value, info] of attributeValues.entries()) {
          CompletionDict.addItem(items, value, info);
        }
        return this.makeCompletionList(items);
      }

      // Check if we're in a specialized completion context (variables, labels, actions)
      const specializedCompletion = specializedCompletionContext(document, position);
      if (specializedCompletion.length > 0) {
        return specializedCompletion;
      }

      const documentLine = document.lineAt(position);
      let textToProcess = document.lineAt(position).text;
      let textToProcessAfter = '';
      if (currentLine === attributeRange.valueRange.start.line && currentLine === attributeRange.valueRange.end.line) {
        // If we're on the same line as the attribute value, use the current line text
        if (position.character < attributeRange.valueRange.end.character) {
          // If the position is before the end of the attribute value, use the rest of the line
          textToProcessAfter = textToProcess.substring(position.character, attributeRange.valueRange.end.character);
        }
        textToProcess = textToProcess.substring(attributeRange.valueRange.start.character, position.character);
      } else if (currentLine === attributeRange.valueRange.start.line) {
        // If we're on the start line of the attribute value, use the text from the start character to the end of the line
        if (position.character < attributeRange.valueRange.start.character) {
          textToProcessAfter = textToProcess.substring(position.character);
        }
        textToProcess = textToProcess.substring(attributeRange.valueRange.start.character, position.character);
      } else if (currentLine === attributeRange.valueRange.end.line) {
        if (position.character < attributeRange.valueRange.end.character) {
          textToProcessAfter = textToProcess.substring(position.character, attributeRange.valueRange.end.character);
        }
        textToProcess = textToProcess.substring(0, position.character);
      } else {
         if (position.character < documentLine.range.end.character) {
            textToProcessAfter = textToProcess.substring(position.character);
         }
         textToProcess = textToProcess.substring(0, position.character);
      }
      return this.processText(textToProcess);
    } else {
      const inElementRange = xmlTracker.elementInPosition(document, position);
      if (inElementRange) {
        logger.debug(`Completion requested in element range: ${inElementRange.name}`);
        return elementNameCompletion(inElementRange.name, inElementRange.hierarchy);
      }
    }
    return undefined; // Skip if not in an element range
  }
}

class LocationDict implements vscode.DefinitionProvider {
  dict: Map<string, vscode.Location> = new Map<string, vscode.Location>();

  addLocation(name: string, file: string, start: vscode.Position, end: vscode.Position): void {
    const range = new vscode.Range(start, end);
    const uri = vscode.Uri.file(file);
    this.dict.set(cleanStr(name), new vscode.Location(uri, range));
  }

  addLocationForRegexMatch(rawData: string, rawIdx: number, name: string) {
    // make sure we don't care about platform & still count right https://stackoverflow.com/a/8488787
    const line = rawData.substring(0, rawIdx).split(/\r\n|\r|\n/).length - 1;
    const startIdx = Math.max(rawData.lastIndexOf('\n', rawIdx), rawData.lastIndexOf('\r', rawIdx));
    const start = new vscode.Position(line, rawIdx - startIdx);
    const endIdx = rawData.indexOf('>', rawIdx) + 2;
    const end = new vscode.Position(line, endIdx - rawIdx);
    this.addLocation(name, scriptPropertiesPath, start, end);
  }

  addNonPropertyLocation(rawData: string, name: string, tagType: string): void {
    const rawIdx = rawData.search('<' + tagType + ' name="' + escapeRegex(name) + '"[^>]*>');
    this.addLocationForRegexMatch(rawData, rawIdx, name);
  }

  addPropertyLocation(rawData: string, name: string, parent: string, parentType: string): void {
    const re = new RegExp(
      '(?:<' +
        parentType +
        ' name="' +
        escapeRegex(parent) +
        '"[^>]*>.*?)(<property name="' +
        escapeRegex(name) +
        '"[^>]*>)',
      's'
    );
    const matches = rawData.match(re);
    if (matches === null || matches.index === undefined) {
      logger.info("strangely couldn't find property named:", name, 'parent:', parent);
      return;
    }
    const rawIdx = matches.index + matches[0].indexOf(matches[1]);
    this.addLocationForRegexMatch(rawData, rawIdx, parent + '.' + name);
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
    const scheme = getDocumentScriptType(document);
    if (scheme == '') {
      return undefined; // Skip if the document is not valid
    }
    const line = document.lineAt(position).text;
    const start = line.lastIndexOf('"', position.character);
    const end = line.indexOf('"', position.character);
    let relevant = line.substring(start, end).trim().replace('"', '');
    do {
      if (this.dict.has(relevant)) {
        return this.dict.get(relevant);
      }
      relevant = relevant.substring(relevant.indexOf('.') + 1);
    } while (relevant.indexOf('.') !== -1);
    return undefined;
  }
}

type ScriptVariableInfo = {
  definition?: vscode.Location;
  definitionPriority?: number;
  locations: vscode.Location[];
};

type ScriptVariablesMap = Map<string, ScriptVariableInfo>;
type ScriptVariablesPerType = Map<string, ScriptVariablesMap>;
type ScriptVariablesPerDocument = WeakMap<vscode.TextDocument, ScriptVariablesPerType>;

type ScriptVariableDetails = {
  name: string;
  type: string;
  location: vscode.Location;
  definition?: vscode.Location;
  locations: vscode.Location[];
  scriptType: string;
};

class VariableTracker {
  // Map to store variables per document: Map<scriptType, Map<DocumentURI, Map<variablesType, Map<variableName, {...}>>>>
  documentVariables: ScriptVariablesPerDocument = new WeakMap();

  addVariable(
    type: string,
    name: string,
    scriptType: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    isDefinition: boolean = false,
    definitionPriority?: number
  ): void {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;

    // Get or create the scriptType level
    if (!this.documentVariables.has(document)) {
      this.documentVariables.set(document, new Map());
    }
    const variablesTypes = this.documentVariables.get(document)!;

    // Get or create the variable type level
    if (!variablesTypes.has(type)) {
      variablesTypes.set(type, new Map());
    }
    const typeMap = variablesTypes.get(type)!;

    // Get or create the variable name level
    if (!typeMap.has(normalizedName)) {
      typeMap.set(normalizedName, { locations: [] });
    }
    const variableData = typeMap.get(normalizedName)!;

    // Add to locations
    variableData.locations.push(new vscode.Location(document.uri, range));

    // Handle definition if this is marked as one
    if (isDefinition && definitionPriority !== undefined) {
      // Only set definition if we don't have one, or if this has higher priority (lower number = higher priority)
      if (
        !variableData.definition ||
        !variableData.definitionPriority ||
        definitionPriority < variableData.definitionPriority
      ) {
        variableData.definition = new vscode.Location(document.uri, range);
        variableData.definitionPriority = definitionPriority;
      }
    }
  }

  getVariableDefinition(name: string, document: vscode.TextDocument): vscode.Location | undefined {
    const scheme = getDocumentScriptType(document);

    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return undefined;

    const normalizedName = name.startsWith('$') ? name.substring(1) : name;
    // Check all variable types for this variable name
    for (const typeMap of variablesTypes.values()) {
      const variableData = typeMap.get(normalizedName);
      if (variableData?.definition) {
        return variableData.definition;
      }
    }

    return undefined;
  }

  getVariableLocations(type: string, name: string, document: vscode.TextDocument): vscode.Location[] {
    const scheme = getDocumentScriptType(document);

    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return [];

    const typeMap = variablesTypes.get(type);
    if (!typeMap) return [];

    const normalizedName = name.startsWith('$') ? name.substring(1) : name;
    const variableData = typeMap.get(normalizedName);
    if (!variableData) return [];

    return variableData.locations;
  }

  getVariableAtPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableDetails | null {
    const scheme = getDocumentScriptType(document);

    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return null;

    // Check all variable types
    for (const [variableType, typeMap] of variablesTypes) {
      // Check all variable names
      for (const [variableName, variableData] of typeMap) {
        if (variableData.definition && variableData.definition.range.contains(position)) {
          return {
            name: variableName,
            type: variableType,
            location: variableData.definition,
            definition: variableData.definition,
            locations: variableData.locations,
            scriptType: scheme,
          };
        }
        const variableLocation = variableData.locations.find((loc) => loc.range.contains(position));
        if (variableLocation) {
          return {
            name: variableName,
            type: variableType,
            location: variableLocation,
            definition: variableData.definition,
            locations: variableData.locations,
            scriptType: scheme,
          };
        }
      }
    }

    return null;
  }

  updateVariableName(type: string, oldName: string, newName: string, document: vscode.TextDocument): void {
    const scheme = getDocumentScriptType(document);

    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return;

    const typeMap = variablesTypes.get(type);
    if (!typeMap) return;

    const normalizedOldName = oldName.startsWith('$') ? oldName.substring(1) : oldName;
    const normalizedNewName = newName.startsWith('$') ? newName.substring(1) : newName;

    const variableData = typeMap.get(normalizedOldName);
    if (!variableData) return;

    // Move the variable data to the new name
    typeMap.set(normalizedNewName, variableData);
    typeMap.delete(normalizedOldName);
  }

  clearVariablesForDocument(document: vscode.TextDocument): void {
    this.documentVariables.delete(document);
  }

  getAllVariablesForDocumentMap(document: vscode.TextDocument, prefix: string = ''): Map<string, vscode.MarkdownString> {
    const result: Map<string, vscode.MarkdownString> = new Map();
    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return result;

    const scheme = getDocumentScriptType(document);
    // Process all variable types
    for (const [variableType, typeMap] of variablesTypes) {
      // Process all variables
      for (const [variableName, variableData] of typeMap) {
        if (prefix === '' || variableName.startsWith(prefix)) {
          // Only add the item if it matches the prefix
          const totalLocations = variableData.locations.length;
          const info = new vscode.MarkdownString(`${scriptNodes[scheme]?.info || 'Script'} ${variableTypes[variableType] || 'Variable'}: ${variableName}`);
          info.appendMarkdown(`\n\nUsed ${totalLocations} time${totalLocations !== 1 ? 's' : ''}`);
          result.set(variableName, info);
        }
      }
    }

    return result;
  }

  getAllVariablesForDocument(document: vscode.TextDocument, exclude: string = ''): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return result;

    const scheme = getDocumentScriptType(document);
    // Process all variable types
    for (const [variableType, typeMap] of variablesTypes) {
      // Process all variables
      for (const [variableName, variableData] of typeMap) {
        if (variableName === exclude) {
          continue;
        }

        const totalLocations = variableData.locations.length;

        const item = new vscode.CompletionItem(variableName, vscode.CompletionItemKind.Variable);
        item.detail = `${scriptNodes[scheme]?.info || 'Script'} ${variableTypes[variableType] || 'Variable'}`;
        item.documentation = new vscode.MarkdownString(`Used ${totalLocations} time${totalLocations !== 1 ? 's' : ''}`);

        item.insertText = variableName;
        result.push(item);
      }
    }

    return result;
  }
}

const variableTracker = new VariableTracker();

type ScriptLabels = {
  labels: Map<string, vscode.Location>;
  references: Map<string, vscode.Location[]>;
};

class LabelTracker {
  // Map to store labels per document: Map<DocumentURI, Map<LabelName, vscode.Location>>
  documentLabels: WeakMap<vscode.TextDocument, ScriptLabels> = new WeakMap();

  addLabel(name: string, scriptType: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentLabels.has(document)) {
      this.documentLabels.set(document, {
        labels: new Map(),
        references: new Map(),
      });
    }
    const labelData = this.documentLabels.get(document)!;

    // Add the label definition location
    labelData.labels.set(name, new vscode.Location(document.uri, range));

    // Initialize references map if not exists
    if (!labelData.references.has(name)) {
      labelData.references.set(name, []);
    }
  }

  addLabelReference(name: string, scriptType: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentLabels.has(document)) {
      this.documentLabels.set(document, {
        labels: new Map(),
        references: new Map(),
      });
    }
    const labelData = this.documentLabels.get(document)!;

    // Add the reference location
    if (!labelData.references.has(name)) {
      labelData.references.set(name, []);
    }
    labelData.references.get(name)!.push(new vscode.Location(document.uri, range));
  }

  getLabelDefinition(name: string, document: vscode.TextDocument): vscode.Location | undefined {
    const documentData = this.documentLabels.get(document);
    if (!documentData) {
      return undefined;
    }
    return documentData.labels.get(name);
  }

  getLabelReferences(name: string, document: vscode.TextDocument): vscode.Location[] {
    const documentData = this.documentLabels.get(document);
    if (!documentData || !documentData.references.has(name)) {
      return [];
    }
    return documentData.references.get(name) || [];
  }

  getLabelAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { name: string; location: vscode.Location; isDefinition: boolean } | null {
    const documentData = this.documentLabels.get(document);
    if (!documentData) {
      return null;
    }

    // Check if position is at a label definition
    for (const [labelName, location] of documentData.labels.entries()) {
      if (location.range.contains(position)) {
        return {
          name: labelName,
          location: location,
          isDefinition: true,
        };
      }
    }

    // Check if position is at a label reference
    for (const [labelName, locations] of documentData.references.entries()) {
      const referenceLocation = locations.find((loc) => loc.range.contains(position));
      if (referenceLocation) {
        return {
          name: labelName,
          location: referenceLocation,
          isDefinition: false,
        };
      }
    }

    return null;
  }

  getAllLabelsForDocumentMap(document: vscode.TextDocument, prefix: string = ''): Map<string, vscode.MarkdownString> {
    const result: Map<string, vscode.MarkdownString> = new Map();
    const documentData = this.documentLabels.get(document);
    if (!documentData) {
      return result;
    }
    const schema = getDocumentScriptType(document);
    // Process all labels
    for (const [name, location] of documentData.labels.entries()) {
      if (prefix === '' || name.startsWith(prefix)) {
      // Only add the item if it matches the prefix
        result.set(name, new vscode.MarkdownString(`Label in ${scriptNodes[schema]?.info || 'Script'}`));
      }
    }

    return result;
  }

  getAllLabelsForDocument(document: vscode.TextDocument): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    const documentData = this.documentLabels.get(document);
    if (!documentData) {
      return result;
    }

    const schema = getDocumentScriptType(document);

    // Process all labels
    for (const [name, location] of documentData.labels.entries()) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
      item.detail = `Label in ${scriptNodes[schema]?.info || 'Script'}`;

      // Count references
      const referenceCount = documentData.references.get(name)?.length || 0;
      item.documentation = new vscode.MarkdownString(
        `Label \`${name}\` referenced ${referenceCount} time${referenceCount !== 1 ? 's' : ''}`
      );

      result.push(item);
    }

    return result;
  }

  clearLabelsForDocument(document: vscode.TextDocument): void {
    this.documentLabels.delete(document);
  }
}

const labelTracker = new LabelTracker();

// ActionTracker class for tracking AIScript actions
class ActionsTracker {
  // Map to store actions per document: Map<DocumentURI, Map<ActionName, vscode.Location>>
  documentActions: WeakMap<
    vscode.TextDocument,
    { scriptType: string; actions: Map<string, vscode.Location>; references: Map<string, vscode.Location[]> }
  > = new Map();

  addActions(name: string, scriptType: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the action map for the document
    if (!this.documentActions.has(document)) {
      this.documentActions.set(document, {
        scriptType: scriptType,
        actions: new Map(),
        references: new Map(),
      });
    }
    const actionData = this.documentActions.get(document)!;

    // Add the action definition location
    actionData.actions.set(name, new vscode.Location(document.uri, range));

    // Initialize references map if not exists
    if (!actionData.references.has(name)) {
      actionData.references.set(name, []);
    }
  }

  addActionsReference(name: string, scriptType: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the action map for the document
    if (!this.documentActions.has(document)) {
      this.documentActions.set(document, {
        scriptType: scriptType,
        actions: new Map(),
        references: new Map(),
      });
    }
    const actionData = this.documentActions.get(document)!;

    // Add the reference location
    if (!actionData.references.has(name)) {
      actionData.references.set(name, []);
    }
    actionData.references.get(name)!.push(new vscode.Location(document.uri, range));
  }

  getActionsDefinition(name: string, document: vscode.TextDocument): vscode.Location | undefined {
    const documentData = this.documentActions.get(document);
    if (!documentData) {
      return undefined;
    }
    return documentData.actions.get(name);
  }

  getActionsReferences(name: string, document: vscode.TextDocument): vscode.Location[] {
    const documentData = this.documentActions.get(document);
    if (!documentData || !documentData.references.has(name)) {
      return [];
    }
    return documentData.references.get(name) || [];
  }

  getActionsAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { name: string; location: vscode.Location; isDefinition: boolean } | null {
    const documentData = this.documentActions.get(document);
    if (!documentData) {
      return null;
    }

    // Check if position is at an action definition
    for (const [actionName, location] of documentData.actions.entries()) {
      if (location.range.contains(position)) {
        return {
          name: actionName,
          location: location,
          isDefinition: true,
        };
      }
    }

    // Check if position is at an action reference
    for (const [actionName, locations] of documentData.references.entries()) {
      const referenceLocation = locations.find((loc) => loc.range.contains(position));
      if (referenceLocation) {
        return {
          name: actionName,
          location: referenceLocation,
          isDefinition: false,
        };
      }
    }

    return null;
  }

  getAllActionsForDocumentMap(document: vscode.TextDocument, prefix: string = ''): Map<string, vscode.MarkdownString> {
    const result: Map<string, vscode.MarkdownString> = new Map();
    const documentData = this.documentActions.get(document);
    if (!documentData) {
      return result;
    }
    const schema = getDocumentScriptType(document);
    // Process all actions
    for (const [name, location] of documentData.actions.entries()) {
      if (prefix === '' || name.startsWith(prefix)) {
        // Only add the item if it matches the prefix
        result.set(name, new vscode.MarkdownString(`AI Script Action in ${scriptNodes[schema]?.info || 'Script'}`));
      }
    }

    return result;
  }

  getAllActionsForDocument(document: vscode.TextDocument): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    const documentData = this.documentActions.get(document);
    if (!documentData) {
      return result;
    }

    // Process all actions
    for (const [name, location] of documentData.actions.entries()) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
      item.detail = `AI Script Action`;

      // Count references
      const referenceCount = documentData.references.get(name)?.length || 0;
      item.documentation = new vscode.MarkdownString(
        `Action \`${name}\` referenced ${referenceCount} time${referenceCount !== 1 ? 's' : ''}`
      );

      result.push(item);
    }

    return result;
  }

  clearActionsForDocument(document: vscode.TextDocument): void {
    this.documentActions.delete(document);
  }
}

const actionTracker = new ActionsTracker();

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
  private scriptProperties: CompletionDict;
  private labelTracker: LabelTracker;
  private actionsTracker: ActionsTracker;
  private variablesTracker: VariableTracker;

  constructor(xsdReference: XsdReference, xmlStructureTracker: XmlStructureTracker, scriptProperties: CompletionDict, labelTracker: LabelTracker, actionsTracker: ActionsTracker, variablesTracker: VariableTracker) {
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

  private static makeCompletionList(items: CompletionsMap, isIncomplete: boolean = true): vscode.CompletionList {
    return new vscode.CompletionList(Array.from(items.values()), isIncomplete);
  }

  private elementNameCompletion(schema: string, document: vscode.TextDocument, position: vscode.Position, parentName: string, parentHierarchy: string[], range?: vscode.Range): vscode.CompletionList | undefined {
    const items: CompletionsMap = new Map();
    const possibleElements = this.xsdReference.getPossibleChildElements(schema, parentName, parentHierarchy);
    if (possibleElements !== undefined) {
      logger.debug(`Possible elements for ${parentName}:`, possibleElements);
      const currentLinePrefix =  document.lineAt(position).text.substring(0, position.character);
      const startTagIndex = currentLinePrefix.lastIndexOf('<');
      if (startTagIndex === -1) {
        logger.debug('No start tag found in current line prefix:', currentLinePrefix);
        return undefined; // Skip if no start tag found
      }
      const startTagInsidePrefix = currentLinePrefix.slice(currentLinePrefix.lastIndexOf('<') + 1);
      if (startTagInsidePrefix.includes(' ')) {
        logger.debug('Start tag inside prefix contains space, skipping:', startTagInsidePrefix);
        return undefined; // Skip if the start tag inside prefix contains a space
      }
      for (const [value, info] of possibleElements.entries()) {
        if (!startTagInsidePrefix || value.startsWith(startTagInsidePrefix)) {
          ScriptCompletion.addItem(items, 'element', `${value}`, new vscode.MarkdownString(info), range);
        }
      }
      return ScriptCompletion.makeCompletionList(items);
      // return new vscode.CompletionList(Array.from(items.values()), false);
    } else {
      logger.debug('No possible elements found for:', parentName);
    }
  }

  private static attributeNameCompletion(element: ElementRange, elementAttributes: EnhancedAttributeInfo[], prefix: string = '', range?: vscode.Range): vscode.CompletionList | undefined {
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
      return ScriptCompletion.makeCompletionList(items);
    }
    return undefined;
  }

  public prepareCompletion(document: vscode.TextDocument, position: vscode.Position, checkOnly: boolean, token?: vscode.CancellationToken, context?: vscode.CompletionContext): vscode.CompletionItem[] | vscode.CompletionList | undefined {
    const schema = getDocumentScriptType(document);
    if (schema == '') {
      return undefined; // Skip if the document is not valid
    }
    const items = new Map<string, vscode.CompletionItem>();
    const currentLine = position.line;

    const characterAtPosition = document.getText(new vscode.Range(position, position.translate(0, 1)));

    const element = this.xmlTracker.elementStartTagInPosition(document, position);
    if (element) {
      logger.debug(`Completion requested in element: ${element.name}`);

      const elementByName = this.xmlTracker.elementNameInPosition(document, position);
      if (elementByName) {
        if (checkOnly) {
          return []; // Return empty list if only checking
        } else {
          const parent: ElementRange = this.xmlTracker.getParentElement(document, elementByName);
          return this.elementNameCompletion(schema, document, position, parent.name, parent.hierarchy, elementByName.nameRange);
        }
      }

      const elementAttributes: EnhancedAttributeInfo[] = this.xsdReference.getElementAttributesWithTypes(
        schema,
        element.name,
        element.hierarchy
      );

      let attribute = this.xmlTracker.isInAttributeName(document, position);
      if (attribute) {
        logger.debug(`Completion requested in attribute name: ${attribute.elementName}.${attribute.name}`);
      }
      if (attribute) {
        if (checkOnly) {
          return []; // Return empty list if only checking
        }
        if (elementAttributes !== undefined) {
          const prefix = document.getText(new vscode.Range(attribute.nameRange.start, position));
          return ScriptCompletion.attributeNameCompletion(element, elementAttributes, prefix, attribute.nameRange);
        }
      }

      // Check if we're in an attribute value for context-aware completions
      attribute = this.xmlTracker.isInAttributeValue(document, position);
      if (attribute) {
        logger.debug(`Completion requested in attribute value: ${attribute.elementName}.${attribute.name}`);
      }
      if (attribute === undefined && characterAtPosition !== '=') {
        if (checkOnly) {
          return []; // Return empty list if only checking
        }
        if (elementAttributes !== undefined) {
          return ScriptCompletion.attributeNameCompletion(element, elementAttributes);
        } else {
          return undefined; // Skip if not in an attribute value
        }
      }
      if (checkOnly) {
        return []; // Return empty list if only checking
      }

      // If we're in an attribute value, we need to check for possible values
      const attributeValues: Map<string, string> = elementAttributes
        ? XsdReference.getAttributePossibleValues(elementAttributes, attribute.name)
        : new Map<string, string>();
      if (attributeValues) {
        // If the attribute has predefined values, return them as completions
        const prefix = document.getText(new vscode.Range(attribute.valueRange.start, position));
        for (const [value, info] of attributeValues.entries()) {
          if (prefix == '' || value.startsWith(prefix)) {
            // Only add the item if it matches the prefix
            ScriptCompletion.addItem(items, 'value', value, new vscode.MarkdownString(info), attribute.valueRange);
          }
        }
        return ScriptCompletion.makeCompletionList(items);
      }
      // Check if we're in a label or action context
      if (schema === aiScriptId && labelElementAttributeMap[elementByName.name]?.includes(attribute.name)) {
        const prefix = document.getText(new vscode.Range(attribute.valueRange.start, position));
        const labelCompletion = this.labelTracker.getAllLabelsForDocumentMap(document, prefix);
        if (labelCompletion.size > 0) {
          for (const [labelName, info] of labelCompletion.entries()) {
            ScriptCompletion.addItem(items, 'label', labelName, info, attribute.valueRange);
          }
          return ScriptCompletion.makeCompletionList(items);
        }
        return undefined; // Skip if no labels found
      }
      // Check if we're in an action context
      if (schema === aiScriptId && actionElementAttributeMap[elementByName.name]?.includes(attribute.name)) {
        const prefix = document.getText(new vscode.Range(attribute.valueRange.start, position));
        const actionCompletion = this.actionsTracker.getAllActionsForDocumentMap(document, prefix);
        if (actionCompletion.size > 0) {
          for (const [actionName, info] of actionCompletion.entries()) {
            ScriptCompletion.addItem(items, 'actions', actionName, info, attribute.valueRange);
          }
          return ScriptCompletion.makeCompletionList(items);
        }
        return undefined; // Skip if no actions found
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
          for (const breakSymbol of [' ', '.', '[', '{', ',']) {
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
          return ScriptCompletion.makeCompletionList(items);
        }
      }
      return this.scriptProperties.processText(textToProcessBefore);
    } else {
      const inElementRange = this.xmlTracker.elementInPosition(document, position);
      if (inElementRange) {
        logger.debug(`Completion requested in element range: ${inElementRange.name}`);
        return this.elementNameCompletion(schema, document, position,inElementRange.name, inElementRange.hierarchy);
      }
    }
    return undefined; // Skip if not in an element range
  }

  public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context?: vscode.CompletionContext
  )  {
    return this.prepareCompletion(document, position, false, token, context);
  }
}

// Diagnostic collection for tracking errors
let diagnosticCollection: vscode.DiagnosticCollection;

function getDocumentScriptType(document: vscode.TextDocument): string {
  let languageSubId: string = '';

  if (document.languageId !== 'xml') {
    logger.debug(`Document ${document.uri.toString()} is not recognized as a xml.`);
    return languageSubId; // Skip if the document is not recognized as a xml
  }

  const scriptMetaData = scriptsMetadata.get(document)!;
  if (scriptMetaData && scriptMetaData.scheme) {
    languageSubId = scriptMetaData.scheme;
    logger.debug(`Document ${document.uri.toString()} recognized as script type: ${languageSubId}`);
    return languageSubId; // Return the cached type if available
  }

  const text = document.getText();
  const parser = sax.parser(true); // Use strict mode for validation

  parser.onopentag = (node) => {
    // Check if the root element is <aiscript> or <mdscript>
    if (scriptNodesNames.includes(node.name)) {
      languageSubId = scriptNodes[node.name].id;
    }
    parser.close(); // Stop parsing as soon as the root element is identified
  };

  try {
    parser.write(text).close();
  } catch {
    // Will not react, as we have only one possibility to get a true
  }

  if (languageSubId) {
    // Cache the languageSubId for future use
    if (!scriptsMetadata.has(document)) {
      scriptsMetadata.set(document, { scheme: languageSubId });
    } else {
        scriptMetaData.scheme = languageSubId;
    }
    logger.debug(`Cached languageSubId: ${languageSubId} for document: ${document.uri.toString()}`);
  }

  return languageSubId;
}

function validateReferences(document: vscode.TextDocument): vscode.Diagnostic[] {
  const scheme = getDocumentScriptType(document);
  if (scheme !== aiScriptId) {
    return []; // Only validate AI scripts
  }

  const documentData = labelTracker.documentLabels.get(document);
  const actionData = actionTracker.documentActions.get(document);

  const diagnostics: vscode.Diagnostic[] = [];

  // Validate label references
  if (documentData) {
    for (const [labelName, references] of documentData.references.entries()) {
      const hasDefinition = documentData.labels.has(labelName);

      if (!hasDefinition) {
        references.forEach((reference) => {
          const diagnostic = new vscode.Diagnostic(
            reference.range,
            `Label '${labelName}' is not defined`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'undefined-label';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }
    }
  }

  // Validate action references
  if (actionData) {
    for (const [actionName, references] of actionData.references.entries()) {
      const hasDefinition = actionData.actions.has(actionName);

      if (!hasDefinition) {
        references.forEach((reference) => {
          const diagnostic = new vscode.Diagnostic(
            reference.range,
            `Action '${actionName}' is not defined`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'undefined-action';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }
    }
  }
  return diagnostics;
}

function trackScriptDocument(document: vscode.TextDocument, update: boolean = false): void {
  const scheme = getDocumentScriptType(document);
  if (scheme == '') {
    return; // Skip processing if the document is not valid
  }
  const schema = scriptTypesToSchema[scheme];
  const diagnostics: vscode.Diagnostic[] = [];

  const isXMLParsed = xmlTracker.checkDocumentParsed(document);
  if (isXMLParsed && !update) {
    logger.warn(`Document ${document.uri.toString()} is already parsed.`);
    return; // Skip if the document is already parsed
  }

  const lValueTypes = ['lvalueexpression', ...xsdReference.getSimpleTypesWithBaseType(schema, 'lvalueexpression')];
  const xmlElements: ElementRange[] = xmlTracker.parseDocument(document);
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
  labelTracker.clearLabelsForDocument(document);
  actionTracker.clearActionsForDocument(document);

  // Use the XML structure to find labels, actions, and variables more efficiently
  const text = document.getText();

  // Process all elements recursively
  const processElement = (element: ElementRange) => {
    const parentName = element.parentName || '';
    const elementDefinition = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
    if (elementDefinition === undefined) {
      const diagnostic = new vscode.Diagnostic(
        element.range,
        `Unknown element '${element.name}' in script type '${scheme}'`,
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

          // Check for label definitions
          if (scheme === aiScriptId && element.name === 'label' && attr.name === 'name') {
            labelTracker.addLabel(attrValue, scheme, document, attr.valueRange);
          }
          // Check for label references
          if (scheme === aiScriptId && labelElementAttributeMap[element.name]?.includes(attr.name)) {
            labelTracker.addLabelReference(attrValue, scheme, document, attr.valueRange);
          }
          // Check for action definitions
          if (scheme === aiScriptId && element.name === 'actions' && attr.name === 'name' && element.hierarchy.length > 0 && attr.hierarchy[0] === 'library') {
            actionTracker.addActions(attrValue, scheme, document, attr.valueRange);
          }
          // Check for action references
          if (scheme === aiScriptId && actionElementAttributeMap[element.name]?.includes(attr.name)) {
            actionTracker.addActionsReference(attrValue, scheme, document, attr.valueRange);
          }

          if (scheme === aiScriptId && element.name === 'param' && attr.name === 'name' && element.hierarchy.length > 0 && attr.hierarchy[0] === 'params') {
            variableTracker.addVariable(
              'normal',
              attrValue,
              scheme,
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
          if (scheme === aiScriptId && isLValueAttribute) {
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
            if (end.isEqual(attr.valueRange.end) && priority >= 0) {
              variableTracker.addVariable(
                variableType,
                variableName,
                scheme,
                document,
                new vscode.Range(start, end),
                true, // isDefinition
                priority
              );
            } else {
              variableTracker.addVariable(
                variableType,
                variableName,
                scheme,
                document,
                new vscode.Range(start, end)
              );
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

const completionProvider = new CompletionDict();
const definitionProvider = new LocationDict();
let scriptCompletionProvider : ScriptCompletion;

function readScriptProperties(filepath: string) {
  logger.info('Attempting to read scriptproperties.xml');
  // Can't move on until we do this so use sync version
  const rawData = fs.readFileSync(filepath).toString();
  let keywords = [] as Keyword[];
  let datatypes = [] as Datatype[];

  xml2js.parseString(rawData, function (err: any, result: any) {
    if (err !== null) {
      vscode.window.showErrorMessage('Error during parsing of scriptproperties.xml:' + err);
    }

    // Process keywords and datatypes here, return the completed results
    keywords = processKeywords(rawData, result['scriptproperties']['keyword']);
    datatypes = processDatatypes(rawData, result['scriptproperties']['datatype']);
    completionProvider.defaultCompletions = new vscode.CompletionList(completionProvider.allPropItems, true);
    completionProvider.addTypeLiteral('boolean', '==false');
    logger.info('Parsed scriptproperties.xml');
  });
  completionProvider.makeKeywords();
  return { keywords, datatypes };
}

function cleanStr(text: string) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegex(text: string) {
  // https://stackoverflow.com/a/6969486
  return cleanStr(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function processProperty(rawData: string, parent: string, parentType: string, prop: ScriptProperty) {
  const name = prop.$.name;
  logger.debug('\tProperty read: ', name);
  definitionProvider.addPropertyLocation(rawData, name, parent, parentType);
  completionProvider.addProperty(parent, name, prop.$.type, prop.$.result);
}

function processKeyword(rawData: string, e: Keyword) {
  const name = e.$.name;
  definitionProvider.addNonPropertyLocation(rawData, name, 'keyword');
  completionProvider.addDescription(name, e.$.description);
  logger.debug('Keyword read: ' + name);

  if (e.import !== undefined) {
    const imp = e.import[0];
    const src = imp.$.source;
    const select = imp.$.select;
    const tgtName = imp.property[0].$.name;
    processKeywordImport(name, src, select, tgtName);
  } else if (e.property !== undefined) {
    e.property.forEach((prop) => processProperty(rawData, name, 'keyword', prop));
  }
}

interface XPathResult {
  $: { [key: string]: string };
}
function processKeywordImport(name: string, src: string, select: string, targetName: string) {
  const path = rootpath + '/libraries/' + src;
  logger.info('Attempting to import: ' + src);
  // Can't move on until we do this so use sync version
  const rawData = fs.readFileSync(path).toString();
  xml2js.parseString(rawData, function (err: any, result: any) {
    if (err !== null) {
      vscode.window.showErrorMessage('Error during parsing of ' + src + err);
    }

    const matches = xpath.find(result, select + '/' + targetName);
    matches.forEach((element: XPathResult) => {
      completionProvider.addTypeLiteral(name, element.$[targetName.substring(1)]);
    });
  });
}

interface ScriptProperty {
  $: {
    name: string;
    result: string;
    type?: string;
  };
}
interface Keyword {
  $: {
    name: string;
    type?: string;
    pseudo?: string;
    description?: string;
  };
  property?: [ScriptProperty];
  import?: [
    {
      $: {
        source: string;
        select: string;
      };
      property: [
        {
          $: {
            name: string;
          };
        },
      ];
    },
  ];
}

interface Datatype {
  $: {
    name: string;
    type?: string;
    suffix?: string;
  };
  property?: [ScriptProperty];
}

function processDatatype(rawData: any, e: Datatype) {
  const name = e.$.name;
  definitionProvider.addNonPropertyLocation(rawData, name, 'datatype');
  logger.debug('Datatype read: ' + name);
  if (e.property === undefined) {
    return;
  }
  completionProvider.addType(name, e.$.type);
  e.property.forEach((prop) => processProperty(rawData, name, 'datatype', prop));
}

// Process all keywords in the XML
function processKeywords(rawData: string, keywords: any[]): Keyword[] {
  const processedKeywords: Keyword[] = [];
  keywords.forEach((e: Keyword) => {
    processKeyword(rawData, e);
    processedKeywords.push(e); // Add processed keyword to the array
  });
  return processedKeywords;
}

// Process all datatypes in the XML
function processDatatypes(rawData: string, datatypes: any[]): Datatype[] {
  const processedDatatypes: Datatype[] = [];
  datatypes.forEach((e: Datatype) => {
    processDatatype(rawData, e);
    processedDatatypes.push(e); // Add processed datatype to the array
  });
  return processedDatatypes;
}

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

function generateKeywordText(keyword: any, datatypes: Datatype[], parts: string[]): string {
  // Ensure keyword is valid
  if (!keyword || !keyword.$) {
    return '';
  }

  const description = keyword.$.description;
  const pseudo = keyword.$.pseudo;
  const suffix = keyword.$.suffix;
  const result = keyword.$.result;

  let hoverText = `Keyword: ${keyword.$.name}\n
  ${description ? 'Description: ' + description + '\n' : ''}
  ${pseudo ? 'Pseudo: ' + pseudo + '\n' : ''}
  ${result ? 'Result: ' + result + '\n' : ''}
  ${suffix ? 'Suffix: ' + suffix + '\n' : ''}`;
  let name = keyword.$.name;
  let currentPropertyList: ScriptProperty[] = Array.isArray(keyword.property) ? keyword.property : [];
  let updated = false;

  // Iterate over parts of the path (excluding the first part which is the keyword itself)
  for (let i = 1; i < parts.length; i++) {
    let properties: ScriptProperty[] = [];

    // Ensure currentPropertyList is iterable
    if (!Array.isArray(currentPropertyList)) {
      currentPropertyList = [];
    }

    // For the last part, use 'includes' to match the property
    if (i === parts.length - 1) {
      properties = currentPropertyList.filter((p: ScriptProperty) => {
        // Safely access p.$.name
        const propertyName = p && p.$ && p.$.name ? p.$.name : '';
        const pattern = new RegExp(`\\{\\$${parts[i]}\\}`, 'i');
        return propertyName.includes(parts[i]) || pattern.test(propertyName);
      });
    } else {
      // For intermediate parts, exact match
      properties = currentPropertyList.filter((p: ScriptProperty) => p && p.$ && p.$.name === parts[i]);

      if (properties.length === 0 && currentPropertyList.length > 0) {
        // Try to find properties via type lookup
        currentPropertyList.forEach((property) => {
          if (property && property.$ && property.$.type) {
            const type = datatypes.find((d: Datatype) => d && d.$ && d.$.name === property.$.type);
            if (type && Array.isArray(type.property)) {
              properties.push(...type.property.filter((p: ScriptProperty) => p && p.$ && p.$.name === parts[i]));
            }
          }
        });
      }
    }

    if (properties.length > 0) {
      properties.forEach((property) => {
        // Safely access property attributes
        if (property && property.$ && property.$.name && property.$.result) {
          hoverText += `\n\n- ${name}.${property.$.name}: ${property.$.result}`;
          updated = true;

          // Update currentPropertyList for the next part
          if (property.$.type) {
            const type = datatypes.find((d: Datatype) => d && d.$ && d.$.name === property.$.type);
            currentPropertyList = type && Array.isArray(type.property) ? type.property : [];
          }
        }
      });

      // Append the current part to 'name' only if properties were found
      name += `.${parts[i]}`;
    } else {
      // If no properties match, reset currentPropertyList to empty to avoid carrying forward invalid state
      currentPropertyList = [];
    }
  }
  hoverText = hoverText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return updated ? hoverText : '';
}

function generateHoverWordText(hoverWord: string, keywords: Keyword[], datatypes: Datatype[]): string {
  let hoverText = '';

  // Find keywords that match the hoverWord either in their name or property names
  const matchingKeyNames = keywords.filter(
    (k: Keyword) =>
      k.$.name.includes(hoverWord) || k.property?.some((p: ScriptProperty) => p.$.name.includes(hoverWord))
  );

  // Find datatypes that match the hoverWord either in their name or property names
  const matchingDatatypes = datatypes.filter(
    (d: Datatype) =>
      d.$.name.includes(hoverWord) || // Check if datatype name includes hoverWord
      d.property?.some((p: ScriptProperty) => p.$.name.includes(hoverWord)) // Check if any property name includes hoverWord
  );

  logger.debug('matchingKeyNames:', matchingKeyNames);
  logger.debug('matchingDatatypes:', matchingDatatypes);

  // Define the type for the grouped matches
  interface GroupedMatch {
    description: string[];
    type: string[];
    pseudo: string[];
    suffix: string[];
    properties: string[];
  }

  // A map to group matches by the header name
  const groupedMatches: { [key: string]: GroupedMatch } = {};

  // Process matching keywords
  matchingKeyNames.forEach((k: Keyword) => {
    const header = k.$.name;

    // Initialize the header if not already present
    if (!groupedMatches[header]) {
      groupedMatches[header] = {
        description: [],
        type: [],
        pseudo: [],
        suffix: [],
        properties: [],
      };
    }

    // Add description, type, and pseudo if available
    if (k.$.description) groupedMatches[header].description.push(k.$.description);
    if (k.$.type) groupedMatches[header].type.push(`${k.$.type}`);
    if (k.$.pseudo) groupedMatches[header].pseudo.push(`${k.$.pseudo}`);

    // Collect matching properties
    let properties: ScriptProperty[] = [];
    if (k.$.name === hoverWord) {
      properties = k.property || []; // Include all properties for exact match
    } else {
      properties = k.property?.filter((p: ScriptProperty) => p.$.name.includes(hoverWord)) || [];
    }
    if (properties && properties.length > 0) {
      properties.forEach((p: ScriptProperty) => {
        if (p.$.result) {
          const resultText = `\n- ${k.$.name}.${p.$.name}: ${p.$.result}`;
          groupedMatches[header].properties.push(resultText);
        }
      });
    }
  });

  // Process matching datatypes
  matchingDatatypes.forEach((d: Datatype) => {
    const header = d.$.name;
    if (!groupedMatches[header]) {
      groupedMatches[header] = {
        description: [],
        type: [],
        pseudo: [],
        suffix: [],
        properties: [],
      };
    }
    if (d.$.type) groupedMatches[header].type.push(`${d.$.type}`);
    if (d.$.suffix) groupedMatches[header].suffix.push(`${d.$.suffix}`);

    let properties: ScriptProperty[] = [];
    if (d.$.name === hoverWord) {
      properties = d.property || []; // All properties for exact match
    } else {
      properties = d.property?.filter((p) => p.$.name.includes(hoverWord)) || [];
    }

    if (properties.length > 0) {
      properties.forEach((p: ScriptProperty) => {
        if (p.$.result) {
          groupedMatches[header].properties.push(`\n- ${d.$.name}.${p.$.name}: ${p.$.result}`);
        }
      });
    }
  });

  let matches = '';
  // Sort and build the final hoverText string
  Object.keys(groupedMatches)
    .sort()
    .forEach((header) => {
      const group = groupedMatches[header];

      // Sort the contents for each group
      if (group.description.length > 0) group.description.sort();
      if (group.type.length > 0) group.type.sort();
      if (group.pseudo.length > 0) group.pseudo.sort();
      if (group.suffix.length > 0) group.suffix.sort();
      if (group.properties.length > 0) group.properties.sort();

      // Only add the header if there are any matches in it
      let groupText = `\n\n${header}`;

      // Append the sorted results for each category
      if (group.description.length > 0) groupText += `: ${group.description.join(' | ')}`;
      if (group.type.length > 0) groupText += ` (type: ${group.type.join(' | ')})`;
      if (group.pseudo.length > 0) groupText += ` (pseudo: ${group.pseudo.join(' | ')})`;
      if (group.suffix.length > 0) groupText += ` (suffix: ${group.suffix.join(' | ')})`;
      if (group.properties.length > 0) {
        groupText += '\n' + `${group.properties.join('\n')}`;
        // Append the groupText to matches
        matches += groupText;
      }
    });

  // Escape < and > for HTML safety and return the result
  if (matches !== '') {
    matches = matches.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    hoverText += `\n\nMatches for '${hoverWord}':\n${matches}`;
  }

  return hoverText; // Return the constructed hoverText
}

export function activate(context: vscode.ExtensionContext) {
  let config = vscode.workspace.getConfiguration('x4CodeComplete');
  if (!config || !validateSettings(config)) {
    return;
  }
  extensionsFolder = config.get('extensionsFolder') || '';
  if (config.get('exceedinglyVerbose') || false) {
    isDebugEnabled = true;
    setLoggerLevel('debug'); // Set logger level to debug for detailed output
  } else {
    setLoggerLevel('info'); // Set logger level to info for normal operation
  }
  logger.debug('X4CodeComplete activation started.');

  rootpath = config.get('unpackedFileLocation') || '';

  scriptPropertiesPath = path.join(rootpath, '/libraries/scriptproperties.xml');
  // Create diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('x4CodeComplete');
  context.subscriptions.push(diagnosticCollection);
  const xsdPaths: string[] = [/* '/libraries/common.xsd' */ '/libraries/aiscripts.xsd', '/libraries/md.xsd'];
  const schemaPaths = new Map<string, string>([
    ['aiscript', path.join(rootpath, 'libraries/aiscripts.xsd')],
    ['mdscript', path.join(rootpath, 'libraries/md.xsd')],
  ]);
  xsdReference = new XsdReference(path.join(rootpath, 'libraries'));
  scriptCompletionProvider= new ScriptCompletion(xsdReference, xmlTracker, completionProvider, labelTracker, actionTracker, variableTracker)
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
  let keywords = [] as Keyword[];
  let datatypes = [] as Keyword[];
  ({ keywords, datatypes } = readScriptProperties(scriptPropertiesPath));

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

  const disposableDefinitionProvider = vscode.languages.registerDefinitionProvider(sel, definitionProvider);
  context.subscriptions.push(disposableDefinitionProvider);

  // Hover provider to display tooltips
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, {
      provideHover: async (
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.Hover | undefined> => {
        const scheme = getDocumentScriptType(document);
        if (scheme == '') {
          return undefined; // Skip if the document is not valid
        }

        const schema = scriptTypesToSchema[scheme];
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

        const element = xmlTracker.elementStartTagInPosition(document, position);
        if (element) {
          const attribute = xmlTracker.isInAttributeName(document, position);
          if (attribute) {
              const hoverText = new vscode.MarkdownString();
              const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(schema, attribute.elementName, attribute.hierarchy);
              const attributeInfo = elementAttributes.find((attr) => attr.name === attribute.name);
              if (attributeInfo) {
                hoverText.appendMarkdown(`**${attribute.name}**: ${attributeInfo.annotation ? '\`' + attributeInfo.annotation + '\`' : ''}\n\n`);
                hoverText.appendMarkdown(`**Type**: \`${attributeInfo.type}\`\n\n`);
                hoverText.appendMarkdown(`**Required**: \`${attributeInfo.required ? 'Yes' : 'No'}\`\n\n`);
              } else {
                hoverText.appendMarkdown(`**${attribute.name}**: \`Wrong attribute!\`\n\n`);
              }
              return new vscode.Hover(hoverText, attribute.nameRange);
          } else if (xmlTracker.elementNameInPosition(document, position)) {
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

        if (scheme == aiScriptId) {
          // Check for actions (only in AI scripts)
          const actionAtPosition = actionTracker.getActionsAtPosition(document, position);
          if (actionAtPosition !== null) {
            const hoverText = new vscode.MarkdownString();
            const references = actionTracker.getActionsReferences(actionAtPosition.name, document);

            if (actionAtPosition.isDefinition) {
              hoverText.appendMarkdown(`**AI Script Action Definition**: \`${actionAtPosition.name}\`\n\n`);
              hoverText.appendMarkdown(`Referenced ${references.length} time${references.length !== 1 ? 's' : ''}`);
            } else {
              hoverText.appendMarkdown(`**AI Script Action Reference**: \`${actionAtPosition.name}\`\n\n`);
              const definition = actionTracker.getActionsDefinition(actionAtPosition.name, document);
              if (definition) {
                const definitionPosition = definition.range.start;
                hoverText.appendMarkdown(`Defined at line ${definitionPosition.line + 1}`);
              } else {
                hoverText.appendMarkdown(`*Action definition not found*`);
              }
            }

            return new vscode.Hover(hoverText, actionAtPosition.location.range);
          }

          // Check for labels
          const labelAtPosition = labelTracker.getLabelAtPosition(document, position);
          if (labelAtPosition !== null) {
            const hoverText = new vscode.MarkdownString();
            const references = labelTracker.getLabelReferences(labelAtPosition.name, document);

            if (labelAtPosition.isDefinition) {
              hoverText.appendMarkdown(`**Label Definition**: \`${labelAtPosition.name}\`\n\n`);
              hoverText.appendMarkdown(`Referenced ${references.length} time${references.length !== 1 ? 's' : ''}`);
            } else {
              hoverText.appendMarkdown(`**Label Reference**: \`${labelAtPosition.name}\`\n\n`);
              const definition = labelTracker.getLabelDefinition(labelAtPosition.name, document);
              if (definition) {
                const definitionPosition = definition.range.start;
                hoverText.appendMarkdown(`Defined at line ${definitionPosition.line + 1}`);
              } else {
                hoverText.appendMarkdown(`*Label definition not found*`);
              }
            }

            return new vscode.Hover(hoverText, labelAtPosition.location.range);
          }
        }

        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);

        if (variableAtPosition !== null) {
          logger.debug(`Hovering over variable: ${variableAtPosition.name}`);
          // Generate hover text for the variable
          const hoverText = new vscode.MarkdownString();
          hoverText.appendMarkdown(
            `**${scriptNodes[variableAtPosition.scriptType]?.info || 'Script'} ${variableTypes[variableAtPosition.type] || 'Variable'}**: \`${variableAtPosition.name}\`\n\n`
          );

          hoverText.appendMarkdown(
            `Used ${variableAtPosition.locations.length} time${variableAtPosition.locations.length !== 1 ? 's' : ''}\n\n`
          );
          const definition = variableTracker.getVariableDefinition(variableAtPosition.name, document);
          if (definition) {
            const definitionPosition = definition.range.start;
            hoverText.appendMarkdown(`Defined at line ${definitionPosition.line + 1}`);
          } else {
            hoverText.appendMarkdown(`*Action definition not found*`);
          }
          return new vscode.Hover(hoverText, variableAtPosition.location.range); // Updated to use variableAtPosition[0].range
        }

        const hoverWord = document.getText(document.getWordRangeAtPosition(position));
        const phraseRegex = /([.]*[$@]*[a-zA-Z0-9_-{}])+/g;
        const phrase = document.getText(document.getWordRangeAtPosition(position, phraseRegex));
        const hoverWordIndex = phrase.lastIndexOf(hoverWord);
        const slicedPhrase = phrase.slice(0, hoverWordIndex + hoverWord.length);
        const parts = slicedPhrase.split('.');
        let firstPart = parts[0].startsWith('$') || parts[0].startsWith('@') ? parts[0].slice(1) : parts[0];

        logger.debug('Hover word: ', hoverWord);
        logger.debug('Phrase: ', phrase);
        logger.debug('Sliced phrase: ', slicedPhrase);
        logger.debug('Parts: ', parts);
        logger.debug('First part: ', firstPart);

        let hoverText = '';
        while (hoverText === '' && parts.length > 0) {
          let keyword = keywords.find((k: Keyword) => k.$.name === firstPart);
          if (!keyword || keyword.import) {
            keyword = datatypes.find((d: Datatype) => d.$.name === firstPart);
          }
          if (keyword && firstPart !== hoverWord) {
            hoverText += generateKeywordText(keyword, datatypes, parts);
          }
          // Always append hover word details, ensuring full datatype properties for exact matches
          hoverText += generateHoverWordText(hoverWord, keywords, datatypes);
          if (hoverText === '' && parts.length > 1) {
            parts.shift();
            firstPart = parts[0].startsWith('$') || parts[0].startsWith('@') ? parts[0].slice(1) : parts[0];
          } else {
            break;
          }
        }
        return hoverText !== '' ? new vscode.Hover(hoverText) : undefined;
      },
    })
  );

  // Update the definition provider to support actions
  definitionProvider.provideDefinition = (document: vscode.TextDocument, position: vscode.Position) => {
    const scheme = getDocumentScriptType(document);
    if (scheme === '') {
      return undefined;
    }

    // Check if we're on a variable
    const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
    if (variableAtPosition !== null) {
      // For AI scripts, try to find the definition first
      if (scheme === aiScriptId) {
        const definition = variableTracker.getVariableDefinition(variableAtPosition.name, document);
        if (definition) {
          logger.debug(
            `Definition found for variable: ${variableAtPosition.name}: ${definition.range.start.line + 1}`
          );
          logger.debug(`Locations:`, variableAtPosition.locations);
          return definition;
        }
      }

      // Fallback to first occurrence - skipped
      return /* variableAtPosition.locations.length > 0 ? variableAtPosition.locations[0] : */ undefined;
    }

    if (scheme == aiScriptId) {
      // Check if we're on an action (only in AI scripts)
      const actionAtPosition = actionTracker.getActionsAtPosition(document, position);
      if (actionAtPosition !== null) {
        logger.debug(`Definition found for action: ${actionAtPosition.name}`);

        // If we're already at the definition, show references instead
        if (actionAtPosition.isDefinition) {
          const refs = actionTracker.getActionsReferences(actionAtPosition.name, document);
          return refs.length > 0 ? refs[0] : undefined; // Return first reference if available
        } else {
          // If we're at a reference, show the definition
          return actionTracker.getActionsDefinition(actionAtPosition.name, document);
        }
      }

      // Check if we're on a label
      const labelAtPosition = labelTracker.getLabelAtPosition(document, position);
      if (labelAtPosition !== null) {
        logger.debug(`Definition found for label: ${labelAtPosition.name}`);

        // If we're already at the definition, show references instead
        if (labelAtPosition.isDefinition) {
          return labelTracker.getLabelReferences(labelAtPosition.name, document)[0]; // Return first reference
        } else {
          // If we're at a reference, show the definition
          return labelTracker.getLabelDefinition(labelAtPosition.name, document);
        }
      }
    }

    // Default handling for other definitions
    const line = document.lineAt(position).text;
    const start = line.lastIndexOf('"', position.character);
    const end = line.indexOf('"', position.character);
    let relevant = line.substring(start, end).trim().replace('"', '');
    do {
      if (definitionProvider.dict.has(relevant)) {
        return definitionProvider.dict.get(relevant);
      }
      if (relevant.indexOf('.') !== -1) {
        relevant = relevant.substring(relevant.indexOf('.') + 1);
      } else {
        break; // No more dots to process
      }
    } while (relevant.length > 0);

    return undefined;
  };

  // // Register variable completion provider (when $ is typed)
  // context.subscriptions.push(
  //   vscode.languages.registerCompletionItemProvider(
  //     sel,
  //     {
  //       provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  //         return getVariableCompletions(document, position);
  //       },
  //     },
  //     '$', // Trigger character (still needed for the initial $ typing)
  //     '.', // Trigger character for dot completion
  //     '"'
  //   )
  // );

  // // Register label completion provider
  // context.subscriptions.push(
  //   vscode.languages.registerCompletionItemProvider(
  //     sel,
  //     {
  //       provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  //         return getLabelCompletions(document, position);
  //       },
  //     },
  //     '"', // Trigger after quote in attribute
  //     "'" // Trigger after single quote in attribute
  //   )
  // );

  // // Register action completion provider for AIScript
  // context.subscriptions.push(
  //   vscode.languages.registerCompletionItemProvider(
  //     sel,
  //     {
  //       provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  //         return getActionCompletions(document, position);
  //       },
  //     },
  //     '"', // Trigger after quote in attribute
  //     "'" // Trigger after single quote in attribute
  //   )
  // );
  logger.info('XSD schemas loaded successfully.'); // Instead of parsing all open documents, just parse the active one
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document;
    if (scriptMetadataInit(document)) {
      trackScriptDocument(document);
    }
  }

  // Listen for editor changes to parse documents as they become active
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && scriptMetadataInit(editor.document)) {
        trackScriptDocument(editor.document);
      }
    })
  );

  // Keep the onDidOpenTextDocument handler for newly opened documents
  vscode.workspace.onDidOpenTextDocument((document) => {
    if (scriptMetadataInit(document)) {
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
    if (scriptMetadataInit(event.document, true)) {
      trackScriptDocument(event.document, true); // Update the document structure
      const cursorPos = activeEditor.selection.active;

      // Check if we're in a specialized completion context
      // Move the position one character forward if possible
      let nextPos = cursorPos;
      const line = event.document.lineAt(cursorPos.line);
      if (cursorPos.character < line.text.length) {
        nextPos = cursorPos.translate(0, 1);
      }
      if (xmlTracker.isInAttributeValue(event.document, nextPos) !== undefined) {
        // Programmatically trigger suggestions
        if (event.contentChanges.length > 0 && event.contentChanges[0].text.length > 0) {
          // If there are content changes, trigger suggestions
          const changeText = event.contentChanges[0].text;
          if (
            !changeText.includes('\n') &&
            !changeText.includes('\r') &&
            !changeText.includes('\t') &&
            !changeText.includes(',') &&
            !changeText.includes('  ')
          ) {
            logger.info(`Triggering suggestions for document: ${event.document.uri.toString()}`);
            // vscode.commands.executeCommand('editor.action.triggerSuggest');
          }
        }
      }
    }
  });

  vscode.workspace.onDidSaveTextDocument((document) => {
    if (scriptMetadataInit(document, true)) {
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
        extensionsFolder = config.get('extensionsFolder') || '';
        const debugValue = config.get('exceedinglyVerbose') || false ? true : false;
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
                // Get available labels and find similar ones
                const documentData = labelTracker.documentLabels.get(document);
                if (documentData) {
                  const availableLabels = Array.from(documentData.labels.keys());
                  const similarLabels = findSimilarItems(labelName, availableLabels);

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

                // Get available actions and find similar ones
                const actionData = actionTracker.documentActions.get(document);
                if (actionData) {
                  const availableActions = Array.from(actionData.actions.keys());
                  const similarActions = findSimilarItems(actionName, availableActions);

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
        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
        if (variableAtPosition !== null) {
          logger.debug(`References found for variable: ${variableAtPosition.name}`);
          logger.debug(`Locations:`, variableAtPosition.locations);
          return variableAtPosition.locations.length > 0 ? variableAtPosition.locations : []; // Return all locations or an empty array
        }
        if (scheme == aiScriptId) {
          // Check if we're on an action
          const actionAtPosition = actionTracker.getActionsAtPosition(document, position);
          if (actionAtPosition !== null) {
            logger.debug(`References found for action: ${actionAtPosition.name}`);

            const references = actionTracker.getActionsReferences(actionAtPosition.name, document);
            const definition = actionTracker.getActionsDefinition(actionAtPosition.name, document);

            // Combine definition and references for complete list
            if (definition) {
              return [definition, ...references];
            }
            return references;
          }

          // Check if we're on a label
          const labelAtPosition = labelTracker.getLabelAtPosition(document, position);
          if (labelAtPosition !== null) {
            logger.debug(`References found for label: ${labelAtPosition.name}`);

            const references = labelTracker.getLabelReferences(labelAtPosition.name, document);
            const definition = labelTracker.getLabelDefinition(labelAtPosition.name, document);

            // Combine definition and references for complete list
            if (definition) {
              return [definition, ...references];
            }
            return references;
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
        if (variableAtPosition !== null) {
          const variableName = variableAtPosition.name;
          const variableType = variableAtPosition.type;
          const locations = variableAtPosition.locations;
          if (variableAtPosition.definition) {
            // If the variable has a definition, use its range for the rename
            locations.push(variableAtPosition.definition);
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
  logger.info('Deactivated');
}

// Helper function to calculate string similarity (Levenshtein distance based)
function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) {
    return 1.0;
  }

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1)
    .fill(null)
    .map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) {
    matrix[0][i] = i;
  }

  for (let j = 0; j <= str2.length; j++) {
    matrix[j][0] = j;
  }

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1, // deletion
          matrix[j][i - 1] + 1, // insertion
          matrix[j - 1][i - 1] + 1 // substitution
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

// Helper function to find similar items
function findSimilarItems(targetName: string, availableItems: string[], maxSuggestions: number = 5): string[] {
  const similarities = availableItems.map((item) => ({
    name: item,
    similarity: calculateSimilarity(targetName.toLowerCase(), item.toLowerCase()),
  }));

  return similarities
    .filter((item) => item.similarity > 0.3) // Only include items with > 30% similarity
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxSuggestions)
    .map((item) => item.name);
}
