// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import * as path from 'path';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
var debug = false;
var exceedinglyVerbose: boolean = false;
var limitLanguage: boolean = false;
var rootpath: string;
var scriptPropertiesPath: string;
var extensionsFolder: string;
let languageFiles: Map<string, any> = new Map();

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
  let pos = Math.max(text.lastIndexOf('.'), text.lastIndexOf('"', text.length - 2));
  if (pos === -1) {
    return null;
  }
  let newToken = text.substring(pos + 1);
  if (newToken.endsWith('"')) {
    newToken = newToken.substring(0, newToken.length - 1);
  }
  let prevPos = Math.max(text.lastIndexOf('.', pos - 1), text.lastIndexOf('"', pos - 1));
  // TODO something better
  if (text.length - pos > 3 && prevPos === -1) {
    return ['', newToken];
  }
  let prevToken = text.substring(prevPos + 1, pos);
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
    let k = cleanStr(key);
    var entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    if (supertype !== 'datatype') {
      entry.supertype = supertype;
    }
  }

  addTypeLiteral(key: string, val: string): void {
    let k = cleanStr(key);
    let v = cleanStr(val);
    var entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry();
      this.typeDict.set(k, entry);
    }
    entry.addLiteral(v);
  }

  addProperty(key: string, prop: string, type?: string): void {
    let k = cleanStr(key);
    var entry = this.typeDict.get(k);
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

    let result = new vscode.CompletionItem(complete);
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
    let entry = this.typeDict.get(typeName);
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
    let items = new Map<string, vscode.CompletionItem>();
    let prefix = document.lineAt(position).text.substring(0, position.character);
    let interesting = findRelevantPortion(prefix);
    if (interesting === null) {
      if (exceedinglyVerbose) {
        console.log('no relevant portion detected');
      }
      return this.makeCompletionList(items);
    }
    let prevToken = interesting[0];
    let newToken = interesting[1];
    if (exceedinglyVerbose) {
      console.log('Previous token: ', interesting[0], ' New token: ', interesting[1]);
    }
    // If we have a previous token & it's in the typeDictionary, only use that's entries
    if (prevToken !== '') {
      let entry = this.typeDict.get(prevToken);
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
      let token = prevToken.substring(1);

      let entry = this.typeDict.get(token);
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
    let range = new vscode.Range(start, end);
    let uri = vscode.Uri.parse('file://' + file);
    this.dict.set(cleanStr(name), new vscode.Location(uri, range));
  }
  addLocationForRegexMatch(rawData: string, rawIdx: number, name: string) {
    // make sure we don't care about platform & still count right https://stackoverflow.com/a/8488787
    let line = rawData.substring(0, rawIdx).split(/\r\n|\r|\n/).length - 1;
    let startIdx = Math.max(rawData.lastIndexOf('\n', rawIdx), rawData.lastIndexOf('\r', rawIdx));
    let start = new vscode.Position(line, rawIdx - startIdx);
    let endIdx = rawData.indexOf('>', rawIdx) + 2;
    let end = new vscode.Position(line, endIdx - rawIdx);
    this.addLocation(name, scriptPropertiesPath, start, end);
  }

  addNonPropertyLocation(rawData: string, name: string, tagType: string): void {
    let rawIdx = rawData.search('<' + tagType + ' name="' + escapeRegex(name) + '"[^>]*>');
    this.addLocationForRegexMatch(rawData, rawIdx, name);
  }

  addPropertyLocation(rawData: string, name: string, parent: string, parentType: string): void {
    let re = new RegExp(
      '(?:<' +
        parentType +
        ' name="' +
        escapeRegex(parent) +
        '"[^>]*>.*?)(<property name="' +
        escapeRegex(name) +
        '"[^>]*>)',
      's'
    );
    let matches = rawData.match(re);
    if (matches === null || matches.index === undefined) {
      console.log("strangely couldn't find property named:", name, 'parent:', parent);
      return;
    }
    let rawIdx = matches.index + matches[0].indexOf(matches[1]);
    this.addLocationForRegexMatch(rawData, rawIdx, parent + '.' + name);
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
    let line = document.lineAt(position).text;
    let start = line.lastIndexOf('"', position.character);
    let end = line.indexOf('"', position.character);
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

let completionProvider = new CompletionDict();
let definitionProvider = new LocationDict();

function readScriptProperties(filepath: string) {
  console.log('Attempting to read scriptproperties.xml');
  // Can't move on until we do this so use sync version
  let rawData = fs.readFileSync(filepath).toString();
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
  let name = prop.$.name;
  if (exceedinglyVerbose) {
    console.log('\tProperty read: ', name);
  }
  definitionProvider.addPropertyLocation(rawData, name, parent, parentType);
  completionProvider.addProperty(parent, name, prop.$.type);
}

function processKeyword(rawData: string, e: Keyword) {
  let name = e.$.name;
  definitionProvider.addNonPropertyLocation(rawData, name, 'keyword');
  if (exceedinglyVerbose) {
    console.log('Keyword read: ' + name);
  }

  if (e.import !== undefined) {
    let imp = e.import[0];
    let src = imp.$.source;
    let select = imp.$.select;
    let tgtName = imp.property[0].$.name;
    processKeywordImport(name, src, select, tgtName);
  } else if (e.property !== undefined) {
    e.property.forEach((prop) => processProperty(rawData, name, 'keyword', prop));
  }
}

interface XPathResult {
  $: { [key: string]: string };
}
function processKeywordImport(name: string, src: string, select: string, targetName: string) {
  let path = rootpath + '/libraries/' + src;
  console.log('Attempting to import: ' + src);
  // Can't move on until we do this so use sync version
  let rawData = fs.readFileSync(path).toString();
  xml2js.parseString(rawData, function (err: any, result: any) {
    if (err !== null) {
      vscode.window.showErrorMessage('Error during parsing of ' + src + err);
    }

    var matches = xpath.find(result, select + '/' + targetName);
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
  let name = e.$.name;
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
  let processedKeywords: Keyword[] = [];
  keywords.forEach((e: Keyword) => {
    processKeyword(rawData, e);
    processedKeywords.push(e); // Add processed keyword to the array
  });
  return processedKeywords;
}

// Process all datatypes in the XML
function processDatatypes(rawData: string, datatypes: any[]): Datatype[] {
  let processedDatatypes: Datatype[] = [];
  datatypes.forEach((e: Datatype) => {
    processDatatype(rawData, e);
    processedDatatypes.push(e); // Add processed datatype to the array
  });
  return processedDatatypes;
}

// load and parse language files
function loadLanguageFiles(basePath: string, extensionsFolder: string) {
  console.log('Loading Language Files');
  try {
    // Array to store all valid 't' directory paths
    const tDirectories: string[] = [];

    // Check root 't' directory under unpackedFileLocation
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
      const files = fs.readdirSync(tDir);
      const languageFilesFiltered = files.filter((file) => file.startsWith('0001') && file.endsWith('.xml'));

      for (const file of languageFilesFiltered) {
        const filePath = path.join(tDir, file);
        try {
          const rawData = fs.readFileSync(filePath, 'utf-8');
          xml2js.parseString(rawData, (err: any, result: any) => {
            if (err) {
              console.error(`Error parsing ${file} in ${tDir}: ${err}`);
              return;
            }
            languageFiles.set(filePath, result);
          });
        } catch (fileError) {
          console.error(`Error reading ${file} in ${tDir}: ${fileError}`);
        }
      }
    }

    console.log(`Loaded ${languageFiles.size} language files from ${tDirectories.length} 't' directories`);
  } catch (error) {
    console.error(`Error loading language files: ${error}`);
    vscode.window.showErrorMessage('Failed to load language files from t directories');
  }
}

function findLanguageText(pageId: string, textId: string): string {
  const config = vscode.workspace.getConfiguration('x4CodeComplete');
  const preferredLanguageNumber = config.get('languageNumber') || '44';
  limitLanguage = config.get('limitLanguageOutput') || false;

  interface Match {
    fileNumber: string;
    text: string;
  }
  let allMatches: Match[] = [];

  for (const [filePath, xmlData] of languageFiles) {
    // To process the diff format of the translation files
    if (!(xmlData?.language?.page || Array.isArray(xmlData?.diff?.add))) continue;

    const pages = [...(xmlData.language?.page || []), ...(xmlData.diff?.add?.flatMap((item: any) => item.page) || [])];

    const page = pages.find((p: any) => p?.$?.id === pageId);

    if (page?.t) {
      const text = page.t.find((t: any) => t?.$?.id === textId);
      if (text?._) {
        const fileName = path.basename(filePath);
        let fileNumber: string;

        console.log(`Processing filename: ${fileName}`);

        if (fileName === '0001.xml') {
          fileNumber = '*'; // Special case for 0001.xml
        } else {
          // Try matching 0001-<letter><number>.xml (e.g., 0001-l007.xml)
          const matchWithLetter = fileName.match(/0001-[a-zA-Z](\d+)\.xml$/);
          if (matchWithLetter && matchWithLetter[1]) {
            fileNumber = matchWithLetter[1].replace(/^0+/, '');
          } else {
            // Original match for 0001-<number>.xml
            const match = fileName.match(/0001-(\d+)\.xml$/);
            if (match && match[1]) {
              fileNumber = match[1].replace(/^0+/, '');
            } else {
              // Fallback for any number after 0001- or 0001
              const fallbackMatch = fileName.match(/0001-?[a-zA-Z]?(\d+)/);
              fileNumber = fallbackMatch && fallbackMatch[1] ? fallbackMatch[1].replace(/^0+/, '') : 'Unknown';
            }
          }
        }

        console.log(`Extracted fileNumber: ${fileNumber} from ${fileName}`);

        if (!limitLanguage || fileNumber == '*' || fileNumber == preferredLanguageNumber) {
          allMatches.push({
            fileNumber,
            text: text._.split('\n')
              .map((line: string) => `${fileNumber}: ${line}`)
              .join('\n'),
          });
        }
      }
    }
  }

  allMatches.sort((a, b) => {
    if (a.fileNumber === preferredLanguageNumber && b.fileNumber !== preferredLanguageNumber) return -1;
    if (b.fileNumber === preferredLanguageNumber && a.fileNumber !== preferredLanguageNumber) return 1;
    return a.fileNumber.localeCompare(b.fileNumber);
  });

  return allMatches.length > 0 ? allMatches.map((match) => match.text).join('\n\n') : '';
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
  let groupedMatches: { [key: string]: GroupedMatch } = {};

  // Process matching keywords
  matchingKeynames.forEach((k: Keyword) => {
    let header = k.$.name;

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
    let header = d.$.name;
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

  // Load language files
  loadLanguageFiles(rootpath, extensionsFolder);

  let keywords = [] as Keyword[];
  let datatypes = [] as Keyword[];
  ({ keywords, datatypes } = readScriptProperties(scriptPropertiesPath));

  let sel: vscode.DocumentSelector = { language: 'xml' };

  let disposableCompleteProvider = vscode.languages.registerCompletionItemProvider(
    sel,
    completionProvider,
    '.',
    '"',
    '{'
  );
  context.subscriptions.push(disposableCompleteProvider);

  let disposableDefinitionProvider = vscode.languages.registerDefinitionProvider(sel, definitionProvider);
  context.subscriptions.push(disposableDefinitionProvider);

  // Hover provider to display tooltips
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, {
      provideHover: async (
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.Hover | undefined> => {
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
          if (hoverText === '') {
            parts.shift();
            firstPart = parts[0].startsWith('$') || parts[0].startsWith('@') ? parts[0].slice(1) : parts[0];
          }
        }
        return hoverText !== '' ? new vscode.Hover(hoverText) : undefined;
      },
    })
  );
}

// this method is called when your extension is deactivated
export function deactivate() {}
