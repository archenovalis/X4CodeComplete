import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as xpath from 'xpath';
import { DOMParser, Node, Element, Text } from '@xmldom/xmldom';
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
    result.push(`**${this.name}**${this.details ? ': ' + this.details + '' : ''}`.replace(/([<>])/g, '\\$1')); // Escape < and > characters
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
    }
    return this.supertype ? this.supertype.getProperty(name) : undefined;
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

interface ScriptProperty {
  $: {
    name: string;
    result: string;
    type?: string;
    ignoreprefix?: string;
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
      property: [ScriptProperty];
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
  // Define additional keywords to inject
  private static readonly additionalKeywords: string = `
    <!-- Additional auto-injected keywords -->
    <!-- Relation range lookup -->
    <datatype name="relationrange" type="enum" />
    
    <keyword name="relationrange" description="Relation range lookup">
      <import source="factions.xsd" select="/xs:schema/xs:simpleType[@name='relationrangelookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="relationrange" />
      </import>
    </keyword>

    <!-- License type lookup -->
    <datatype name="licencetype" type="enum" />
    <keyword name="licencetype" description="License type lookup">
      <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='licencelookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="licencetype" />
      </import>
    </keyword>

    <!-- Component state lookup -->
    <keyword name="state" description="Component state lookup">
      <property name="all" result="all possible component states" type="componentstate" />
      <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='componentstatelookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="componentstate" />
      </import>
    </keyword>

    <!-- Defensible alert level lookup -->
    <datatype name="defensiblealertlevel" type="enum" />
    <keyword name="defensiblealertlevel" description="Defensible alert level lookup">
      <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='alertlevellookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="defensiblealertlevel" />
      </import>
    </keyword>

    <!-- Traffic levels -->
    <datatype name="trafficlevel" type="enum" />
    <keyword name="trafficlevel" description="Traffic level lookup">
      <import source="parameters.xsd" select="/xs:schema//xs:element[@name='landing']//xs:attribute[@name='traffic']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="componentstate" />
      </import>
    </keyword>

    <!-- Mood type lookup -->
    <datatype name="moodtype" type="enum" />
    <keyword name="moodtype" description="Mood type lookup">
      <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='moodtypelookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="moodtype" />
      </import>
    </keyword>

    <!-- Info library type lookup -->
    <datatype name="infolibrarytype" type="enum" />
    <keyword name="infolibrarytype" description="Info library type lookup">
      <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='infolibrarytypelookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="infolibrarytype" />
      </import>
    </keyword>

    <!-- Production method lookup -->
    <datatype name="productionmethod" type="enum" />
    <keyword name="productionmethod" description="Production method lookup">
      <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='buildmethodlookup']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="productionmethod" />
      </import>
    </keyword>

    <!-- Debug filter -->
    <datatype name="debugfilter" type="enum" />
    <keyword name="debugfilter" description="Debug filter lookup">
      <import source="common.xsd" select="/xs:schema/xs:group[@name='commonactions']//xs:element[@name='debug_text']//xs:attribute[@name='filter']//xs:enumeration">
        <property name="@value" result="xs:annotation/xs:documentation/text()" type="debugfilter" />
      </import>
    </keyword>

    <!-- Input function lookup -->
    <datatype name="inputfunction" type="enum" />
    <keyword name="inputfunction" description="Input function lookup">
      <import source="inputmap.xml" select="/inputmap/action[not(@removed)]">
        <property name="@id" type="inputfunction" />
      </import>
    </keyword>
  `;
  private static readonly enumsReAssigned: Map<string, string> = new Map<string, string>([['isalertlevel.<alertlevel>', 'defensiblealertlevel']]);

  private domParser: DOMParser = new DOMParser();
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

  constructor(librariesFolder: string) {
    this.librariesFolder = librariesFolder;
    this.scriptPropertiesPath = path.join(librariesFolder, 'scriptproperties.xml');
    this.readScriptProperties(this.scriptPropertiesPath);
  }

  dispose(): void {
    this.domParser = undefined;
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
    let rawData = fs.readFileSync(filepath).toString();

    // Inject additional keyword definitions before processing
    rawData = this.injectAdditionalKeywords(rawData);

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

  /**
   * Injects additional keyword definitions into the raw XML data before processing
   */
  private injectAdditionalKeywords(rawData: string): string {
    // Find the closing tag of scriptproperties and insert before it
    const closingTag = '</scriptproperties>';
    const insertPosition = rawData.lastIndexOf(closingTag);

    if (insertPosition !== -1) {
      const modifiedData = rawData.slice(0, insertPosition) + ScriptProperties.additionalKeywords + '\n\n' + rawData.slice(insertPosition);
      logger.info('Injected additional keywords.');
      return modifiedData;
    } else {
      logger.warn('Could not find closing scriptproperties tag - additional keywords not injected');
      return rawData;
    }
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
      this.processKeywordImport(name, src, select, imp.property[0], e.$.script);
    }
    if (e.property !== undefined) {
      e.property.forEach((prop) => this.processProperty(rawData, name, 'keyword', prop, e.$.script));
    }
  }

  private processKeywordImport(name: string, src: string, select: string, property: ScriptProperty, script?: string) {
    const srcPath = path.join(this.librariesFolder, src);
    const targetName = property?.$?.name || '';
    const ignorePrefix = property?.$?.ignoreprefix === 'true' || false;
    const result = property?.$?.result || '';
    const type = property?.$?.type || '';
    logger.info(`Attempting to import '${name}' via select: "${select}" and target: "${targetName}" from ${src}`);
    // Can't move on until we do this so use sync version
    const rawData = fs.readFileSync(srcPath).toString();
    const parsedData = this.domParser.parseFromString(rawData, 'text/xml');
    if (parsedData !== undefined) {
      const process = src.endsWith('.xsd') ? xpath.useNamespaces({ xs: 'http://www.w3.org/2001/XMLSchema' }) : xpath.useNamespaces({});
      const matches = process(select, parsedData as any);

      if (Array.isArray(matches) && matches.length > 0) {
        for (const item of matches) {
          let value = '';
          let description = '';

          // If element is a DOM node, extract attribute or text content
          if (item.nodeType === Node.ELEMENT_NODE) {
            const element = item as unknown as Element;
            // ELEMENT_NODE
            // Get attribute value for targetName (e.g., "@value" -> "value")
            if (targetName.startsWith('@')) {
              value = element.getAttribute(targetName.substring(1)) || '';
            } else {
              // Try to get child node text content
              const child = Array.from(element.childNodes).find((n: any) => n.nodeType === 1 && n.nodeName === targetName);
              value = child && (child as Element).textContent ? (child as Element).textContent.trim() : '';
            }

            // Try to get comment/description
            if (element.hasAttribute('comment')) {
              description = element.getAttribute('comment') || '';
            } else if (result && result[0] === '@') {
              description = element.getAttribute(result.substring(1)) || '';
            } else if (result) {
              const descriptionMatches = process(result, item);
              if (Array.isArray(descriptionMatches) && descriptionMatches.length > 0 && descriptionMatches[0].nodeType === Node.TEXT_NODE) {
                description = descriptionMatches
                  .filter((node: any) => node.nodeType === Node.TEXT_NODE && typeof (node as Text).data === 'string')
                  .map((node: any) => (node as Text).data.replace(/[\r\n]/g, '').trim())
                  .join('. ');
              }
            }
          }
          this.addKeywordProperty(name, value, script, type, description, ignorePrefix);
        }
      } else {
        logger.warn('No matches found for import: ' + select + '/' + targetName + ' in ' + src);
      }
    }
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

    // Property not found exactly - try filtering by prefix using enhanced method
    const filteredProperties = this.filterPropertiesByPrefix(contentType, fullContentOnStep, true, schema);

    if (filteredProperties.length > 0) {
      logger.debug(`Found ${filteredProperties.length} properties with prefix "${fullContentOnStep}"`);

      if (!isLastPart) {
        // Not last part - this is a complex property, continue with same contentType
        return { isCompleted: false };
      }
    }

    // No properties found
    if (isLastPart) {
      // Last part and nothing found - try without dot one more time using enhanced method
      const candidateProperties = this.filterPropertiesByPrefix(contentType, fullContentOnStep, false, schema);
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
          // Expand placeholder to actual keyword values only if at the end of the property name
          this.expandPlaceholderInCompletion(completion, property, placeholderMatch[1], schema, items, uniqueCompletions);
        } else if (completion) {
          this.addToUniqueCompletions(completion, items, uniqueCompletions, property.getDescription());
        }
      }
    }

    logger.debug(`Generated ${items.size} unique completions from ${properties.length} properties`);
    return items;
  }

  private addToUniqueCompletions(completion: string, items: Map<string, vscode.CompletionItem>, uniqueCompletions: Set<string>, description: string[]): void {
    if (!uniqueCompletions.has(completion)) {
      uniqueCompletions.add(completion);
      const item = ScriptProperties.createItem(completion, description, vscode.CompletionItemKind.Property);
      items.set(completion, item);
    } else {
      const item = items.get(completion);
      if (item) {
        // Add property description if available
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

    // Get the keyword item from the property's result attribute or directly from the placeholder name
    const keyword = this.getKeywordForPlaceholder(property, placeholderName, schema);

    if (!keyword) {
      logger.debug(`Could not extract keyword for placeholder <${placeholderName}>.`);
      return;
    }

    logger.debug(`Extracted keyword name: "${keyword?.name}" for ${placeholderName} with details: "${property.details}"`);

    // Get all properties from the keyword
    const keywordProperties = keyword.getProperties();
    logger.debug(`Keyword "${keyword.name}" has ${keywordProperties.size} properties`);
    const propertyDescription = property.getDescription();
    for (const [propName, prop] of keywordProperties) {
      // Replace the placeholder with the actual property name
      const expandedCompletion = completion.replace(`<${placeholderName}>`, propName);
      const description = [...propertyDescription];
      if (propName !== `<${placeholderName}>`) {
        description.push(`*Expanded from*: \`${keyword.name} for <${placeholderName}>\` → \`${propName}\``);
        if (prop.details) {
          description.push(`**${propName}**: ${prop.details}`);
        }
      }
      this.addToUniqueCompletions(expandedCompletion, items, uniqueCompletions, description);
    }

    logger.debug(`Expanded ${keywordProperties.size} completions from placeholder <${placeholderName}>`);
  }

  /**
   * Extracts keyword name from property result attribute
   * Example: "Shortcut for isclass.{class.<classname>}" with placeholder "classname" -> "class"
   */
  private getKeywordForPlaceholder(property: PropertyEntry, placeholderName: string, schema: string): KeywordEntry | undefined {
    // Look for pattern like {keyword.<placeholderName>}
    const resultText = property.details || '';
    if (resultText) {
      const pattern = new RegExp(`\\{([^.}]+)\\.\\<${placeholderName}\\>\\}`, 'i');
      const match = resultText.match(pattern);

      if (match && match[1]) {
        // Return the KeywordEntry if found
        return this.getKeyword(match[1], schema);
      }
    }
    if (ScriptProperties.enumsReAssigned.has(property.name)) {
      placeholderName = ScriptProperties.enumsReAssigned.get(property.name);
    }
    // Fallback: try to find a keyword with the placeholder name
    return this.getKeyword(placeholderName, schema) || undefined;
  }

  public filterPropertiesByPrefix(contentType: KeywordEntry | TypeEntry, prefix: string, appendDot: boolean = true, schema?: string): PropertyEntry[] {
    const result: PropertyEntry[] = [];
    const workingPrefix = appendDot && !prefix.endsWith('.') ? prefix + '.' : prefix;
    const prefixSplitted = prefix.split('.');
    const countItems = prefixSplitted.length;

    for (const [name, prop] of contentType.getProperties()) {
      // Check for exact prefix match first
      if (name.startsWith(workingPrefix)) {
        result.push(prop);
        continue;
      }

      // Check for placeholder expansion in middle parts
      const nameSplitted = name.split('.');
      if (nameSplitted.length >= countItems) {
        const maxItems = appendDot ? countItems : countItems - 1;
        let matched = true;

        for (let i = 0; i < maxItems; i++) {
          const prefixPart = prefixSplitted[i];
          const namePart = nameSplitted[i];

          // Direct match
          if (prefixPart === namePart) {
            continue;
          }

          // Check for parameter matching like {$component} and {$faction}
          if (
            prefixPart.length > 2 &&
            namePart.length > 2 &&
            prefixPart.startsWith('{') &&
            namePart.startsWith('{') &&
            prefixPart.endsWith('}') &&
            namePart.endsWith('}')
          ) {
            continue;
          }

          // Check for placeholder expansion in middle parts
          const placeholderMatch = namePart.match(ScriptProperties.regexLookupElement);
          if (placeholderMatch && schema) {
            // Get the keyword item from the property's result attribute or directly from the placeholder name
            const keyword = this.getKeywordForPlaceholder(prop, placeholderMatch[1], schema);

            if (keyword && keyword.hasProperty(prefixPart)) {
              logger.debug(`Matched placeholder <${placeholderMatch[1]}> in "${namePart}" with prefix part "${prefixPart}"`);
              continue;
            }
          }

          // No match found
          matched = false;
          break;
        }

        if (matched) {
          result.push(prop);
        }
      }
    }

    return result;
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
