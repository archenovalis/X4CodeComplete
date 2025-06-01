// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import * as path from 'path';
import * as sax from 'sax';
import * as winston from 'winston';
import { OutputChannelTransport, LogOutputChannelTransport } from 'winston-transport-vscode';

const { combine, timestamp, prettyPrint, simple } = winston.format;

const outputChannel = vscode.window.createOutputChannel('X4CodeComplete', {
  log: true,
});

const logger = winston.createLogger({
  level: 'trace',
  levels: LogOutputChannelTransport.config.levels,
  format: LogOutputChannelTransport.format(),
  transports: [new LogOutputChannelTransport({ outputChannel })],
});

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
const debug = false;
let exceedinglyVerbose: boolean = false;
let rootpath: string;
let scriptPropertiesPath: string;
let extensionsFolder: string;
let languageData: Map<string, Map<string, string>> = new Map();

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
function isSpecializedCompletionContext(document: vscode.TextDocument, position: vscode.Position): boolean {
  // Check if any of the specialized completion functions return results
  const variableCompletions = getVariableCompletions(document, position);
  if (variableCompletions.length > 0) {
    return true;
  }

  const labelCompletions = getLabelCompletions(document, position);
  if (labelCompletions.length > 0) {
    return true;
  }

  const actionCompletions = getActionCompletions(document, position);
  if (actionCompletions.length > 0) {
    return true;
  }

  return false;
}

// Flag to indicate if specialized completion is active
// let isSpecializedCompletion: boolean = false;

// Map to store languageSubId for each document
const documentLanguageSubIdMap: Map<string, string> = new Map();
const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
const tableKeyPattern = /table\[/;
const variableTypes = {
  normal: '_variable_',
  tableKey: '_remote variable_ or _table field_',
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
  const pos = Math.max(text.lastIndexOf('.'), text.lastIndexOf('"', text.length - 2));
  if (pos === -1) {
    return null;
  }
  let newToken = text.substring(pos + 1);
  if (newToken.endsWith('"')) {
    newToken = newToken.substring(0, newToken.length - 1);
  }
  const prevPos = Math.max(text.lastIndexOf('.', pos - 1), text.lastIndexOf('"', pos - 1));
  // TODO something better
  if (text.length - pos > 3 && prevPos === -1) {
    return ['', newToken];
  }
  const prevToken = text.substring(prevPos + 1, pos);
  return [prevToken, newToken];
}

class TypeEntry {
  properties: Map<string, string> = new Map<string, string>();
  supertype?: string;
  literals: Set<string> = new Set<string>();
  addProperty(value: string, type: string = '') {
    this.properties.set(value, type);
  }
  addLiteral(value: string) {
    this.literals.add(value);
  }
}

class CompletionDict implements vscode.CompletionItemProvider {
  typeDict: Map<string, TypeEntry> = new Map<string, TypeEntry>();
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
    const v = cleanStr(val);
    let entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    entry.addLiteral(v);
  }

  addProperty(key: string, prop: string, type?: string): void {
    const k = cleanStr(key);
    let entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    entry.addProperty(prop, type);
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

    const result = new vscode.CompletionItem(complete);
    if (info !== undefined) {
      result.detail = info;
    } else {
      result.detail = complete;
    }
    if (exceedinglyVerbose) {
      logger.info('\t\tAdded completion: ' + complete + ' info: ' + result.detail);
    }
    items.set(complete, result);
  }
  buildProperty(
    prefix: string,
    typeName: string,
    propertyName: string,
    propertyType: string,
    items: Map<string, vscode.CompletionItem>,
    depth: number
  ) {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(propertyName) > -1) {
      return;
    }
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(typeName) > -1) {
      return;
    }
    if (exceedinglyVerbose) {
      logger.info('\tBuilding Property', typeName + '.' + propertyName, 'depth: ', depth, 'prefix: ', prefix);
    }
    let completion: string;
    if (prefix !== '') {
      completion = prefix + '.' + cleanStr(propertyName);
    } else {
      completion = propertyName;
    }
    // TODO bracket handling
    // let specialPropMatches =propertyName.match(/(?:[^{]*){[$].*}/g);
    // if (specialPropMatches !== null){
    // 	specialPropMatches.forEach(element => {
    // 		let start = element.indexOf("$")+1;
    // 		let end = element.indexOf("}", start);
    // 		let specialPropertyType = element.substring(start, end);
    // 		let newStr =  completion.replace(element, "{"+specialPropertyType+".}")
    // 		this.addItem(items, newStr);
    // 		return;
    // 	});
    // } else {
    this.addItem(items, completion, typeName + '.' + propertyName);
    this.buildType(completion, propertyType, items, depth + 1);
    // }
  }

  buildType(prefix: string, typeName: string, items: Map<string, vscode.CompletionItem>, depth: number): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(typeName) > -1) {
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

    if (depth > -1 && prefix !== '') {
      this.addItem(items, typeName);
    }

    if (items.size > 1000) {
      if (exceedinglyVerbose) {
        logger.info('\t\tMax count reached, returning');
      }
      return;
    }

    for (const prop of entry.properties.entries()) {
      this.buildProperty(prefix, typeName, prop[0], prop[1], items, depth + 1);
    }
    if (entry.supertype !== undefined) {
      if (exceedinglyVerbose) {
        logger.info('Recursing on supertype: ', entry.supertype);
      }
      this.buildType(typeName, entry.supertype, items, depth + 1);
    }
  }
  makeCompletionList(items: Map<string, vscode.CompletionItem>): vscode.CompletionList {
    return new vscode.CompletionList(Array.from(items.values()), true);
  }

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    if (getDocumentScriptType(document) == '') {
      return undefined; // Skip if the document is not valid
    }

    // Check if we're in a specialized completion context (variables, labels, actions)
    if (isSpecializedCompletionContext(document, position)) {
      return undefined; // Let the specialized providers handle it
    }

    const items = new Map<string, vscode.CompletionItem>();
    const prefix = document.lineAt(position).text.substring(0, position.character);
    const interesting = findRelevantPortion(prefix);
    if (interesting === null) {
      if (exceedinglyVerbose) {
        logger.info('no relevant portion detected');
      }
      return this.makeCompletionList(items);
    }
    const prevToken = interesting[0];
    const newToken = interesting[1];
    if (exceedinglyVerbose) {
      logger.info('Previous token: ', interesting[0], ' New token: ', interesting[1]);
    }
    // If we have a previous token & it's in the typeDictionary, only use that's entries
    if (prevToken !== '') {
      const entry = this.typeDict.get(prevToken);
      if (entry === undefined) {
        if (exceedinglyVerbose) {
          logger.info('Missing previous token!');
        }
        // TODO backtrack & search
        return;
      } else {
        if (exceedinglyVerbose) {
          logger.info('Matching on type!');
        }

        entry.properties.forEach((v, k) => {
          if (exceedinglyVerbose) {
            logger.info('Top level property: ', k, v);
          }
          this.buildProperty('', prevToken, k, v, items, 0);
        });
        return this.makeCompletionList(items);
      }
    }
    // Ignore tokens where all we have is a short string and no previous data to go off of
    if (prevToken === '' && newToken.length < 2) {
      if (exceedinglyVerbose) {
        logger.info('Ignoring short token without context!');
      }
      return this.makeCompletionList(items);
    }
    // Now check for the special hard to complete onles
    if (prevToken.startsWith('{')) {
      if (exceedinglyVerbose) {
        logger.info('Matching bracketed type');
      }
      const token = prevToken.substring(1);

      const entry = this.typeDict.get(token);
      if (entry === undefined) {
        if (exceedinglyVerbose) {
          logger.info('Failed to match bracketed type');
        }
      } else {
        entry.literals.forEach((value) => {
          this.addItem(items, value + '}');
        });
      }
    }

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
    const uri = vscode.Uri.parse('file://' + file);
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
  // Map to store variables per document and type: Map<DocumentURI, Map<VariableType, Map<VariableName, vscode.Location[]>>>
  documentVariables: Map<string, { scriptType: string; variables: Map<string, Map<string, vscode.Location[]>> }> =
    new Map();

  addVariable(type: string, name: string, scriptType: string, uri: vscode.Uri, range: vscode.Range): void {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;

    // Get or create the variable type map for the document
    if (!this.documentVariables.has(uri.toString())) {
      this.documentVariables.set(uri.toString(), { scriptType: scriptType, variables: new Map() });
    }
    const typeMap = this.documentVariables.get(uri.toString())!.variables;

    // Get or create the variable map for the type
    if (!typeMap.has(type)) {
      typeMap.set(type, new Map());
    }
    const variableMap = typeMap.get(type)!;

    // Add the variable to the map
    if (!variableMap.has(normalizedName)) {
      variableMap.set(normalizedName, []);
    }
    variableMap.get(normalizedName)?.push(new vscode.Location(uri, range));
  }

  getVariableLocations(type: string, name: string, document: vscode.TextDocument): vscode.Location[] {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;

    // Retrieve the variable type map for the document
    const documentData = this.documentVariables.get(document.uri.toString());
    if (!documentData) {
      return [];
    }

    // Retrieve the variable map for the type
    const variableMap = documentData.variables.get(type);
    if (!variableMap) {
      return [];
    }

    // Return the locations for the variable
    return variableMap.get(normalizedName) || [];
  }

  getVariableAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): {
    name: string;
    type: string;
    location: vscode.Location;
    locations: vscode.Location[];
    scriptType: string;
  } | null {
    // Retrieve the variable type map for the document
    const documentData = this.documentVariables.get(document.uri.toString());
    if (!documentData) {
      return null; // Change from [] to null
    }
    for (const [variablesType, variablesPerType] of documentData.variables) {
      for (const [variableName, variableLocations] of variablesPerType) {
        const variableLocation = variableLocations.find((loc) => loc.range.contains(position));
        if (variableLocation) {
          return {
            name: variableName,
            type: variablesType,
            location: variableLocation,
            locations: variableLocations,
            scriptType: documentData.scriptType,
          };
        }
      }
    }
    return null; // Change from [] to null
  }

  updateVariableName(type: string, oldName: string, newName: string, document: vscode.TextDocument): void {
    const normalizedOldName = oldName.startsWith('$') ? oldName.substring(1) : oldName;
    const normalizedNewName = newName.startsWith('$') ? newName.substring(1) : newName;

    // Retrieve the variable type map for the document
    const documentData = this.documentVariables.get(document.uri.toString());
    if (!documentData) {
      return;
    }

    // Retrieve the variable map for the type
    const variableMap = documentData.variables.get(type);
    if (!variableMap || !variableMap.has(normalizedOldName)) {
      return;
    }

    // Update the variable name
    const locations = variableMap.get(normalizedOldName);
    variableMap.delete(normalizedOldName);
    variableMap.set(normalizedNewName, locations || []);
  }

  clearVariablesForDocument(uri: vscode.Uri): void {
    // Remove all variables associated with the document
    this.documentVariables.delete(uri.toString());
  }

  // New method to get all variables for a document
  getAllVariablesForDocument(uri: vscode.Uri, exclude: string = ''): vscode.CompletionItem[] {
    const result: vscode.CompletionItem[] = [];
    const documentData = this.documentVariables.get(uri.toString());
    if (!documentData) {
      return result;
    }

    // Process all variable types (normal and tableKey)
    for (const [type, variablesMap] of documentData.variables) {
      for (const [name, locations] of variablesMap) {
        if (name === exclude) {
          continue; // Skip the excluded variable if it has only one location
        }
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
        item.detail = `${scriptTypes[documentData.scriptType] || 'Script'} ${variableTypes[type] || 'Variable'}`;
        item.documentation = new vscode.MarkdownString(
          `Used ${locations.length} time${locations.length !== 1 ? 's' : ''}`
        );

        // Don't include the $ in the insert text since the user has already typed it
        item.insertText = name;
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
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
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

function validateReferences(document: vscode.TextDocument): void {
  const scriptType = getDocumentScriptType(document);
  if (scriptType !== aiScript) {
    return; // Only validate AI scripts
  }

  const diagnostics: vscode.Diagnostic[] = [];
  const documentData = labelTracker.documentLabels.get(document.uri.toString());
  const actionData = actionTracker.documentActions.get(document.uri.toString());

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

  // Set diagnostics for the document
  diagnosticCollection.set(document.uri, diagnostics);
}

function trackVariablesInDocument(document: vscode.TextDocument): void {
  const scriptType = getDocumentScriptType(document);
  if (scriptType == '') {
    return; // Skip processing if the document is not valid
  }

  // Clear existing variable locations for this document
  variableTracker.clearVariablesForDocument(document.uri);
  labelTracker.clearLabelsForDocument(document.uri);
  actionTracker.clearActionsForDocument(document.uri);

  const text = document.getText();
  const parser = sax.parser(true); // Create a SAX parser with strict mode enabled
  const tagStack: string[] = []; // Stack to track open tags

  // Track if we're inside a <library> element (needed for action tracking)
  let insideLibrary = false;

  let currentElementStartIndex: number | null = null;

  parser.onopentag = (node) => {
    tagStack.push(node.name); // Push the current tag onto the stack

    // Track if we're in a library element (for action tracking)
    if (node.name === 'library') {
      insideLibrary = true;
    }

    currentElementStartIndex = parser.startTagPosition - 1; // Start position of the element in the text

    // Handle label definitions
    if (node.name === 'label' && node.attributes.name) {
      const labelName = node.attributes.name as string;
      const labelNameStartIndex = text.indexOf(labelName, currentElementStartIndex);

      if (labelNameStartIndex >= 0) {
        const start = document.positionAt(labelNameStartIndex);
        const end = document.positionAt(labelNameStartIndex + labelName.length);

        labelTracker.addLabel(labelName, scriptType, document.uri, new vscode.Range(start, end));
      }
    }

    // Handle action definitions (only within <library> element and only for AIScript)
    if (scriptType === aiScript && insideLibrary && node.name === 'actions' && node.attributes.name) {
      const actionName = node.attributes.name as string;
      const actionNameStartIndex = text.indexOf(actionName, currentElementStartIndex);

      if (actionNameStartIndex >= 0) {
        const start = document.positionAt(actionNameStartIndex);
        const end = document.positionAt(actionNameStartIndex + actionName.length);

        actionTracker.addAction(actionName, scriptType, document.uri, new vscode.Range(start, end));
      }
    }
    let validLabelAttributes;
    let validActionAttributes;
    if (scriptType === aiScript) {
      // Handle label references - check if this element+attribute combination is valid for labels
      validLabelAttributes = labelElementAttributeMap[node.name];
      // Handle action references (only for AIScript)
      validActionAttributes = actionElementAttributeMap[node.name];
      // Check for variables in attributes and label/action references
    }
    for (const [attrName, attrValue] of Object.entries(node.attributes)) {
      let match: RegExpExecArray | null;
      let tableIsFound = false;

      // Handle action and label references (only for AIScript)
      if (scriptType === aiScript) {
        if (validLabelAttributes && validLabelAttributes.includes(attrName) && typeof attrValue === 'string') {
          const labelRefValue = attrValue as string;
          const attrStartIndex = text.indexOf(labelRefValue, currentElementStartIndex || 0);

          if (attrStartIndex >= 0) {
            const start = document.positionAt(attrStartIndex);
            const end = document.positionAt(attrStartIndex + labelRefValue.length);

            labelTracker.addLabelReference(labelRefValue, scriptType, document.uri, new vscode.Range(start, end));
          }
        }

        if (validActionAttributes && validActionAttributes.includes(attrName) && typeof attrValue === 'string') {
          const actionRefValue = attrValue as string;
          const attrStartIndex = text.indexOf(actionRefValue, currentElementStartIndex || 0);

          if (attrStartIndex >= 0) {
            const start = document.positionAt(attrStartIndex);
            const end = document.positionAt(attrStartIndex + actionRefValue.length);

            actionTracker.addActionReference(actionRefValue, scriptType, document.uri, new vscode.Range(start, end));
          }
        }
      }

      if (typeof attrValue === 'string') {
        const attrStartIndex = text.indexOf(attrValue as string, currentElementStartIndex || 0);
        if (node.name === 'param' && tagStack[tagStack.length - 2] === 'params' && attrName === 'name') {
          // Ensure <param> is a subnode of <params>
          const variableName = attrValue as string;

          const start = document.positionAt(attrStartIndex);
          const end = document.positionAt(attrStartIndex + variableName.length);

          variableTracker.addVariable('normal', variableName, scriptType, document.uri, new vscode.Range(start, end));
        } else {
          tableIsFound = tableKeyPattern.test(attrValue as string);
          while (typeof attrValue === 'string' && (match = variablePattern.exec(attrValue as string)) !== null) {
            const variableName = match[1];
            const variableStartIndex = attrStartIndex + match.index;

            // Check the character preceding the '$' to ensure it's valid
            if (
              variableStartIndex == 0 ||
              (tableIsFound == false &&
                [',', '"', '[', '{', '@', ' ', '.', '('].includes(text.charAt(variableStartIndex - 1))) ||
              (tableIsFound == true && [',', ' ', '['].includes(text.charAt(variableStartIndex - 1)))
            ) {
              const start = document.positionAt(variableStartIndex);
              const end = document.positionAt(variableStartIndex + match[0].length);
              let equalIsPreceding = false;
              if (tableIsFound) {
                const equalsPattern = /=[^%,]*$/;
                const precedingText = text.substring(attrStartIndex, variableStartIndex);
                equalIsPreceding = equalsPattern.test(precedingText);
              }
              if (
                variableStartIndex == 0 ||
                (text.charAt(variableStartIndex - 1) !== '.' && (tableIsFound == false || equalIsPreceding == true))
              ) {
                variableTracker.addVariable(
                  'normal',
                  variableName,
                  scriptType,
                  document.uri,
                  new vscode.Range(start, end)
                );
              } else {
                variableTracker.addVariable(
                  'tableKey',
                  variableName,
                  scriptType,
                  document.uri,
                  new vscode.Range(start, end)
                );
              }
            }
          }
        }
      }
    }
  };

  parser.onclosetag = (name) => {
    if (name === 'library') {
      insideLibrary = false;
    }

    tagStack.pop(); // Pop the current tag from the stack
    currentElementStartIndex = null;
  };

  parser.onerror = (err) => {
    logger.error(`Error parsing XML document: ${err.message}`);
    parser.resume(); // Continue parsing despite the error
  };

  parser.write(text).close();

  // Validate references after tracking is complete
  validateReferences(document);
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

    completionProvider.addTypeLiteral('boolean', '==true');
    completionProvider.addTypeLiteral('boolean', '==false');
    logger.info('Parsed scriptproperties.xml');
  });

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
  completionProvider.addProperty(parent, name, prop.$.type);
}

function processKeyword(rawData: string, e: Keyword) {
  const name = e.$.name;
  definitionProvider.addNonPropertyLocation(rawData, name, 'keyword');
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
  const matchingKeynames = keywords.filter(
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
    logger.info('matchingKeynames:', matchingKeynames);
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
  matchingKeynames.forEach((k: Keyword) => {
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
            `Used ${variableAtPosition.locations.length} time${variableAtPosition.locations.length !== 1 ? 's' : ''}`
          );
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
      if (exceedinglyVerbose) {
        logger.info(`Definition found for variable: ${variableAtPosition.name}`);
        logger.info(`Locations:`, variableAtPosition.locations);
      }
      return variableAtPosition.locations.length > 0 ? variableAtPosition.locations[0] : undefined;
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
      relevant = relevant.substring(relevant.indexOf('.') + 1);
    } while (relevant.indexOf('.') !== -1);

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

  // Track variables in open documents
  vscode.workspace.onDidOpenTextDocument((document) => {
    if (getDocumentScriptType(document)) {
      trackVariablesInDocument(document);
    }
  });

  // Refresh variable locations when a document is edited
  vscode.workspace.onDidChangeTextDocument((event) => {
    if (getDocumentScriptType(event.document)) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || event.document !== activeEditor.document) return;

      trackVariablesInDocument(event.document);
      const cursorPos = activeEditor.selection.active;

      // Check if we're in a specialized completion context
      // Move the position one character forward if possible
      let nextPos = cursorPos;
      const line = event.document.lineAt(cursorPos.line);
      if (cursorPos.character < line.text.length) {
        nextPos = cursorPos.translate(0, 1);
      }
      if (isSpecializedCompletionContext(event.document, nextPos)) {
        // Programmatically trigger suggestions
        vscode.commands.executeCommand('editor.action.triggerSuggest');
      }
    }
  });

  vscode.workspace.onDidSaveTextDocument((document) => {
    if (getDocumentScriptType(document)) {
      trackVariablesInDocument(document);
    }
  });

  // Clear the cached languageSubId and diagnosticCollection when a document is closed
  vscode.workspace.onDidCloseTextDocument((document) => {
    documentLanguageSubIdMap.delete(document.uri.toString());
    diagnosticCollection.delete(document.uri);
    if (exceedinglyVerbose) {
      logger.info(`Removed cached languageSubId for document: ${document.uri.toString()}`);
    }
  });

  // Track variables in all currently open documents
  vscode.workspace.textDocuments.forEach((document) => {
    if (getDocumentScriptType(document)) {
      trackVariablesInDocument(document);
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
