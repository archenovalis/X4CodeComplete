// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import * as path from 'path';
import * as sax from 'sax';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
const debug = false;
let exceedinglyVerbose: boolean = false;
let rootpath: string;
let scriptPropertiesPath: string;
let extensionsFolder: string;
let languageData: Map<string, Map<string, string>> = new Map();

// Map to store languageSubId for each document
const documentLanguageSubIdMap: Map<string, string> = new Map();
const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
const tableKeyPattern = /table\[/;
const variableTypes = {
  normal: '_variable_',
  tableKey: '_remote variable_ or _table field_',
};
const scriptTypes = {
  aiscript: 'AI Script',
  mdscript: 'Mission Director Script',
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
        console.log('\t\tSkipped existing completion: ', complete);
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
      console.log('\t\tAdded completion: ' + complete + ' info: ' + result.detail);
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
      console.log('\tBuilding Property', typeName + '.' + propertyName, 'depth: ', depth, 'prefix: ', prefix);
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
      console.log('Building Type: ', typeName, 'depth: ', depth, 'prefix: ', prefix);
    }
    const entry = this.typeDict.get(typeName);
    if (entry === undefined) {
      return;
    }
    if (depth > 1) {
      if (exceedinglyVerbose) {
        console.log('\t\tMax depth reached, returning');
      }
      return;
    }

    if (depth > -1 && prefix !== '') {
      this.addItem(items, typeName);
    }

    if (items.size > 1000) {
      if (exceedinglyVerbose) {
        console.log('\t\tMax count reached, returning');
      }
      return;
    }

    for (const prop of entry.properties.entries()) {
      this.buildProperty(prefix, typeName, prop[0], prop[1], items, depth + 1);
    }
    if (entry.supertype !== undefined) {
      if (exceedinglyVerbose) {
        console.log('Recursing on supertype: ', entry.supertype);
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
    const items = new Map<string, vscode.CompletionItem>();
    const prefix = document.lineAt(position).text.substring(0, position.character);
    const interesting = findRelevantPortion(prefix);
    if (interesting === null) {
      if (exceedinglyVerbose) {
        console.log('no relevant portion detected');
      }
      return this.makeCompletionList(items);
    }
    const prevToken = interesting[0];
    const newToken = interesting[1];
    if (exceedinglyVerbose) {
      console.log('Previous token: ', interesting[0], ' New token: ', interesting[1]);
    }
    // If we have a previous token & it's in the typeDictionary, only use that's entries
    if (prevToken !== '') {
      const entry = this.typeDict.get(prevToken);
      if (entry === undefined) {
        if (exceedinglyVerbose) {
          console.log('Missing previous token!');
        }
        // TODO backtrack & search
        return;
      } else {
        if (exceedinglyVerbose) {
          console.log('Matching on type!');
        }

        entry.properties.forEach((v, k) => {
          if (exceedinglyVerbose) {
            console.log('Top level property: ', k, v);
          }
          this.buildProperty('', prevToken, k, v, items, 0);
        });
        return this.makeCompletionList(items);
      }
    }
    // Ignore tokens where all we have is a short string and no previous data to go off of
    if (prevToken === '' && newToken.length < 2) {
      if (exceedinglyVerbose) {
        console.log('Ignoring short token without context!');
      }
      return this.makeCompletionList(items);
    }
    // Now check for the special hard to complete onles
    if (prevToken.startsWith('{')) {
      if (exceedinglyVerbose) {
        console.log('Matching bracketed type');
      }
      const token = prevToken.substring(1);

      const entry = this.typeDict.get(token);
      if (entry === undefined) {
        if (exceedinglyVerbose) {
          console.log('Failed to match bracketed type');
        }
      } else {
        entry.literals.forEach((value) => {
          this.addItem(items, value + '}');
        });
      }
    }

    if (exceedinglyVerbose) {
      console.log('Trying fallback');
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
      console.log("strangely couldn't find property named:", name, 'parent:', parent);
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
}

const variableTracker = new VariableTracker();

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
      console.log(`Using cached languageSubId: ${cachedLanguageSubId} for document: ${document.uri.toString()}`);
    }
    return languageSubId; // If cached, no need to re-validate
  }

  const text = document.getText();
  const parser = sax.parser(true); // Use strict mode for validation

  parser.onopentag = (node) => {
    // Check if the root element is <aiscript> or <mdscript>
    if (node.name === 'aiscript' || node.name === 'mdscript') {
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
      console.log(`Cached languageSubId: ${languageSubId} for document: ${document.uri.toString()}`);
    }
    return languageSubId;
  }

  return languageSubId;
}

function trackVariablesInDocument(document: vscode.TextDocument): void {
  const scriptType = getDocumentScriptType(document);
  if (scriptType == '') {
    return; // Skip processing if the document is not valid
  }

  // Clear existing variable locations for this document
  variableTracker.clearVariablesForDocument(document.uri);

  const text = document.getText();
  const parser = sax.parser(true); // Create a SAX parser with strict mode enabled
  const tagStack: string[] = []; // Stack to track open tags

  let currentElementStartIndex: number | null = null;

  parser.onopentag = (node) => {
    tagStack.push(node.name); // Push the current tag onto the stack
    currentElementStartIndex = parser.startTagPosition - 1; // Start position of the element in the text

    // Check for variables in attributes
    for (const [attrName, attrValue] of Object.entries(node.attributes)) {
      let match: RegExpExecArray | null;
      let tableIsFound = false;
      if (typeof attrValue === 'string') {
        const attrStartIndex = text.indexOf(attrValue, currentElementStartIndex || 0);
        if (node.name === 'param' && tagStack[tagStack.length - 2] === 'params' && attrName === 'name') {
          // Ensure <param> is a subnode of <params>
          const variableName = attrValue;

          const start = document.positionAt(attrStartIndex);
          const end = document.positionAt(attrStartIndex + variableName.length);

          variableTracker.addVariable('normal', variableName, scriptType, document.uri, new vscode.Range(start, end));
        } else {
          tableIsFound = tableKeyPattern.test(attrValue);
          while (typeof attrValue === 'string' && (match = variablePattern.exec(attrValue)) !== null) {
            const variableName = match[1];
            const variableStartIndex = attrStartIndex + match.index;

            // Check the character preceding the '$' to ensure it's valid
            if (
              variableStartIndex == 0 ||
              (tableIsFound == false &&
                [',', '"', '[', '{', '@', ' ', '.'].includes(text.charAt(variableStartIndex - 1))) ||
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

  parser.onclosetag = () => {
    tagStack.pop(); // Pop the current tag from the stack
    currentElementStartIndex = null;
  };

  parser.onerror = (err) => {
    console.error(`Error parsing XML document: ${err.message}`);
    parser.resume(); // Continue parsing despite the error
  };

  parser.write(text).close();
}

const completionProvider = new CompletionDict();
const definitionProvider = new LocationDict();

function readScriptProperties(filepath: string) {
  console.log('Attempting to read scriptproperties.xml');
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
    console.log('Parsed scriptproperties.xml');
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
    console.log('\tProperty read: ', name);
  }
  definitionProvider.addPropertyLocation(rawData, name, parent, parentType);
  completionProvider.addProperty(parent, name, prop.$.type);
}

function processKeyword(rawData: string, e: Keyword) {
  const name = e.$.name;
  definitionProvider.addNonPropertyLocation(rawData, name, 'keyword');
  if (exceedinglyVerbose) {
    console.log('Keyword read: ' + name);
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
  console.log('Attempting to import: ' + src);
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
    console.log('Datatype read: ' + name);
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
  console.log('Loading Language Files. %s', Date.now());
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
                console.log(
                  `Loaded ${countProcessed} language files from ${tDirectories.length} 't' directories. %s`,
                  Date.now()
                );
                resolve(); // Resolve the promise when all files are processed
              }
            });
          } catch (fileError) {
            console.log(`Error reading ${file} in ${tDir}: ${fileError}`);
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
      console.log(`Error loading language files: ${error}`);
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
    console.log(`Error parsing standard language file ${filePath}: ${err.message}`);
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
    console.log('matchingKeynames:', matchingKeynames);
    console.log('matchingDatatypes:', matchingDatatypes);
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

  // Load language files and wait for completion
  loadLanguageFiles(rootpath, extensionsFolder)
    .then(() => {
      console.log('Language files loaded successfully.');
      // Proceed with the rest of the activation logic
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
                    console.log(`Matched pattern: ${text}, pageId: ${pageId}, textId: ${textId}`);
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

            const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
            if (variableAtPosition !== null) {
              if (exceedinglyVerbose) {
                console.log(`Hovering over variable: ${variableAtPosition.name}`);
              }
              // Generate hover text for the variable
              const hoverText = new vscode.MarkdownString();
              hoverText.appendMarkdown(
                `${scriptTypes[variableAtPosition.scriptType] || 'Script'} ${variableTypes[variableAtPosition.type] || 'Variable'}: \`${variableAtPosition.name}\`\n\n`
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
              console.log('Hover word: ', hoverWord);
              console.log('Phrase: ', phrase);
              console.log('Sliced phrase: ', slicedPhrase);
              console.log('Parts: ', parts);
              console.log('First part: ', firstPart);
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

      definitionProvider.provideDefinition = (document: vscode.TextDocument, position: vscode.Position) => {
        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
        if (variableAtPosition !== null) {
          if (exceedinglyVerbose) {
            console.log(`Definition found for variable: ${variableAtPosition.name}`);
            console.log(`Locations:`, variableAtPosition.locations);
          }
          return variableAtPosition.locations.length > 0 ? variableAtPosition.locations[0] : undefined; // Return the first location or undefined
        }
        return undefined;
      };

      context.subscriptions.push(
        vscode.languages.registerReferenceProvider(sel, {
          provideReferences(
            document: vscode.TextDocument,
            position: vscode.Position,
            context: vscode.ReferenceContext
          ) {
            if (getDocumentScriptType(document) == '') {
              return undefined; // Skip if the document is not valid
            }
            const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
            if (variableAtPosition !== null) {
              if (exceedinglyVerbose) {
                console.log(`References found for variable: ${variableAtPosition.name}`);
                console.log(`Locations:`, variableAtPosition.locations);
              }
              return variableAtPosition.locations.length > 0 ? variableAtPosition.locations : []; // Return all locations or an empty array
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

              if (exceedinglyVerbose) {
                // Debug log: Print old name, new name, and locations
                console.log(`Renaming variable: ${variableName} -> ${newName}`); // Updated to use variableAtPosition[0]
                console.log(`Variable type: ${variableType}`);
                console.log(`Locations to update:`, locations);
              }
              const workspaceEdit = new vscode.WorkspaceEdit();
              locations.forEach((location) => {
                // Debug log: Print each edit
                const rangeText = location.range ? document.getText(location.range) : '';
                const replacementText = rangeText.startsWith('$') ? `$${newName}` : newName;
                if (exceedinglyVerbose) {
                  console.log(
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
              console.log(`No variable name found at position: ${position}`);
            }
            return undefined;
          },
        })
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
          trackVariablesInDocument(event.document);
        }
      });

      vscode.workspace.onDidSaveTextDocument((document) => {
        if (getDocumentScriptType(document)) {
          trackVariablesInDocument(document);
        }
      });

      // Clear the cached languageSubId when a document is closed
      vscode.workspace.onDidCloseTextDocument((document) => {
        documentLanguageSubIdMap.delete(document.uri.toString());
        if (exceedinglyVerbose) {
          console.log(`Removed cached languageSubId for document: ${document.uri.toString()}`);
        }
      });
      // Track variables in all currently open documents
      vscode.workspace.textDocuments.forEach((document) => {
        if (getDocumentScriptType(document)) {
          trackVariablesInDocument(document);
        }
      });
    })
    .catch((error) => {
      console.log('Failed to load language files:', error);
    });

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('x4CodeComplete')) {
        console.log('Configuration changed. Reloading settings...');
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
          console.log('Reloading language files due to configuration changes...');
          loadLanguageFiles(rootpath, extensionsFolder)
            .then(() => {
              console.log('Language files reloaded successfully.');
            })
            .catch((error) => {
              console.log('Failed to reload language files:', error);
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
}

// this method is called when your extension is deactivated
export function deactivate() {
  console.log('Deactivated');
}
