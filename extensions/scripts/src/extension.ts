// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import * as path from 'path';
import * as sax from 'sax';
import { xmlTracker, ElementRange } from './xmlStructureTracker';
import { logger } from './logger';
import { XsdReference, AttributeOfElement } from './xsdReference';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
const debug = false;
let exceedinglyVerbose: boolean = false;
let rootpath: string;
let scriptPropertiesPath: string;
let extensionsFolder: string;
let languageData: Map<string, Map<string, string>> = new Map();
let xsdReference: XsdReference;

// // Extract property completion logic into a function
// function getPropertyCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
//   if (getDocumentScriptType(document) === '') {
//     return []; // Skip if the document is not valid
//   }

//   // Get the current line up to the cursor position
//   const linePrefix = document.lineAt(position).text.substring(0, position.character);

//   // First scenario: . was just typed
//   if (linePrefix.endsWith('.')) {
//     return Loc;
//   }

//   // Second scenario: We're editing an existing variable
//   // Find the last $ character before the cursor
//   const lastDollarIndex = linePrefix.lastIndexOf('$');
//   if (lastDollarIndex >= 0) {
//     // Check if we're within a variable (no whitespace or special chars between $ and cursor)
//     const textBetweenDollarAndCursor = linePrefix.substring(lastDollarIndex + 1);

//     // If this text is a valid variable name part
//     if (/^[a-zA-Z0-9_]*$/.test(textBetweenDollarAndCursor)) {
//       // Get the partial variable name we're typing (without the $)
//       const partialName = textBetweenDollarAndCursor;
//       // Get all variables and filter them by the current prefix
//       const allVariables = variableTracker.getAllVariablesForDocument(document.uri, partialName);
//       // Filter variables that match the partial name
//       return allVariables.filter((item) => item.label.toString().toLowerCase().startsWith(partialName.toLowerCase()));
//     }
//   }

//   return []; // No completions if not in a variable context
// }

// Extract variable completion logic into a function
function getVariableCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  if (getDocumentScriptType(document) === '') {
    return []; // Skip if the document is not valid
  }

  // Get the current line up to the cursor position
  const linePrefix = document.lineAt(position).text.substring(0, position.character);

  // First scenario: $ was just typed
  if (linePrefix.endsWith('$')) {
    return variableTracker.getAllVariablesForDocument(document.uri);
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
      const allVariables = variableTracker.getAllVariablesForDocument(document.uri, partialName);
      // Filter variables that match the partial name
      return allVariables.filter((item) => item.label.toString().toLowerCase().startsWith(partialName.toLowerCase()));
    }
  }

  return []; // No completions if not in a variable context
}

// Extract label completion logic into a function
function getLabelCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
  if (getDocumentScriptType(document) !== aiScript) {
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
        const allLabels = labelTracker.getAllLabelsForDocument(document.uri);

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
  if (getDocumentScriptType(document) !== aiScript) {
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
        const allActions = actionTracker.getAllActionsForDocument(document.uri);

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
const documentLanguageSubIdMap: Map<string, string> = new Map();
const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]+)/g;
const tableKeyPattern = /table\[/;
const variableTypes = {
  normal: 'usual variable',
  tableKey: 'remote or table variable',
};
const aiScript = 'aiscript';
const mdScript = 'mdscript';
const scriptTypes = {
  [aiScript]: 'AI Script',
  [mdScript]: 'Mission Director Script',
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

function findRelevantPortion(text: string) {
  const bracketPos = text.lastIndexOf('{');
  text = text.substring(bracketPos + 1).trim();
  const quotePos = text.lastIndexOf(`'`);
  text = text.substring(quotePos + 1).trim();
  const pos = text.lastIndexOf('.');
  if (pos === -1) {
    return null;
  }
  let newToken = text.substring(pos + 1).trim();
  const prevPos = Math.max(text.lastIndexOf('.', pos - 1), text.lastIndexOf(' ', pos - 1));
  const prevToken = text.substring(prevPos + 1, pos).trim();
  return [
    prevToken.indexOf('@') === 0 ? prevToken.slice(1) : prevToken,
    newToken.indexOf('@') === 0 ? newToken.slice(1) : newToken,
  ];
}

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

  addItem(items: Map<string, vscode.CompletionItem>, complete: string, info?: string): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(complete) > -1) {
      return;
    }

    if (items.has(complete)) {
      if (exceedinglyVerbose) {
        logger.info('\t\tSkipped existing completion: ', complete);
      }
      return;
    }

    const item = new vscode.CompletionItem(complete, vscode.CompletionItemKind.Property);
    item.documentation = info ? new vscode.MarkdownString(info) : undefined;

    if (exceedinglyVerbose) {
      logger.info('\t\tAdded completion: ' + complete + ' info: ' + item.detail);
    }
    items.set(complete, item);
  }

  buildType(prefix: string, typeName: string, items: Map<string, vscode.CompletionItem>, depth: number): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype', 'undefined'].indexOf(typeName) > -1) {
      return;
    }
    if (exceedinglyVerbose) {
      logger.info('Building Type: ', typeName, 'depth: ', depth, 'prefix: ', prefix);
    }
    const entry = this.typeDict.get(typeName);
    if (entry === undefined) {
      return;
    }
    if (depth > 1) {
      if (exceedinglyVerbose) {
        logger.info('\t\tMax depth reached, returning');
      }
      return;
    }

    // if (depth > -1 && prefix !== '') {
    //   this.addItem(items, typeName);
    // }

    if (items.size > 1000) {
      if (exceedinglyVerbose) {
        logger.info('\t\tMax count reached, returning');
      }
      return;
    }

    for (const prop of entry.properties.entries()) {
      this.addItem(items, prop[0], '**' + [typeName, prop[0]].join('.') + '**: ' + entry.details.get(prop[0]));
    }
    for (const literal of entry.literals.values()) {
      this.addItem(items, literal);
    }
    if (entry.supertype !== undefined) {
      if (exceedinglyVerbose) {
        logger.info('Recursing on supertype: ', entry.supertype);
      }
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

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    if (getDocumentScriptType(document) == '') {
      return undefined; // Skip if the document is not valid
    }

    // Check if we're in an attribute value for context-aware completions
    const attributeRange = xmlTracker.isInAttributeValue(document, position);
    if (attributeRange && exceedinglyVerbose) {
      logger.info(`Completion requested in attribute: ${attributeRange.elementName}.${attributeRange.name}`);
    }
    if (attributeRange === undefined) {
      return undefined; // Skip if not in an attribute value
    }

    // Check if we're in a specialized completion context (variables, labels, actions)
    let specializedCompletion = specializedCompletionContext(document, position);
    if (specializedCompletion.length > 0) {
      return specializedCompletion;
    }

    const items = new Map<string, vscode.CompletionItem>();
    const currentLine = position.line;
    const attributeValueStartLine = attributeRange.valueRange.start.line;
    let textToProcess = document.lineAt(position).text;
    if (currentLine === attributeRange.valueRange.start.line && currentLine === attributeRange.valueRange.end.line) {
      // If we're on the same line as the attribute value, use the current line text
      textToProcess = textToProcess.substring(
        attributeRange.valueRange.start.character,
        /* attributeRange.valueRange.end.character */ position.character
      );
    } else if (currentLine === attributeRange.valueRange.start.line) {
      // If we're on the start line of the attribute value, use the text from the start character to the end of the line
      textToProcess = textToProcess.substring(attributeRange.valueRange.start.character, position.character);
    } else if (currentLine === attributeRange.valueRange.end.line) {
      textToProcess = textToProcess.substring(0, /* attributeRange.valueRange.end.character */ position.character);
    }
    const interesting = findRelevantPortion(textToProcess);
    if (interesting === null) {
      if (exceedinglyVerbose) {
        logger.info('no relevant portion detected');
      }
      return this.keywordItems;
    }
    let prevToken = interesting[0];
    const newToken = interesting[1];
    if (exceedinglyVerbose) {
      logger.info('Previous token: ', interesting[0], ' New token: ', interesting[1]);
    }
    // If we have a previous token & it's in the typeDictionary or a property with type, only use that's entries
    if (prevToken !== '') {
      prevToken = this.typeDict.has(prevToken)
        ? prevToken
        : this.allProp.has(prevToken)
          ? this.allProp.get(prevToken) || ''
          : '';
      if (prevToken === undefined || prevToken === '') {
        if (exceedinglyVerbose) {
          logger.info('Missing previous token!');
        }
        return newToken.length > 0
          ? new vscode.CompletionList(
              this.defaultCompletions.items.filter((item) => item.label.startsWith(newToken)),
              true
            )
          : this.defaultCompletions;
      } else {
        if (exceedinglyVerbose) {
          logger.info(`Matching on type: ${prevToken}!`);
        }
        this.buildType('', prevToken, items, 0);
        return this.makeCompletionList(items);
      }
    }
    // Ignore tokens where all we have is a short string and no previous data to go off of
    if (prevToken === '' && newToken === '') {
      if (exceedinglyVerbose) {
        logger.info('Ignoring short token without context!');
      }
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

    if (exceedinglyVerbose) {
      logger.info('Trying fallback');
    }
    // Otherwise fall back to looking at keys of the typeDictionary for the new string
    for (const key of this.typeDict.keys()) {
      if (!key.startsWith(newToken)) {
        continue;
      }
      this.buildType('', key, items, 0);
    }
    return this.makeCompletionList(items);
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
    if (getDocumentScriptType(document) == '') {
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

class VariableTracker {
  // Map to store variables per document: Map<scriptType, Map<DocumentURI, Map<variablesType, Map<variableName, {...}>>>>
  documentVariables: Map<
    string,
    Map<
      string,
      Map<
        string,
        Map<
          string,
          {
            definition?: vscode.Location;
            definitionPriority?: number;
            locations: vscode.Location[];
          }
        >
      >
    >
  > = new Map();

  addVariable(
    type: string,
    name: string,
    scriptType: string,
    uri: vscode.Uri,
    range: vscode.Range,
    isDefinition: boolean = false,
    definitionPriority?: number
  ): void {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;

    // Get or create the scriptType level
    if (!this.documentVariables.has(scriptType)) {
      this.documentVariables.set(scriptType, new Map());
    }
    const scriptTypeMap = this.documentVariables.get(scriptType)!;

    // Get or create the document URI level
    if (!scriptTypeMap.has(uri.toString())) {
      scriptTypeMap.set(uri.toString(), new Map());
    }
    const uriMap = scriptTypeMap.get(uri.toString())!;

    // Get or create the variable type level
    if (!uriMap.has(type)) {
      uriMap.set(type, new Map());
    }
    const typeMap = uriMap.get(type)!;

    // Get or create the variable name level
    if (!typeMap.has(normalizedName)) {
      typeMap.set(normalizedName, { locations: [] });
    }
    const variableData = typeMap.get(normalizedName)!;

    // Add to locations
    variableData.locations.push(new vscode.Location(uri, range));

    // Handle definition if this is marked as one
    if (isDefinition && definitionPriority !== undefined) {
      // Only set definition if we don't have one, or if this has higher priority (lower number = higher priority)
      if (
        !variableData.definition ||
        !variableData.definitionPriority ||
        definitionPriority < variableData.definitionPriority
      ) {
        variableData.definition = new vscode.Location(uri, range);
        variableData.definitionPriority = definitionPriority;
      }
    }
  }

  getVariableDefinition(name: string, document: vscode.TextDocument): vscode.Location | undefined {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;
    const scriptType = getDocumentScriptType(document);

    // Navigate through the map levels
    const scriptTypeMap = this.documentVariables.get(scriptType);
    if (!scriptTypeMap) return undefined;

    const uriMap = scriptTypeMap.get(document.uri.toString());
    if (!uriMap) return undefined;

    // Check all variable types for this variable name
    for (const typeMap of uriMap.values()) {
      const variableData = typeMap.get(normalizedName);
      if (variableData?.definition) {
        return variableData.definition;
      }
    }

    return undefined;
  }

  getVariableLocations(type: string, name: string, document: vscode.TextDocument): vscode.Location[] {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;
    const scriptType = getDocumentScriptType(document);

    // Navigate through the map levels
    const scriptTypeMap = this.documentVariables.get(scriptType);
    if (!scriptTypeMap) return [];

    const uriMap = scriptTypeMap.get(document.uri.toString());
    if (!uriMap) return [];

    const typeMap = uriMap.get(type);
    if (!typeMap) return [];

    const variableData = typeMap.get(normalizedName);
    if (!variableData) return [];

    return variableData.locations;
  }

  getVariableAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): {
    name: string;
    type: string;
    location: vscode.Location;
    definition?: vscode.Location;
    locations: vscode.Location[];
    scriptType: string;
  } | null {
    const scriptType = getDocumentScriptType(document);

    // Navigate through the map levels
    const scriptTypeMap = this.documentVariables.get(scriptType);
    if (!scriptTypeMap) return null;

    const uriMap = scriptTypeMap.get(document.uri.toString());
    if (!uriMap) return null;

    // Check all variable types
    for (const [variableType, typeMap] of uriMap) {
      // Check all variable names
      for (const [variableName, variableData] of typeMap) {
        if (variableData.definition && variableData.definition.range.contains(position)) {
          return {
            name: variableName,
            type: variableType,
            location: variableData.definition,
            definition: variableData.definition,
            locations: variableData.locations,
            scriptType: scriptType,
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
            scriptType: scriptType,
          };
        }
      }
    }

    return null;
  }

  updateVariableName(type: string, oldName: string, newName: string, document: vscode.TextDocument): void {
    const normalizedOldName = oldName.startsWith('$') ? oldName.substring(1) : oldName;
    const normalizedNewName = newName.startsWith('$') ? newName.substring(1) : newName;
    const scriptType = getDocumentScriptType(document);

    // Navigate through the map levels
    const scriptTypeMap = this.documentVariables.get(scriptType);
    if (!scriptTypeMap) return;

    const uriMap = scriptTypeMap.get(document.uri.toString());
    if (!uriMap) return;

    const typeMap = uriMap.get(type);
    if (!typeMap) return;

    const variableData = typeMap.get(normalizedOldName);
    if (!variableData) return;

    // Move the variable data to the new name
    typeMap.set(normalizedNewName, variableData);
    typeMap.delete(normalizedOldName);
  }

  clearVariablesForDocument(uri: vscode.Uri): void {
    // Clear variables for all script types
    for (const scriptTypeMap of this.documentVariables.values()) {
      scriptTypeMap.delete(uri.toString());
    }
  }

  getAllVariablesForDocument(uri: vscode.Uri, exclude: string = ''): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    const scriptType = getDocumentScriptType(
      vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString())!
    );

    if (!scriptType) return result;

    // Navigate through the map levels
    const scriptTypeMap = this.documentVariables.get(scriptType);
    if (!scriptTypeMap) return result;

    const uriMap = scriptTypeMap.get(uri.toString());
    if (!uriMap) return result;

    // Process all variable types
    for (const [variableType, typeMap] of uriMap) {
      // Process all variables
      for (const [variableName, variableData] of typeMap) {
        if (variableName === exclude) {
          continue;
        }

        const totalLocations = variableData.locations.length;

        const item = new vscode.CompletionItem(variableName, vscode.CompletionItemKind.Variable);
        item.detail = `${scriptTypes[scriptType] || 'Script'} ${variableTypes[variableType] || 'Variable'}`;
        item.documentation = new vscode.MarkdownString(`Used ${totalLocations} time${totalLocations !== 1 ? 's' : ''}`);

        item.insertText = variableName;
        result.push(item);
      }
    }

    return result;
  }
}

const variableTracker = new VariableTracker();

class LabelTracker {
  // Map to store labels per document: Map<DocumentURI, Map<LabelName, vscode.Location>>
  documentLabels: Map<
    string,
    { scriptType: string; labels: Map<string, vscode.Location>; references: Map<string, vscode.Location[]> }
  > = new Map();

  addLabel(name: string, scriptType: string, uri: vscode.Uri, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentLabels.has(uri.toString())) {
      this.documentLabels.set(uri.toString(), {
        scriptType: scriptType,
        labels: new Map(),
        references: new Map(),
      });
    }
    const labelData = this.documentLabels.get(uri.toString())!;

    // Add the label definition location
    labelData.labels.set(name, new vscode.Location(uri, range));

    // Initialize references map if not exists
    if (!labelData.references.has(name)) {
      labelData.references.set(name, []);
    }
  }

  addLabelReference(name: string, scriptType: string, uri: vscode.Uri, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentLabels.has(uri.toString())) {
      this.documentLabels.set(uri.toString(), {
        scriptType: scriptType,
        labels: new Map(),
        references: new Map(),
      });
    }
    const labelData = this.documentLabels.get(uri.toString())!;

    // Add the reference location
    if (!labelData.references.has(name)) {
      labelData.references.set(name, []);
    }
    labelData.references.get(name)!.push(new vscode.Location(uri, range));
  }

  getLabelDefinition(name: string, document: vscode.TextDocument): vscode.Location | undefined {
    const documentData = this.documentLabels.get(document.uri.toString());
    if (!documentData) {
      return undefined;
    }
    return documentData.labels.get(name);
  }

  getLabelReferences(name: string, document: vscode.TextDocument): vscode.Location[] {
    const documentData = this.documentLabels.get(document.uri.toString());
    if (!documentData || !documentData.references.has(name)) {
      return [];
    }
    return documentData.references.get(name) || [];
  }

  getLabelAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { name: string; location: vscode.Location; isDefinition: boolean } | null {
    const documentData = this.documentLabels.get(document.uri.toString());
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

  getAllLabelsForDocument(uri: vscode.Uri): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    const documentData = this.documentLabels.get(uri.toString());
    if (!documentData) {
      return result;
    }

    // Process all labels
    for (const [name, location] of documentData.labels.entries()) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
      item.detail = `Label in ${scriptTypes[documentData.scriptType] || 'Script'}`;

      // Count references
      const referenceCount = documentData.references.get(name)?.length || 0;
      item.documentation = new vscode.MarkdownString(
        `Label \`${name}\` referenced ${referenceCount} time${referenceCount !== 1 ? 's' : ''}`
      );

      result.push(item);
    }

    return result;
  }

  clearLabelsForDocument(uri: vscode.Uri): void {
    this.documentLabels.delete(uri.toString());
  }
}

const labelTracker = new LabelTracker();

// ActionTracker class for tracking AIScript actions
class ActionTracker {
  // Map to store actions per document: Map<DocumentURI, Map<ActionName, vscode.Location>>
  documentActions: Map<
    string,
    { scriptType: string; actions: Map<string, vscode.Location>; references: Map<string, vscode.Location[]> }
  > = new Map();

  addAction(name: string, scriptType: string, uri: vscode.Uri, range: vscode.Range): void {
    // Get or create the action map for the document
    if (!this.documentActions.has(uri.toString())) {
      this.documentActions.set(uri.toString(), {
        scriptType: scriptType,
        actions: new Map(),
        references: new Map(),
      });
    }
    const actionData = this.documentActions.get(uri.toString())!;

    // Add the action definition location
    actionData.actions.set(name, new vscode.Location(uri, range));

    // Initialize references map if not exists
    if (!actionData.references.has(name)) {
      actionData.references.set(name, []);
    }
  }

  addActionReference(name: string, scriptType: string, uri: vscode.Uri, range: vscode.Range): void {
    // Get or create the action map for the document
    if (!this.documentActions.has(uri.toString())) {
      this.documentActions.set(uri.toString(), {
        scriptType: scriptType,
        actions: new Map(),
        references: new Map(),
      });
    }
    const actionData = this.documentActions.get(uri.toString())!;

    // Add the reference location
    if (!actionData.references.has(name)) {
      actionData.references.set(name, []);
    }
    actionData.references.get(name)!.push(new vscode.Location(uri, range));
  }

  getActionDefinition(name: string, document: vscode.TextDocument): vscode.Location | undefined {
    const documentData = this.documentActions.get(document.uri.toString());
    if (!documentData) {
      return undefined;
    }
    return documentData.actions.get(name);
  }

  getActionReferences(name: string, document: vscode.TextDocument): vscode.Location[] {
    const documentData = this.documentActions.get(document.uri.toString());
    if (!documentData || !documentData.references.has(name)) {
      return [];
    }
    return documentData.references.get(name) || [];
  }

  getActionAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { name: string; location: vscode.Location; isDefinition: boolean } | null {
    const documentData = this.documentActions.get(document.uri.toString());
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

  getAllActionsForDocument(uri: vscode.Uri): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    const documentData = this.documentActions.get(uri.toString());
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

  clearActionsForDocument(uri: vscode.Uri): void {
    this.documentActions.delete(uri.toString());
  }
}

const actionTracker = new ActionTracker();

// Diagnostic collection for tracking errors
let diagnosticCollection: vscode.DiagnosticCollection;

function getDocumentScriptType(document: vscode.TextDocument): string {
  let languageSubId: string = '';
  if (document.languageId !== 'xml') {
    return languageSubId; // Only process XML files
  }

  // Check if the languageSubId is already stored
  const cachedLanguageSubId = documentLanguageSubIdMap.get(document.uri.toString());
  if (cachedLanguageSubId) {
    languageSubId = cachedLanguageSubId;
    if (exceedinglyVerbose) {
      logger.info(`Using cached languageSubId: ${cachedLanguageSubId} for document: ${document.uri.toString()}`);
    }
    return languageSubId; // If cached, no need to re-validate
  }

  const text = document.getText();
  const parser = sax.parser(true); // Use strict mode for validation

  parser.onopentag = (node) => {
    // Check if the root element is <aiscript> or <mdscript>
    if ([aiScript, mdScript].includes(node.name)) {
      languageSubId = node.name; // Store the root node name as the languageSubId
      parser.close(); // Stop parsing as soon as the root element is identified
    }
  };

  try {
    parser.write(text).close();
  } catch {
    // Will not react, as we have only one possibility to get a true
  }

  if (languageSubId) {
    // Cache the languageSubId for future use
    documentLanguageSubIdMap.set(document.uri.toString(), languageSubId);
    if (exceedinglyVerbose) {
      logger.info(`Cached languageSubId: ${languageSubId} for document: ${document.uri.toString()}`);
    }
    return languageSubId;
  }

  return languageSubId;
}

function validateReferences(document: vscode.TextDocument): vscode.Diagnostic[] {
  const scriptType = getDocumentScriptType(document);
  if (scriptType !== aiScript) {
    return []; // Only validate AI scripts
  }

  const documentData = labelTracker.documentLabels.get(document.uri.toString());
  const actionData = actionTracker.documentActions.get(document.uri.toString());

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

function unTrackScriptDocument(document: vscode.TextDocument): void {
  // Clear existing data for this document
  variableTracker.clearVariablesForDocument(document.uri);
  labelTracker.clearLabelsForDocument(document.uri);
  actionTracker.clearActionsForDocument(document.uri);
  xmlTracker.clear(document);
}

function trackScriptDocument(document: vscode.TextDocument, update: boolean = false): void {
  const scriptType = getDocumentScriptType(document);
  if (scriptType == '') {
    return; // Skip processing if the document is not valid
  }
  const diagnostics: vscode.Diagnostic[] = [];

  const isXMLParsed = xmlTracker.checkDocumentParsed(document);
  if (isXMLParsed && !update) {
    logger.warn(`Document ${document.uri.toString()} is already parsed.`);
    return; // Skip if the document is already parsed
  }

  const xmlElements: ElementRange[] = xmlTracker.parseDocument(document);
  // Clear existing data for this document
  variableTracker.clearVariablesForDocument(document.uri);
  labelTracker.clearLabelsForDocument(document.uri);
  actionTracker.clearActionsForDocument(document.uri);

  // Use the XML structure to find labels, actions, and variables more efficiently
  const text = document.getText();

  // Process all elements recursively
  const processElement = (element: ElementRange) => {
    const parentName = element.parentName || '';
    const allElementAttributes = xsdReference.getAllPossibleAttributes(scriptType, element.name, parentName);
    let actualElementAttributes: AttributeOfElement;
    if (allElementAttributes.length === 1) {
      actualElementAttributes = allElementAttributes[0];
    } else if (allElementAttributes.length > 1) {
      const filteredByExisting = [];
      for (const attr of element.attributes) {
        const filtered = allElementAttributes.filter((def) => Array.from(def.attributes.keys()).includes(attr.name));
        if (filtered.length === 1) {
          actualElementAttributes = filtered[0];
          break;
        }
      }
    }
    if (!actualElementAttributes && allElementAttributes.length === 0) {
      const diagnostic = new vscode.Diagnostic(
        element.range,
        `Unknown element '${element.name}' in script type '${scriptType}'`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = 'unknown-element';
      diagnostic.source = 'X4CodeComplete';
      diagnostics.push(diagnostic);
    } else {
      if (element.name === 'label' && element.attributes.some((attr) => attr.name === 'name')) {
        const nameAttr = element.attributes.find((attr) => attr.name === 'name');
        if (nameAttr) {
          const labelName = text.substring(
            document.offsetAt(nameAttr.valueRange.start),
            document.offsetAt(nameAttr.valueRange.end)
          );
          labelTracker.addLabel(labelName, scriptType, document.uri, nameAttr.valueRange);
        }
      }

      // Handle action definitions (only for AIScript in library elements)
      if (
        scriptType === aiScript &&
        element.name === 'actions' &&
        xmlTracker.isInElementByName(document, element, 'library')
      ) {
        const nameAttr = element.attributes.find((attr) => attr.name === 'name');
        if (nameAttr) {
          const actionName = text.substring(
            document.offsetAt(nameAttr.valueRange.start),
            document.offsetAt(nameAttr.valueRange.end)
          );
          actionTracker.addAction(actionName, scriptType, document.uri, nameAttr.valueRange);
        }
      }

      const missedAttributes: Set<string> = actualElementAttributes
        ? new Set(actualElementAttributes.attributes.keys())
        : new Set();
      // Process attributes for references and variables
      element.attributes.forEach((attr) => {
        if (missedAttributes.has(attr.name)) {
          missedAttributes.delete(attr.name);
        }
        // Check for label references
        if (scriptType === aiScript && labelElementAttributeMap[element.name]?.includes(attr.name)) {
          const labelRefValue = text.substring(
            document.offsetAt(attr.valueRange.start),
            document.offsetAt(attr.valueRange.end)
          );
          labelTracker.addLabelReference(labelRefValue, scriptType, document.uri, attr.valueRange);
        }

        // Check for action references
        if (scriptType === aiScript && actionElementAttributeMap[element.name]?.includes(attr.name)) {
          const actionRefValue = text.substring(
            document.offsetAt(attr.valueRange.start),
            document.offsetAt(attr.valueRange.end)
          );
          actionTracker.addActionReference(actionRefValue, scriptType, document.uri, attr.valueRange);
        }

        // Check for variables inside attribute values
        const attrValue = text.substring(
          document.offsetAt(attr.valueRange.start),
          document.offsetAt(attr.valueRange.end)
        );

        const tableIsFound = tableKeyPattern.test(attrValue);
        let match: RegExpExecArray | null;
        const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
        let priority = -1;
        let isLValueAttribute = false;
        for (const elementAttributes of allElementAttributes) {
          isLValueAttribute =
            elementAttributes.attributes.has(attr.name) &&
            (elementAttributes.attributes.get(attr.name)?.['type'] === 'lvalueexpression' ||
              elementAttributes.attributes.get(attr.name)?.['restriction'] === 'lvalueexpression');
          if (isLValueAttribute) {
            break;
          }
        }
        if (scriptType === aiScript && isLValueAttribute) {
          if (xmlTracker.isInElementByName(document, element, 'library')) {
            priority = 10;
          } else if (xmlTracker.isInElementByName(document, element, 'init')) {
            priority = 20;
          } else if (xmlTracker.isInElementByName(document, element, 'patch')) {
            priority = 30;
          } else if (xmlTracker.isInElementByName(document, element, 'attention')) {
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
              scriptType,
              document.uri,
              new vscode.Range(start, end),
              true, // isDefinition
              priority
            );
          } else {
            variableTracker.addVariable(
              variableType,
              variableName,
              scriptType,
              document.uri,
              new vscode.Range(start, end)
            );
          }
        }
      });
      if (actualElementAttributes && missedAttributes.size > 0) {
        missedAttributes.forEach((missedAttr) => {
          if (actualElementAttributes.attributes.has(missedAttr)) {
            const use = actualElementAttributes.attributes.get(missedAttr)?.['use'] || 'unknown';
            if (use === 'required') {
              const attrType = actualElementAttributes.attributes.get(missedAttr)?.['type'] || 'unknown';
              const attrRestriction = actualElementAttributes.attributes.get(missedAttr)?.['restriction'] || 'none';
              const diagnostic = new vscode.Diagnostic(
                element.range,
                `Missing required attribute '${missedAttr}' of type '${attrType}' with restriction '${attrRestriction}'`,
                vscode.DiagnosticSeverity.Error
              );
              diagnostic.code = 'missing-required-attribute';
              diagnostic.source = 'X4CodeComplete';
              diagnostics.push(diagnostic);
            }
          }
        });
      }
    }
  };

  // Start processing from root elements
  xmlElements.forEach(processElement);

  // Validate references after tracking is complete
  diagnostics.push(...validateReferences(document));

  // Set diagnostics for the document
  diagnosticCollection.set(document.uri, diagnostics);
}

const completionProvider = new CompletionDict();
const definitionProvider = new LocationDict();

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
  if (exceedinglyVerbose) {
    logger.info('\tProperty read: ', name);
  }
  definitionProvider.addPropertyLocation(rawData, name, parent, parentType);
  completionProvider.addProperty(parent, name, prop.$.type, prop.$.result);
}

function processKeyword(rawData: string, e: Keyword) {
  const name = e.$.name;
  definitionProvider.addNonPropertyLocation(rawData, name, 'keyword');
  completionProvider.addDescription(name, e.$.description);
  if (exceedinglyVerbose) {
    logger.info('Keyword read: ' + name);
  }

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
  if (exceedinglyVerbose) {
    logger.info('Datatype read: ' + name);
  }
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

  if (debug) {
    logger.info('matchingKeyNames:', matchingKeyNames);
    logger.info('matchingDatatypes:', matchingDatatypes);
  }

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

  rootpath = config.get('unpackedFileLocation') || '';
  extensionsFolder = config.get('extensionsFolder') || '';
  exceedinglyVerbose = config.get('exceedinglyVerbose') || false;
  scriptPropertiesPath = path.join(rootpath, '/libraries/scriptproperties.xml');

  // Create diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('x4CodeComplete');
  context.subscriptions.push(diagnosticCollection);
  const xsdPaths: string[] = [/* '/libraries/common.xsd' */ '/libraries/aiscripts.xsd', '/libraries/md.xsd'];
  const schemaPaths = new Map<string, string>([
    ['aiscript', path.join(rootpath, 'libraries/aiscripts.xsd')],
    ['mdscript', path.join(rootpath, 'libraries/md.xsd')],
  ]);
  xsdReference = new XsdReference(schemaPaths);
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
    completionProvider,
    '.',
    '"',
    '{'
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
        if (getDocumentScriptType(document) == '') {
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
              if (exceedinglyVerbose) {
                logger.info(`Matched pattern: ${text}, pageId: ${pageId}, textId: ${textId}`);
              }
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

        if (getDocumentScriptType(document) == aiScript) {
          // Check for actions (only in AI scripts)
          const actionAtPosition = actionTracker.getActionAtPosition(document, position);
          if (actionAtPosition !== null) {
            const hoverText = new vscode.MarkdownString();
            const references = actionTracker.getActionReferences(actionAtPosition.name, document);

            if (actionAtPosition.isDefinition) {
              hoverText.appendMarkdown(`**AI Script Action Definition**: \`${actionAtPosition.name}\`\n\n`);
              hoverText.appendMarkdown(`Referenced ${references.length} time${references.length !== 1 ? 's' : ''}`);
            } else {
              hoverText.appendMarkdown(`**AI Script Action Reference**: \`${actionAtPosition.name}\`\n\n`);
              const definition = actionTracker.getActionDefinition(actionAtPosition.name, document);
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
          if (exceedinglyVerbose) {
            logger.info(`Hovering over variable: ${variableAtPosition.name}`);
          }
          // Generate hover text for the variable
          const hoverText = new vscode.MarkdownString();
          hoverText.appendMarkdown(
            `**${scriptTypes[variableAtPosition.scriptType] || 'Script'} ${variableTypes[variableAtPosition.type] || 'Variable'}**: \`${variableAtPosition.name}\`\n\n`
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

        if (debug) {
          logger.info('Hover word: ', hoverWord);
          logger.info('Phrase: ', phrase);
          logger.info('Sliced phrase: ', slicedPhrase);
          logger.info('Parts: ', parts);
          logger.info('First part: ', firstPart);
        }

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
    const scriptType = getDocumentScriptType(document);
    if (scriptType === '') {
      return undefined;
    }

    // Check if we're on a variable
    const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
    if (variableAtPosition !== null) {
      // For AI scripts, try to find the definition first
      if (scriptType === aiScript) {
        const definition = variableTracker.getVariableDefinition(variableAtPosition.name, document);
        if (definition) {
          if (exceedinglyVerbose) {
            logger.info(
              `Definition found for variable: ${variableAtPosition.name}: ${definition.range.start.line + 1}`
            );
            logger.info(`Locations:`, variableAtPosition.locations);
          }
          return definition;
        }
      }

      // Fallback to first occurrence - skipped
      return /* variableAtPosition.locations.length > 0 ? variableAtPosition.locations[0] : */ undefined;
    }

    if (getDocumentScriptType(document) == aiScript) {
      // Check if we're on an action (only in AI scripts)
      const actionAtPosition = actionTracker.getActionAtPosition(document, position);
      if (actionAtPosition !== null) {
        if (exceedinglyVerbose) {
          logger.info(`Definition found for action: ${actionAtPosition.name}`);
        }

        // If we're already at the definition, show references instead
        if (actionAtPosition.isDefinition) {
          const refs = actionTracker.getActionReferences(actionAtPosition.name, document);
          return refs.length > 0 ? refs[0] : undefined; // Return first reference if available
        } else {
          // If we're at a reference, show the definition
          return actionTracker.getActionDefinition(actionAtPosition.name, document);
        }
      }

      // Check if we're on a label
      const labelAtPosition = labelTracker.getLabelAtPosition(document, position);
      if (labelAtPosition !== null) {
        if (exceedinglyVerbose) {
          logger.info(`Definition found for label: ${labelAtPosition.name}`);
        }

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

  // Register variable completion provider (when $ is typed)
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      sel,
      {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
          return getVariableCompletions(document, position);
        },
      },
      '$', // Trigger character (still needed for the initial $ typing)
      '.', // Trigger character for dot completion
      '"'
    )
  );

  // Register label completion provider
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      sel,
      {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
          return getLabelCompletions(document, position);
        },
      },
      '"', // Trigger after quote in attribute
      "'" // Trigger after single quote in attribute
    )
  );

  // Register action completion provider for AIScript
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      sel,
      {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
          return getActionCompletions(document, position);
        },
      },
      '"', // Trigger after quote in attribute
      "'" // Trigger after single quote in attribute
    )
  );
  // Load configured XSD files
  xsdReference
    .initialize()
    .then(() => {
      logger.info('XSD schemas loaded successfully.'); // Instead of parsing all open documents, just parse the active one
      if (vscode.window.activeTextEditor) {
        const document = vscode.window.activeTextEditor.document;
        if (getDocumentScriptType(document)) {
          trackScriptDocument(document);
        }
      }
    })
    .catch((error) => {
      logger.error('Error loading XSD schemas:', error);
    });

  // Listen for editor changes to parse documents as they become active
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && getDocumentScriptType(editor.document)) {
        trackScriptDocument(editor.document);
      }
    })
  );

  // Keep the onDidOpenTextDocument handler for newly opened documents
  vscode.workspace.onDidOpenTextDocument((document) => {
    if (getDocumentScriptType(document)) {
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
    if (getDocumentScriptType(event.document)) {
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
            // logger.info(`Triggering suggestions for document: ${event.document.uri.toString()}`);
            vscode.commands.executeCommand('editor.action.triggerSuggest');
          }
        }
      }
    }
  });

  vscode.workspace.onDidSaveTextDocument((document) => {
    if (getDocumentScriptType(document)) {
      trackScriptDocument(document, true); // Update the document structure on save
    }
  });

  // Clear the cached languageSubId and diagnosticCollection when a document is closed
  vscode.workspace.onDidCloseTextDocument((document) => {
    documentLanguageSubIdMap.delete(document.uri.toString());
    diagnosticCollection.delete(document.uri);
    unTrackScriptDocument(document);
    if (exceedinglyVerbose) {
      logger.info(`Removed cached data for document: ${document.uri.toString()}`);
    }
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
        exceedinglyVerbose = config.get('exceedinglyVerbose') || false;

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
                const documentData = labelTracker.documentLabels.get(document.uri.toString());
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
                const actionData = actionTracker.documentActions.get(document.uri.toString());
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
        if (getDocumentScriptType(document) == '') {
          return undefined;
        }

        // Check if we're on a variable
        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
        if (variableAtPosition !== null) {
          if (exceedinglyVerbose) {
            logger.info(`References found for variable: ${variableAtPosition.name}`);
            logger.info(`Locations:`, variableAtPosition.locations);
          }
          return variableAtPosition.locations.length > 0 ? variableAtPosition.locations : []; // Return all locations or an empty array
        }
        if (getDocumentScriptType(document) == aiScript) {
          // Check if we're on an action
          const actionAtPosition = actionTracker.getActionAtPosition(document, position);
          if (actionAtPosition !== null) {
            if (exceedinglyVerbose) {
              logger.info(`References found for action: ${actionAtPosition.name}`);
            }

            const references = actionTracker.getActionReferences(actionAtPosition.name, document);
            const definition = actionTracker.getActionDefinition(actionAtPosition.name, document);

            // Combine definition and references for complete list
            if (definition) {
              return [definition, ...references];
            }
            return references;
          }

          // Check if we're on a label
          const labelAtPosition = labelTracker.getLabelAtPosition(document, position);
          if (labelAtPosition !== null) {
            if (exceedinglyVerbose) {
              logger.info(`References found for label: ${labelAtPosition.name}`);
            }

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
        if (getDocumentScriptType(document) == '') {
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

          if (exceedinglyVerbose) {
            // Debug log: Print old name, new name, and locations
            logger.info(`Renaming variable: ${variableName} -> ${newName}`); // Updated to use variableAtPosition[0]
            logger.info(`Variable type: ${variableType}`);
            logger.info(`Locations to update:`, locations);
          }
          const workspaceEdit = new vscode.WorkspaceEdit();
          locations.forEach((location) => {
            // Debug log: Print each edit
            const rangeText = location.range ? document.getText(location.range) : '';
            const replacementText = rangeText.startsWith('$') ? `$${newName}` : newName;
            if (exceedinglyVerbose) {
              logger.info(
                `Editing file: ${location.uri.fsPath}, Range: ${location.range}, Old Text: ${rangeText}, New Text: ${replacementText}`
              );
            }
            workspaceEdit.replace(location.uri, location.range, replacementText);
          });

          // Update the tracker with the new name
          variableTracker.updateVariableName(variableType, variableName, newName, document);

          return workspaceEdit;
        }

        // Debug log: No variable name found
        if (exceedinglyVerbose) {
          logger.info(`No variable name found at position: ${position}`);
        }
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
