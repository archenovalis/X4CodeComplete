import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import { getDocumentScriptType} from './scriptsMetadata';

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

export class CompletionDict {
  typeDict: Map<string, TypeEntry> = new Map<string, TypeEntry>();
  allProp: Map<string, string> = new Map<string, string>();
  allPropItems: vscode.CompletionItem[] = [];
  keywordItems: vscode.CompletionItem[] = [];
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
      const item = CompletionDict.createItem(shortProp, CompletionDict.getPropertyDescription(shortProp, type, details));
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


  private static createItem(complete: string, info: string[] = []): vscode.CompletionItem {
    const item = new vscode.CompletionItem(complete, vscode.CompletionItemKind.Property);
    if (info.length > 0) {
      item.documentation = new vscode.MarkdownString();
      for (const line of info) {
        item.documentation.appendMarkdown(line + '\n\n');
      }
    }
    return item;
  }

  private static addItem(items: Map<string, vscode.CompletionItem>, complete: string, info: string[] = []): void {
    // TODO handle better
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(complete) > -1) {
      return;
    }

    if (items.has(complete)) {
      logger.debug('\t\tSkipped existing completion: ', complete);
      return;
    }

    const item = CompletionDict.createItem(complete, info);

    logger.debug('\t\tAdded completion: ' + complete + ' info: ' + item.documentation);
    items.set(complete, item);
  }

  private static getPropertyDescription(name: string, type?: string, details?: string): string[] {
    const result: string[] = [];
    if (type) {
      result.push(`**${name}**${details ? ': ' + details : ''}`);
    }
    if (type) {
      result.push(`**Returned value type**: ${type}`);
    }
    return result;
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
      if (prefix === '' || prop[0].startsWith(prefix)) {
        CompletionDict.addItem(items, prop[0], CompletionDict.getPropertyDescription(prop[0], prop[1], entry.details.get(prop[0])));
      }
    }
    for (const literal of entry.literals.values()) {
      if (prefix === '' || literal.startsWith(prefix)) {
        // If the literal starts with the prefix, add it to the items
        CompletionDict.addItem(items, literal);
      }
    }
    if (entry.supertype !== undefined) {
      logger.debug('Recursing on supertype: ', entry.supertype);
      this.buildType(typeName, entry.supertype, items, depth /*  + 1 */);
    }
  }
  makeCompletionList(items: Map<string, vscode.CompletionItem>|vscode.CompletionItem[], prefix: string = ''): vscode.CompletionList {
    if (items instanceof Map) {
      items = Array.from(items.values());
    }
    let isIncomplete = true;
    if (items.length === 0) {
      isIncomplete = false;
    } else if (items.length === 1 && items[0].label === prefix) {
      isIncomplete = false;
      items = [];
    }
    return new vscode.CompletionList(items, isIncomplete);
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


  private static findRelevantPortion(text: string) {
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

  processText(textToProcess: string): vscode.CompletionItem[] | vscode.CompletionList | undefined {
    const items = new Map<string, vscode.CompletionItem>();
    const interesting = CompletionDict.findRelevantPortion(textToProcess);
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
        return this.makeCompletionList(newToken.length > 0
          ? this.allPropItems.filter((item) => {
              const label = typeof item.label === 'string' ? item.label : item.label.label;
              return label.startsWith(newToken);
            })
          : this.allPropItems,
            newToken
          );
      } else {
        logger.debug(`Matching on type: ${prevToken}!`);
        this.buildType(newToken, prevToken, items, 0);
        return this.makeCompletionList(items, newToken);
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

  dispose(): void {
    this.typeDict.clear();
    this.allProp.clear();
    this.allPropItems = [];
    this.keywordItems = [];
    this.descriptions.clear();
  }

}


interface XPathResult {
  $: { [key: string]: string };
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


export class LocationDict {
  dict: Map<string, vscode.Location> = new Map<string, vscode.Location>();
  private scriptPropertiesPath: string;

  constructor(scriptPropertiesPath: string) {
    this.scriptPropertiesPath = scriptPropertiesPath;
  }

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
    this.addLocation(name, this.scriptPropertiesPath, start, end);
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

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
    const schema = getDocumentScriptType(document);
    if (schema == '') {
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
    } while (relevant.length > 0);
    return undefined;
  }

  dispose(): void {
    this.dict.clear();
  }
}

export class ScriptProperties {
  private scriptPropertiesPath: string;
  private keywords: Keyword[] = [];
  private datatypes: Datatype[] = [];
  public completionDictionary: CompletionDict;
  public definitionDictionary: LocationDict;

  constructor(scriptPropertiesFolder: string) {
    this.scriptPropertiesPath = scriptPropertiesFolder;
    this.completionDictionary = new CompletionDict();
    const scriptPropertiesPath = path.join(scriptPropertiesFolder, 'scriptproperties.xml');
    this.definitionDictionary = new LocationDict(scriptPropertiesPath);
    this.readScriptProperties(scriptPropertiesPath);
  }

  dispose(): void {
    this.completionDictionary.dispose();
    this.definitionDictionary.dispose();
  }




  private readScriptProperties(filepath: string): void {
    logger.info('Attempting to read scriptproperties.xml');
    // Can't move on until we do this so use sync version
    const rawData = fs.readFileSync(filepath).toString();
    let parsedData : any;

    xml2js.parseString(rawData, (err: any, result: any) => {
      if (err !== null) {
        vscode.window.showErrorMessage('Error during parsing of scriptproperties.xml:' + err);
      }
      parsedData = result;
    });

    if (parsedData !== undefined) {
      // Process keywords and datatypes here, return the completed results
      this.keywords = this.processKeywords(rawData, parsedData['scriptproperties']['keyword']);
      this.datatypes = this.processDatatypes(rawData, parsedData['scriptproperties']['datatype']);
      this.completionDictionary.addTypeLiteral('boolean', '==false');
      logger.info('Parsed scriptproperties.xml');
    }

    this.completionDictionary.makeKeywords();
  }


  private processProperty(rawData: string, parent: string, parentType: string, prop: ScriptProperty) {
    const name = prop.$.name;
    logger.debug('\tProperty read: ', name);
    this.definitionDictionary.addPropertyLocation(rawData, name, parent, parentType);
    this.completionDictionary.addProperty(parent, name, prop.$.type, prop.$.result);
  }

  private processKeyword(rawData: string, e: Keyword) {
    const name = e.$.name;
    this.definitionDictionary.addNonPropertyLocation(rawData, name, 'keyword');
    this.completionDictionary.addDescription(name, e.$.description);
    logger.debug('Keyword read: ' + name);

    if (e.import !== undefined) {
      const imp = e.import[0];
      const src = imp.$.source;
      const select = imp.$.select;
      const tgtName = imp.property[0].$.name;
      this.processKeywordImport(name, src, select, tgtName);
    } else if (e.property !== undefined) {
      e.property.forEach((prop) => this.processProperty(rawData, name, 'keyword', prop));
    }
  }

  private processKeywordImport(name: string, src: string, select: string, targetName: string) {
    const srcPath = path.join(this.scriptPropertiesPath, src);
    logger.info('Attempting to import: ' + src);
    // Can't move on until we do this so use sync version
    const rawData = fs.readFileSync(srcPath).toString();
    let parsedData: any;
    xml2js.parseString(rawData, function (err: any, result: any) {
      if (err !== null) {
        vscode.window.showErrorMessage('Error during parsing of ' + src + err);
      }
      parsedData = result;
    });
    if (parsedData !== undefined) {
      const matches = xpath.find(parsedData, select + '/' + targetName);
      matches.forEach((element: XPathResult) => {
        this.completionDictionary.addTypeLiteral(name, element.$[targetName.substring(1)]);
      });
    }
  }



  private processDatatype(rawData: any, e: Datatype) {
    const name = e.$.name;
    this.definitionDictionary.addNonPropertyLocation(rawData, name, 'datatype');
    logger.debug('Datatype read: ' + name);
    if (e.property === undefined) {
      return;
    }
    this.completionDictionary.addType(name, e.$.type);
    e.property.forEach((prop) => this.processProperty(rawData, name, 'datatype', prop));
  }

  // Process all keywords in the XML
  private processKeywords(rawData: string, keywords: any[]): Keyword[] {
    const processedKeywords: Keyword[] = [];
    keywords.forEach((e: Keyword) => {
      this.processKeyword(rawData, e);
      processedKeywords.push(e); // Add processed keyword to the array
    });
    return processedKeywords;
  }

  // Process all datatypes in the XML
  private processDatatypes(rawData: string, datatypes: any[]): Datatype[] {
    const processedDatatypes: Datatype[] = [];
    datatypes.forEach((e: Datatype) => {
      this. processDatatype(rawData, e);
      processedDatatypes.push(e); // Add processed datatype to the array
    });
    return processedDatatypes;
  }


  public generateKeywordText(keyword: any, datatypes: Datatype[], parts: string[]): string {
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


  public processText(textToProcess: string): vscode.CompletionItem[] | vscode.CompletionList | undefined {
    return this.completionDictionary.processText(textToProcess);
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
    return this.definitionDictionary.provideDefinition(document, position);
  }

  private generateHoverWordText(hoverWord: string, keywords: Keyword[], datatypes: Datatype[]): string {
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

  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
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
      let keyword = this.keywords.find((k: Keyword) => k.$.name === firstPart);
      if (!keyword || keyword.import) {
        keyword = this.datatypes.find((d: Datatype) => d.$.name === firstPart);
      }
      if (keyword && firstPart !== hoverWord) {
        hoverText += this.generateKeywordText(keyword, this.datatypes, parts);
      }
      // Always append hover word details, ensuring full datatype properties for exact matches
      hoverText += this.generateHoverWordText(hoverWord, this.keywords, this.datatypes);
      if (hoverText === '' && parts.length > 1) {
        parts.shift();
        firstPart = parts[0].startsWith('$') || parts[0].startsWith('@') ? parts[0].slice(1) : parts[0];
      } else {
        break;
      }
    }
    return hoverText !== '' ? new vscode.Hover(hoverText) : undefined;
  }
}


function cleanStr(text: string) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(text: string) {
  // https://stackoverflow.com/a/6969486
  return  cleanStr(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}