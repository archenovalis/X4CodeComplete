import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as xpath from 'xml2js-xpath';
import { getDocumentScriptType, aiScriptId, mdScriptId } from './scriptsMetadata';
import { getNearestBreakSymbolIndexForExpressions, getSubStringByBreakSymbolForExpressions } from './scriptUtilities';
import { XsdReference } from 'xsd-lookup';

class PropertyEntry {
  name: string;
  type?: string;
  details?: string;
  owner?: TypeEntry | KeywordEntry;
  constructor(name: string, type?: string, details?: string, owner?: TypeEntry | KeywordEntry) {
    this.name = name;
    this.type = type;
    this.details = details;
    this.owner = owner;
  }
  public getDescription(): string[] {
    const result: string[] = [];
    result.push(`**${this.name}**${this.details ? ': ' + this.details + '' : ''}`);
    if (this.owner) {
      result.push(`*Property of*: **${this.owner.name}**`);
    }
    if (this.type) {
      result.push(`*Returned value type*: \`${this.type}\``);
    }
    return result;
  }

  public putAsCompletionItem(items: Map<string, vscode.CompletionItem>, range?: vscode.Range) {
    if (['', 'boolean', 'int', 'string', 'list', 'datatype'].indexOf(this.name) > -1) {
      return;
    }

    if (items.has(this.name)) {
      logger.debug('\t\tSkipped existing completion: ', this.name);
      return;
    }

    const item = new vscode.CompletionItem(this.name, vscode.CompletionItemKind.Property);
    if (this.getDescription().length > 0) {
      item.documentation = new vscode.MarkdownString(this.getDescription().join('  \n- '));
    }
    if (range) {
      item.range = range;
    }

    logger.debug('\t\tAdded completion: ' + this.name + ' info: ' + item.documentation);
    items.set(this.name, item);
  }
}

class TypeEntry {
  public name: string;
  public properties: Map<string, PropertyEntry> = new Map<string, PropertyEntry>();
  public supertype?: TypeEntry;
  public suffix?: string;

  constructor(name: string, supertype?: TypeEntry, suffix?: string) {
    this.name = name;
    this.supertype = supertype;
    this.suffix = suffix;
  }

  public addProperty(value: string, type: string = '', details: string = '') {
    this.properties.set(value, new PropertyEntry(value, type, details, this));
  }

  public getProperties(): Map<string, PropertyEntry> {
    return new Map(Array.from(this.properties.entries()).concat(Array.from(this.supertype ? this.supertype.getProperties().entries() : [])));
  }

  public hasProperty(name: string): boolean {
    if (this.properties.has(name)) {
      return true;
    }
    return this.supertype ? this.supertype.hasProperty(name) : false;
  }

  public getProperty(name: string): PropertyEntry | undefined {
    if (this.properties.has(name)) {
      return this.properties.get(name);
    } else {
      const filtered = this.filterPropertiesByPrefix(name, true);
      if (filtered.length === 1 && name.split('.').length === filtered[0].name.split('.').length) {
        return filtered[0];
      }
    }
    return this.supertype ? this.supertype.getProperty(name) : undefined;
  }

  public filterPropertiesByPrefix(prefix: string, appendDot: boolean = true): PropertyEntry[] {
    const result: PropertyEntry[] = [];
    const workingPrefix = appendDot && !prefix.endsWith('.') ? prefix + '.' : prefix;
    const prefixSplitted = prefix.split('.');
    const countItems = prefixSplitted.length;
    for (const [name, prop] of this.getProperties()) {
      if (name.startsWith(workingPrefix)) {
        result.push(prop);
      } else {
        const nameSplitted = name.split('.');
        if (nameSplitted.length >= countItems) {
          const maxItems = appendDot ? countItems : countItems - 1;
          let i = 0;
          let matched = true;
          for (i = 0; i < maxItems; i++) {
            if (
              prefixSplitted[i] !== nameSplitted[i] &&
              (prefixSplitted[i].length <= 2 ||
                nameSplitted[i].length <= 2 ||
                !prefixSplitted[i].startsWith('{') ||
                !nameSplitted[i].startsWith('{') ||
                !prefixSplitted[i].endsWith('}') ||
                !nameSplitted[i].endsWith('}'))
            ) {
              // If the parts do not match, break
              matched = false;
              break;
            }
          }
          if (matched) {
            // If the last part matches and there are more parts, add it
            result.push(prop);
          }
        }
      }
    }
    return result;
  }

  public getDescription(): string[] {
    const result: string[] = [];
    result.push(`*DataType*: **${this.name}**${this.supertype ? '. *Based on*: **' + this.supertype + '**.' : ''}`);
    return result;
  }

  public prepareItems(prefix: string, items: Map<string, vscode.CompletionItem>, range?: vscode.Range): void {
    if (['', 'boolean', 'int', 'string', 'list', 'datatype', 'undefined'].indexOf(this.name) > -1) {
      return;
    }
    logger.debug('Building Type: ', this.name, 'prefix: ', prefix);

    if (items.size > 1000) {
      logger.warning('\t\tMax count reached, returning');
      return;
    }

    for (const prop of this.getProperties().entries()) {
      if (prefix === '' || prop[0].startsWith(prefix)) {
        prop[1].putAsCompletionItem(items, range);
      }
    }
  }
}

class KeywordEntry extends TypeEntry {
  public details?: string;
  public script?: string;
  constructor(name: string, supertype?: TypeEntry, script?: string, details?: string) {
    super(name, supertype);
    if (script) {
      this.script = script === 'md' ? mdScriptId : aiScriptId;
    }
    this.details = details;
  }

  public getDescription(): string[] {
    const result: string[] = [];
    result.push(`**${this.name}**${this.details ? ': *' + this.details + '*' : ''}`);
    return result;
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
    script?: string;
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
            ignoreprefix?: string;
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

export class ScriptProperties {
  private static readonly typesToIgnore: string[] = ['undefined', 'expression'];
  private static readonly regexLookupElement = /<([^>]+)>/;
  // Removed the incorrect lookup mapping for class->classlookup

  private xsdReference: XsdReference;
  private librariesFolder: string;
  private scriptPropertiesPath: string;
  private keywords: Keyword[] = [];
  private datatypes: Datatype[] = [];
  private dict: Map<string, vscode.Location> = new Map<string, vscode.Location>();
  private typeDict: Map<string, TypeEntry> = new Map<string, TypeEntry>();
  private keywordList: KeywordEntry[] = [];
  private allProp: Map<string, string[]> = new Map<string, string[]>();
  private keywordItems: vscode.CompletionItem[] = [];
  private descriptions: Map<string, string> = new Map<string, string>();

  constructor(librariesFolder: string, xsdReference: XsdReference) {
    this.librariesFolder = librariesFolder;
    this.scriptPropertiesPath = path.join(librariesFolder, 'scriptproperties.xml');
    this.xsdReference = xsdReference;
    this.readScriptProperties(this.scriptPropertiesPath);
  }

  dispose(): void {
    this.keywords = [];
    this.datatypes = [];
    this.dict.clear();
    this.typeDict.clear();
    this.keywordList = [];
    this.allProp.clear();
    this.keywordItems = [];
    this.descriptions.clear();
  }

  private readScriptProperties(filepath: string): void {
    logger.info('Attempting to read scriptproperties.xml');
    // Can't move on until we do this so use sync version
    const rawData = fs.readFileSync(filepath).toString();
    let parsedData: any;

    xml2js.parseString(rawData, (err: any, result: any) => {
      if (err !== null) {
        vscode.window.showErrorMessage('Error during parsing of scriptproperties.xml:' + err);
      }
      parsedData = result;
    });

    if (parsedData !== undefined) {
      // Process keywords and datatypes here, return the completed results
      this.datatypes = this.processDatatypes(rawData, parsedData['scriptproperties']['datatype']);
      this.keywords = this.processKeywords(rawData, parsedData['scriptproperties']['keyword']);
      // this.addTypeLiteral('boolean', '==false');
      logger.info('Parsed scriptproperties.xml');
    }

    this.makeKeywords();
  }

  private processProperty(rawData: string, parent: string, parentType: string, prop: ScriptProperty, script?: string) {
    const name = prop.$.name;
    logger.debug('\tProperty read: ', name);
    this.addPropertyLocation(rawData, name, parent, parentType);
    if (parentType === 'keyword') {
      this.addKeywordProperty(parent, name, script, prop.$.type || '', prop.$.result);
    } else {
      this.addTypeProperty(parent, name, prop.$.type || '', prop.$.result);
    }
  }

  private processKeyword(rawData: string, e: Keyword) {
    const name = e.$.name;
    this.addNonPropertyLocation(rawData, name, 'keyword');
    const type = this.typeDict.get(e.$.type || '');
    this.addKeyword(name, type, e.$.script, e.$.description);
    logger.debug('Keyword read: ' + name);

    if (e.import !== undefined) {
      const imp = e.import[0];
      const src = imp.$.source;
      const select = imp.$.select;
      const tgtName = imp.property[0].$.name;
      const ignorePrefix = imp.property[0].$.ignoreprefix === 'true';
      this.processKeywordImport(name, src, select, tgtName, e.$.script, ignorePrefix);
    } else if (e.property !== undefined) {
      e.property.forEach((prop) => this.processProperty(rawData, name, 'keyword', prop, e.$.script));
    }
  }

  private processKeywordImport(name: string, src: string, select: string, targetName: string, script?: string, ignorePrefix: boolean = false) {
    const srcPath = path.join(this.librariesFolder, src);
    logger.info(`Attempting to import '${name}' via select: "${select}" and target: "${targetName}" from ${src}`);
    // Can't move on until we do this so use sync version
    const rawData = fs.readFileSync(srcPath).toString();
    let parsedData: any;
    xml2js.parseString(rawData, function (err: any, result: any) {
      if (err !== null) {
        vscode.window.showErrorMessage(`Error during parsing of ${src}: ${err}`);
      }
      parsedData = result;
    });
    if (parsedData !== undefined) {
      let matches: XPathResult[] = [];

      // Check if the select query contains 'or' operator and split it
      if (select.includes(' or ')) {
        matches = this.handleComplexXPathQuery(parsedData, select, targetName);
      } else {
        // Handle simple query as before
        matches = xpath.find(parsedData, select + '/' + targetName);
      }

      if (matches.length > 0) {
        matches.forEach((element: XPathResult) => {
          this.addKeywordProperty(name, element.$[targetName.substring(1)], script, '', element.$['comment'], ignorePrefix);
        });
      } else if (name === 'class') {
        const xsdEnums = this.xsdReference.getSimpleTypeEnumerationValues(src.replace('.xsd', ''), name + 'lookup');
        if (xsdEnums) {
          for (const enumValue of xsdEnums.values) {
            this.addKeywordProperty(name, enumValue, script, '', xsdEnums.annotations.get(enumValue) || '', ignorePrefix);
          }
        }
      } else {
        logger.warn('No matches found for import: ' + select + '/' + targetName + ' in ' + src);
      }
    }
  }

  /**
   * Handles complex XPath queries that contain 'or' operators by splitting them into simpler queries
   * @param parsedData The parsed XML data
   * @param select The XPath select string that may contain 'or' operators
   * @param targetName The target attribute or element name
   * @returns Array of matching XPath results
   */
  private handleComplexXPathQuery(parsedData: any, select: string, targetName: string): XPathResult[] {
    const allMatches: XPathResult[] = [];

    try {
      // Split complex XPath queries containing 'or' operator
      // Example: "/scriptproperties/datatype[@type='enum' or @type='dbdata']"
      // becomes: ["/scriptproperties/datatype[@type='enum']", "/scriptproperties/datatype[@type='dbdata']"]

      const orSplitQueries = this.splitXPathOrQuery(select);

      for (const query of orSplitQueries) {
        logger.debug(`Processing split query: ${query}/${targetName}`);
        const matches = xpath.find(parsedData, query + '/' + targetName);
        allMatches.push(...matches);
      }

      logger.debug(`Total matches found from ${orSplitQueries.length} split queries: ${allMatches.length}`);
    } catch (error) {
      logger.error('Error processing complex XPath query:', error);
      // Fallback: try the original query as-is
      try {
        const fallbackMatches = xpath.find(parsedData, select + '/' + targetName);
        allMatches.push(...fallbackMatches);
      } catch (fallbackError) {
        logger.error('Fallback query also failed:', fallbackError);
      }
    }

    return allMatches;
  }

  /**
   * Splits an XPath query containing 'or' operators into multiple simpler queries
   * @param xpathQuery The XPath query string to split
   * @returns Array of simpler XPath query strings
   */
  private splitXPathOrQuery(xpathQuery: string): string[] {
    const queries: string[] = [];

    // Handle queries like "/scriptproperties/datatype[@type='enum' or @type='dbdata']"
    const orPattern = /\[(.*?)\]/g;
    let match;

    while ((match = orPattern.exec(xpathQuery)) !== null) {
      const predicateContent = match[1];

      if (predicateContent.includes(' or ')) {
        // Split the predicate on ' or '
        const orConditions = predicateContent.split(' or ').map((condition) => condition.trim());

        // Create separate queries for each condition
        for (const condition of orConditions) {
          const newQuery = xpathQuery.replace(match[0], `[${condition}]`);
          queries.push(newQuery);
        }

        return queries; // Return early for the first 'or' found
      }
    }

    // If no 'or' operator found, return the original query
    if (queries.length === 0) {
      queries.push(xpathQuery);
    }

    return queries;
  }

  private processDatatype(rawData: any, e: Datatype) {
    const name = e.$.name;
    this.addNonPropertyLocation(rawData, name, 'datatype');
    logger.debug('Datatype read: ' + name);
    if (e.property === undefined) {
      return;
    }
    this.addType(name, e.$.type, e.$.suffix);
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
      this.processDatatype(rawData, e);
      processedDatatypes.push(e); // Add processed datatype to the array
    });
    return processedDatatypes;
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
    const re = new RegExp('(?:<' + parentType + ' name="' + escapeRegex(parent) + '"[^>]*>.*?)(<property name="' + escapeRegex(name) + '"[^>]*>)', 's');
    const matches = rawData.match(re);
    if (matches === null || matches.index === undefined) {
      logger.info("strangely couldn't find property named:", name, 'parent:', parent);
      return;
    }
    const rawIdx = matches.index + matches[0].indexOf(matches[1]);
    this.addLocationForRegexMatch(rawData, rawIdx, parent + '.' + name);
  }

  addType(key: string, supertype?: string, suffix?: string): void {
    const k = cleanStr(key);
    let entry = this.typeDict.get(k);
    if (entry === undefined && k !== 'datatype') {
      entry = new TypeEntry(k, supertype ? this.typeDict.get(cleanStr(supertype)) : undefined, suffix);
      this.typeDict.set(k, entry);
    }
  }

  addKeyword(key: string, type?: TypeEntry, script?: string, details?: string): void {
    const k = cleanStr(key);
    let entry = this.getKeyword(k, script || '');
    if (entry === undefined) {
      entry = new KeywordEntry(k, type, script, details);
      this.keywordList.push(entry);
    }
  }

  addTypeLiteral(key: string, val: string): void {
    const k = cleanStr(key);
    let v = cleanStr(val);
    if (v.indexOf(k) === 0) {
      v = v.slice(k.length + 1);
    }
    if (!this.typeDict.has(k)) {
      this.addType(k);
    }
    const entry = this.typeDict.get(k);
    if (entry === undefined) {
      return;
    }
    // entry.addLiteral(v);
  }

  addTypeProperty(key: string, prop: string, type?: string, details?: string): void {
    const k = cleanStr(key);
    if (!this.typeDict.has(k)) {
      this.addType(k);
    }
    const entry = this.typeDict.get(k);
    if (entry === undefined) {
      return;
    }
    entry.addProperty(prop, type, details);
    const shortProp = prop.split('.')[0];
    this.addToAllProp(shortProp, key);
  }

  addKeywordProperty(key: string, prop: string, script?: string, type?: string, details?: string, ignorePrefix: boolean = false): void {
    const k = cleanStr(key);

    const entry = this.getKeyword(k, script || '');
    if (entry === undefined) {
      return;
    }
    if (ignorePrefix && prop.startsWith(k + '.')) {
      prop = prop.substring(k.length + 1);
    }
    entry.addProperty(prop, type, details);
  }

  addToAllProp(value: string, type: string): void {
    const v = cleanStr(value);
    if ('$&<[{'.indexOf(v.slice(0, 1)) === -1) {
      const types = this.allProp.get(v);
      if (types && types.includes(type)) {
        return;
      } else if (types) {
        types.push(type);
      } else {
        this.allProp.set(v, [type]);
      }
      // const item = ScriptProperties.createItem(v, ScriptProperties.getPropertyDescription(v, type));
      // this.allPropItems.push(item);
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

  private static createItem(
    complete: string,
    info: string[] = [],
    kind: vscode.CompletionItemKind = vscode.CompletionItemKind.Property
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(complete, kind);
    if (info.length > 0) {
      item.documentation = new vscode.MarkdownString(info.join('  \n- '));
    }
    return item;
  }

  private getPropertyDescriptionMultipleTypes(name: string, types: string[]): string[] {
    const result: string[] = [`Properties prefixed by **${name}** are in the following types:`];
    for (const type of types) {
      if (this.typeDict.has(type)) {
        result.push(...(this.typeDict.get(type)?.getDescription() || []));
      }
    }
    return result;
  }

  private getKeywords(schema: string): KeywordEntry[] {
    return this.keywordList.filter((entry) => !entry.script || entry.script === schema);
  }

  private getKeyword(name: string, schema: string): KeywordEntry | undefined {
    return this.keywordList.find((entry) => entry.name === name && (!entry.script || entry.script === schema));
  }

  private makeCompletionList(items: Map<string, vscode.CompletionItem> | vscode.CompletionItem[], prefix: string = ''): vscode.CompletionList {
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

  private makeKeywords(): void {
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
    return [prevToken.indexOf('@') === 0 ? prevToken.slice(1) : prevToken, newToken.indexOf('@') === 0 ? newToken.slice(1) : newToken];
  }

  private generateKeywordText(keyword: any, datatypes: Datatype[], parts: string[]): string {
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
            hoverText += `  \n- ${name}.${property.$.name}: ${property.$.result}`;
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

  public makeCompletionsFromExpression(
    textToProcessBefore: string,
    textToProcessAfter: string,
    type: string,
    schema: string,
    position: vscode.Position
  ): vscode.CompletionList {
    logger.debug('Processing expression: ', textToProcessBefore, ' Type: ', type, ' Schema: ', schema);

    // Clean the input text
    textToProcessBefore = getSubStringByBreakSymbolForExpressions(textToProcessBefore, true);

    // Use step-by-step analysis
    const completions = this.analyzeExpressionStepByStep(textToProcessBefore, schema);

    return this.makeCompletionList(completions);
  }

  /**
   * Step-by-step expression analysis as specified:
   * Each part is either "identified & completed" or "identified & not completed"
   * Tracks contentType through the analysis
   */
  private analyzeExpressionStepByStep(expression: string, schema: string): Map<string, vscode.CompletionItem> {
    const items = new Map<string, vscode.CompletionItem>();

    // Split expression into parts (empty parts are valid and should be processed)
    const parts = expression.split('.');

    logger.warn(`Analyzing expression: "${expression}" -> parts: [${parts.map((p) => `"${p}"`).join(', ')}]`);
    console.log(`Analyzing expression: "${expression}" -> parts: [${parts.map((p) => `"${p}"`).join(', ')}]`);

    if (parts.length === 0) {
      return items;
    }

    // Step 1: First part must be a keyword
    const firstPart = parts[0];
    const keyword = this.getKeyword(firstPart, schema);

    if (!keyword) {
      // First part not found as keyword - provide keyword suggestions
      logger.debug(`First part "${firstPart}" not found as keyword, providing keyword suggestions`);
      this.addKeywordCompletions(items, firstPart, schema);
      return items;
    }

    logger.debug(`First part "${firstPart}" identified as keyword, type: ${keyword.name || 'none'}`);

    // First part is identified and completed
    if (parts.length === 1) {
      // Only one part - this means no completion is requested (no dot at end)
      // Return empty completions
      logger.debug(`Single part "${firstPart}" - no completion requested, returning empty`);
      return items;
    }

    // Continue with property steps
    let currentContentType: KeywordEntry | TypeEntry = keyword;
    let prefix = '';

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;

      logger.debug(`Property step ${i}: part="${part}", isLast=${isLastPart}, prefix="${prefix}", contentType="${currentContentType.name}"`);

      const result = this.analyzePropertyStep(part, currentContentType, prefix, isLastPart, schema);

      if (result.completions) {
        // Add completions and stop analysis
        for (const [key, value] of result.completions) {
          items.set(key, value);
        }
        break;
      }

      if (result.isCompleted) {
        // Part was completed, update contentType and continue
        currentContentType = result.newContentType!;
        prefix = ''; // Reset prefix for clean property step
        logger.debug(`Part "${part}" completed, new contentType: "${currentContentType.name}"`);
      } else {
        // Part is identified but not completed - add to prefix and continue
        prefix = prefix ? `${prefix}.${part}` : part;
        logger.debug(`Part "${part}" not completed, updated prefix: "${prefix}"`);
      }
    }

    return items;
  }

  /**
   * Analyzes a single property step
   */
  private analyzePropertyStep(
    part: string,
    contentType: KeywordEntry | TypeEntry,
    prefix: string,
    isLastPart: boolean,
    schema: string
  ): {
    isCompleted: boolean;
    completions?: Map<string, vscode.CompletionItem>;
    newContentType?: KeywordEntry | TypeEntry;
  } {
    const fullContentOnStep = prefix ? `${prefix}.${part}` : part;

    // Try to find exact property match
    if (contentType.hasProperty(fullContentOnStep)) {
      const property = contentType.getProperty(fullContentOnStep)!;
      logger.debug(`Found exact property: "${fullContentOnStep}", type: "${property.type}"`);

      if (isLastPart) {
        // Last part and found - provide next level completions if property has a type
        const completions = new Map<string, vscode.CompletionItem>();
        if (property.type) {
          const typeEntry = this.typeDict.get(property.type);
          if (typeEntry) {
            typeEntry.prepareItems('', completions);
          }
        }
        return { isCompleted: true, completions };
      } else {
        // Not last part - continue with the property's type
        const newContentType = property.type ? this.typeDict.get(property.type) : undefined;
        if (newContentType) {
          return { isCompleted: true, newContentType };
        } else {
          // Property has no type - can't continue
          return { isCompleted: false };
        }
      }
    }

    // Property not found exactly - try filtering by prefix
    const filteredProperties = contentType.filterPropertiesByPrefix(fullContentOnStep, true);

    if (filteredProperties.length > 0) {
      logger.debug(`Found ${filteredProperties.length} properties with prefix "${fullContentOnStep}"`);

      if (!isLastPart) {
        // Not last part - this is a complex property, continue with same contentType
        return { isCompleted: false };
      }
    }

    // No properties found
    if (isLastPart) {
      // Last part and nothing found - try without dot one more time
      const candidateProperties = contentType.filterPropertiesByPrefix(fullContentOnStep, false);
      if (candidateProperties.length > 0) {
        const completions = this.generateCompletionsFromProperties(candidateProperties, fullContentOnStep, schema);
        return { isCompleted: false, completions };
      }
    }

    // Nothing found - error case
    return { isCompleted: false };
  }

  /**
   * Generates completions from filtered properties by removing prefix and suffixes
   */
  private generateCompletionsFromProperties(properties: PropertyEntry[], fullContentOnStep: string, schema?: string): Map<string, vscode.CompletionItem> {
    const items = new Map<string, vscode.CompletionItem>();
    const uniqueCompletions = new Set<string>();

    const contentParts = fullContentOnStep.split('.');
    const contentPartsCount = contentParts.length;
    const completionPosition = contentPartsCount - 1; // Exclude the last part

    for (const property of properties) {
      const nameSplitted = property.name.split('.');

      if (nameSplitted.length >= contentPartsCount) {
        const completion = nameSplitted[completionPosition];

        // Check if completion contains placeholder pattern like <classname>
        const placeholderMatch = completion?.match(ScriptProperties.regexLookupElement);

        if (placeholderMatch && schema) {
          // Expand placeholder to actual keyword values
          this.expandPlaceholderInCompletion(completion, property, placeholderMatch[1], schema, items, uniqueCompletions);
        } else if (completion) {
          // Add regular completion
          if (!uniqueCompletions.has(completion)) {
            uniqueCompletions.add(completion);

            const item = ScriptProperties.createItem(completion, property.getDescription(), vscode.CompletionItemKind.Property);
            items.set(completion, item);
          } else {
            const item = items.get(completion);
            if (item) {
              // Add property description if available
              const description = property.getDescription();
              if (description.length > 0) {
                // Ensure documentation exists
                if (!item.documentation) {
                  item.documentation = new vscode.MarkdownString('');
                }

                const docString = item.documentation as vscode.MarkdownString;
                if (!docString.value.includes('part of')) {
                  const newDoc = new vscode.MarkdownString(`**${completion}** is a part of *"complex" property*:\n\n`);
                  newDoc.appendMarkdown('* ' + docString.value.split('  \n- ').join('  \n  - ').concat('\n\n'));
                  item.documentation = newDoc;
                }
                (item.documentation as vscode.MarkdownString).appendMarkdown('* ' + description.join('  \n  - ').concat('\n\n'));
              }
            }
          }
        }
      }
    }

    logger.debug(`Generated ${items.size} unique completions from ${properties.length} properties`);
    return items;
  }

  /**
   * Adds keyword completions that match the given prefix
   */
  private addKeywordCompletions(items: Map<string, vscode.CompletionItem>, prefix: string, schema: string): void {
    const keywords = this.getKeywords(schema);
    for (const keyword of keywords) {
      if (keyword.name.toLowerCase().startsWith(prefix.toLowerCase())) {
        const item = ScriptProperties.createItem(keyword.name, keyword.getDescription(), vscode.CompletionItemKind.Keyword);
        items.set(keyword.name, item);
      }
    }
  }

  /**
   * Expands a placeholder in completion (like <classname>) to actual keyword values
   */
  private expandPlaceholderInCompletion(
    completion: string,
    property: PropertyEntry,
    placeholderName: string,
    schema: string,
    items: Map<string, vscode.CompletionItem>,
    uniqueCompletions: Set<string>
  ): void {
    logger.debug(`Expanding placeholder <${placeholderName}> in completion "${completion}"`);

    // Extract the keyword name from the property's result attribute
    const keywordName = this.extractKeywordFromPropertyResult(property.details || '', placeholderName);

    logger.debug(`Extracted keyword name: "${keywordName}" from details: "${property.details}"`);

    if (!keywordName) {
      logger.debug(`Could not extract keyword for placeholder <${placeholderName}>`);
      return;
    }

    // Get the keyword entry
    const keyword = this.getKeyword(keywordName, schema);
    logger.debug(`Keyword "${keywordName}" found: ${keyword ? 'YES' : 'NO'}`);

    if (!keyword) {
      logger.debug(`Keyword "${keywordName}" not found for placeholder <${placeholderName}>`);
      return;
    }

    // Get all properties from the keyword
    const keywordProperties = keyword.getProperties();
    logger.debug(`Keyword "${keywordName}" has ${keywordProperties.size} properties`);

    let expandedCount = 0;
    for (const [propName, _] of keywordProperties) {
      // Replace the placeholder with the actual property name
      const expandedCompletion = completion.replace(`<${placeholderName}>`, propName);

      if (!uniqueCompletions.has(expandedCompletion)) {
        uniqueCompletions.add(expandedCompletion);

        const description = [...property.getDescription()];
        description.push(`*Expanded from*: \`<${placeholderName}>\` → \`${propName}\``);

        const item = ScriptProperties.createItem(expandedCompletion, description, vscode.CompletionItemKind.Property);
        items.set(expandedCompletion, item);
        expandedCount++;
      }
    }

    logger.debug(`Expanded ${expandedCount} completions from placeholder <${placeholderName}>`);
  }

  /**
   * Extracts keyword name from property result attribute
   * Example: "Shortcut for isclass.{class.<classname>}" with placeholder "classname" -> "class"
   */
  private extractKeywordFromPropertyResult(resultText: string, placeholderName: string): string | undefined {
    // Look for pattern like {keyword.<placeholderName>}
    const pattern = new RegExp(`\\{([^.}]+)\\.\\<${placeholderName}\\>\\}`, 'i');
    const match = resultText.match(pattern);

    if (match && match[1]) {
      // Return the keyword name directly - no mapping needed
      return match[1];
    }

    return undefined;
  }

  public provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
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

  private generateHoverWordText(hoverWord: string, keywords: Keyword[], datatypes: Datatype[]): string {
    let hoverText = '';

    // Find keywords that match the hoverWord either in their name or property names
    const matchingKeyNames = keywords.filter(
      (k: Keyword) => k.$.name.includes(hoverWord) || k.property?.some((p: ScriptProperty) => p.$.name.includes(hoverWord))
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
  return cleanStr(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
