import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as xpath from 'xpath';
import { DOMParser, Node, Element, Text } from '@xmldom/xmldom';
import { getDocumentScriptType, aiScriptSchema, mdScriptSchema } from './scriptsMetadata';
import { getSubStringByBreakCommonSymbol, getEnclosingCurlyBracesIndexes, breakoutsForExpressions, breakoutsForExpressionsAfter } from './scriptUtilities';
import { languageProcessor } from '../languageFiles/languageFiles';
import { variablePatternExact } from './scriptVariables';

class PropertyEntry {
  public name: string;
  public type?: string;
  public details?: string;
  public owner?: TypeEntry | KeywordEntry;
  public location?: vscode.Location;

  constructor(name: string, type?: string, details?: string, owner?: TypeEntry | KeywordEntry, location?: vscode.Location) {
    this.name = name;
    this.type = type;
    this.details = details;
    this.owner = owner;
    this.location = location;
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
  public location?: vscode.Location;

  constructor(name: string, supertype?: TypeEntry, suffix?: string, location?: vscode.Location) {
    this.name = name;
    this.supertype = supertype;
    this.suffix = suffix;
    this.location = location;
  }

  public addProperty(value: string, type: string = '', details: string = '', location?: vscode.Location) {
    this.properties.set(value, new PropertyEntry(value, type, details, this, location));
  }

  public getProperties(directOnly: boolean = false): Map<string, PropertyEntry> {
    return new Map(Array.from(this.properties.entries()).concat(Array.from(!directOnly && this.supertype ? this.supertype.getProperties().entries() : [])));
  }

  public hasProperty(name: string, directOnly: boolean = false): boolean {
    if (this.properties.has(name)) {
      return true;
    }
    if (!directOnly && this.supertype) {
      return this.supertype.hasProperty(name);
    }
    return false;
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

  public prepareItems(prefix: string, items: Map<string, vscode.CompletionItem>, range?: vscode.Range, token?: vscode.CancellationToken): void {
    logger.debug('Building Type: ', this.name, 'prefix: ', prefix);

    if (items.size > 1000) {
      logger.warning('\t\tMax count reached, returning');
      return;
    }

    let i = 0;
    for (const prop of this.getProperties().entries()) {
      if (prefix === '' || prop[0].startsWith(prefix)) {
        prop[1].putAsCompletionItem(items, range);
      }
      i++;
      // Check cancellation periodically to keep UI responsive
      if (i % 32 === 0 && token?.isCancellationRequested) {
        logger.warning('Operation canceled');
        return;
      }
    }
  }
}

class KeywordEntry extends TypeEntry {
  public details?: string;
  public script?: string;

  constructor(name: string, supertype?: TypeEntry, script?: string, details?: string, location?: vscode.Location) {
    super(name, supertype, undefined, location);
    if (script) {
      this.script = script === 'md' ? mdScriptSchema : aiScriptSchema;
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
  private static readonly regexLookupElement = /^<([^>]+)>$/;
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
  private static readonly typesNotAssignableToVariable: Set<string> = new Set<string>(['cue', 'order']);
  private static readonly attributesToPropertiesTypesConversion: Map<string, string> = new Map<string, string>([['cuename', 'cue']]);

  private domParser: DOMParser = new DOMParser();
  private librariesFolder: string;
  private scriptPropertiesPath: string;
  private typeDict: Map<string, TypeEntry> = new Map<string, TypeEntry>();
  private keywordList: KeywordEntry[] = [];
  private descriptions: Map<string, string> = new Map<string, string>();

  constructor() {}

  /**
   * Initialize ScriptProperties asynchronously to avoid blocking the extension host.
   * Must be awaited before using properties/completions.
   */
  public async init(librariesFolder: string): Promise<void> {
    if (this.librariesFolder !== librariesFolder) {
      // Validate libraries folder exists and is a directory
      try {
        const stat = await fsp.stat(librariesFolder);
        if (!stat.isDirectory()) {
          vscode.window.showErrorMessage(`Libraries path is not a directory: ${librariesFolder}`);
          logger.error('Libraries path is not a directory:', librariesFolder);
          return;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Libraries folder not found: ${librariesFolder}`);
        logger.error('Libraries folder not found:', librariesFolder, err as any);
        return;
      }
      try {
        const stat = await fsp.stat(path.join(librariesFolder, 'scriptproperties.xml'));
        if (!stat.isFile()) {
          vscode.window.showErrorMessage(`Script properties file not found: ${librariesFolder}`);
          logger.error('Script properties file not found:', librariesFolder);
          return;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Script properties file not found: ${librariesFolder}`);
        logger.error('Script properties file not found:', librariesFolder, err as any);
        return;
      }
      this.librariesFolder = librariesFolder;
      this.scriptPropertiesPath = path.join(librariesFolder, 'scriptproperties.xml');
      await this.readScriptPropertiesAsync(this.scriptPropertiesPath);
    }
  }

  public clear(): void {
    this.typeDict.clear();
    this.keywordList = [];
    this.descriptions.clear();
  }

  public dispose(): void {
    this.clear();
    this.domParser = undefined;
  }

  private async readScriptPropertiesAsync(filepath: string): Promise<void> {
    logger.info('Attempting to read scriptproperties.xml');
    try {
      const rawDataOriginal = await fsp.readFile(filepath, 'utf8');
      // Inject additional keyword definitions before processing
      const rawData = this.injectAdditionalKeywords(rawDataOriginal);

      const parser = new xml2js.Parser();
      const parsedData: any = await parser.parseStringPromise(rawData);
      if (parsedData !== undefined) {
        this.processDatatypes(rawData, parsedData['scriptproperties']['datatype']);
        await this.processKeywordsAsync(rawData, parsedData['scriptproperties']['keyword']);
        logger.info('Parsed scriptproperties.xml');
      }
    } catch (err) {
      vscode.window.showErrorMessage('Error during parsing of scriptproperties.xml: ' + err);
      logger.error('Error reading scriptproperties.xml', err as any);
    }
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

  private processTextPatterns(text: string): string {
    if (languageProcessor) {
      return languageProcessor.replaceSimplePatternsByText(text);
    }
    return text;
  }

  private processProperty(rawData: string, parent: string, parentType: string, prop: ScriptProperty, script?: string) {
    const name = prop.$.name;
    logger.debug('\tProperty read: ', name);
    const location = this.addPropertyLocation(rawData, name, parent, parentType);
    if (parentType === 'keyword') {
      this.addKeywordProperty(parent, name, script, prop.$.type || '', prop.$.result, location);
    } else {
      this.addTypeProperty(parent, name, prop.$.type || '', prop.$.result, location);
    }
  }

  private async processKeyword(rawData: string, e: Keyword) {
    const name = e.$.name;
    const location = this.addNonPropertyLocation(rawData, name, 'keyword', e.$.script);
    const type = this.typeDict.get(e.$.type || '');
    this.addKeyword(name, type, e.$.script, e.$.description, location);
    logger.debug('Keyword read: ' + name);

    if (e.import !== undefined) {
      const imp = e.import[0];
      const src = imp.$.source;
      const select = imp.$.select;
      await this.processKeywordImportAsync(name, src, select, imp.property[0], e.$.script);
    }
    if (e.property !== undefined) {
      e.property.forEach((prop) => this.processProperty(rawData, name, 'keyword', prop, e.$.script));
    }
  }

  private async processKeywordImportAsync(name: string, src: string, select: string, property: ScriptProperty, script?: string) {
    const srcPath = path.join(this.librariesFolder, src);
    const targetName = property?.$?.name || '';
    const ignorePrefix = property?.$?.ignoreprefix === 'true' || false;
    const result = property?.$?.result || '';
    const type = property?.$?.type || '';
    logger.info(`Attempting to import '${name}' via select: "${select}" and target: "${targetName}" from ${src}`);
    // Read the import file asynchronously
    const rawData = await fsp.readFile(srcPath, 'utf8');
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
            if (result && result[0] === '@') {
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
            if (description === '' && element.hasAttribute('comment')) {
              description = element.getAttribute('comment') || '';
            }
          }
          this.addKeywordProperty(name, value, script, type, this.processTextPatterns(description), undefined, ignorePrefix);
        }
      } else {
        logger.warn('No matches found for import: ' + select + '/' + targetName + ' in ' + src);
      }
    }
  }

  private async processKeywordsAsync(rawData: string, keywords: Keyword[]) {
    for (const e of keywords) {
      await this.processKeyword(rawData, e);
      // Yield to keep the event loop responsive during long imports
      if ((e as any) && (e as any).import) await Promise.resolve();
    }
  }

  private processDatatype(rawData: any, e: Datatype) {
    const name = e.$.name;
    const location = this.addNonPropertyLocation(rawData, name, 'datatype');
    logger.debug('Datatype read: ' + name);
    this.addType(name, e.$.type, e.$.suffix, location);
    if (e.property === undefined) {
      return;
    }
    e.property.forEach((prop) => this.processProperty(rawData, name, 'datatype', prop));
  }

  // Process all keywords in the XML
  private processKeywords(rawData: string, keywords: any[]): void {
    keywords.forEach((e: Keyword) => {
      this.processKeyword(rawData, e);
    });
  }

  // Process all datatypes in the XML
  private processDatatypes(rawData: string, datatypes: any[]): void {
    datatypes.forEach((e: Datatype) => {
      this.processDatatype(rawData, e);
    });
  }

  makeLocation(file: string, start: vscode.Position, end: vscode.Position): vscode.Location {
    const range = new vscode.Range(start, end);
    const uri = vscode.Uri.file(file);
    return new vscode.Location(uri, range);
  }

  addLocationForRegexMatch(rawData: string, rawIdx: number, name: string): vscode.Location {
    // make sure we don't care about platform & still count right https://stackoverflow.com/a/8488787
    const line = rawData.substring(0, rawIdx).split(/\r\n|\r|\n/).length - 1;
    const startIdx = Math.max(rawData.lastIndexOf('\n', rawIdx), rawData.lastIndexOf('\r', rawIdx));
    const start = new vscode.Position(line, rawIdx - startIdx);
    const endIdx = rawData.indexOf('>', rawIdx) + 2;
    const end = new vscode.Position(line, endIdx - rawIdx);
    return this.makeLocation(this.scriptPropertiesPath, start, end);
  }

  addNonPropertyLocation(rawData: string, name: string, tagType: string, script?: string): vscode.Location {
    const rawIdx = rawData.search(
      '<' + tagType + ' name="' + escapeRegex(name) + '"[^>]*' + (script ? ' script="' + escapeRegex(script) + '"[^>]*' : '') + '>'
    );
    return this.addLocationForRegexMatch(rawData, rawIdx, name);
  }

  addPropertyLocation(rawData: string, name: string, parent: string, parentType: string): vscode.Location | undefined {
    const re = new RegExp('(?:<' + parentType + ' name="' + escapeRegex(parent) + '"[^>]*>.*?)(<property name="' + escapeRegex(name) + '"[^>]*>)', 's');
    const matches = rawData.match(re);
    if (matches === null || matches.index === undefined) {
      logger.info("strangely couldn't find property named:", name, 'parent:', parent);
      return;
    }
    const rawIdx = matches.index + matches[0].indexOf(matches[1]);
    return this.addLocationForRegexMatch(rawData, rawIdx, parent + '.' + name);
  }

  addType(key: string, supertype?: string, suffix?: string, location?: vscode.Location): void {
    const k = cleanStr(key);
    let entry = this.typeDict.get(k);
    if (entry === undefined) {
      entry = new TypeEntry(k, supertype ? this.typeDict.get(cleanStr(supertype)) : undefined, suffix, location);
      this.typeDict.set(k, entry);
    }
  }

  addKeyword(key: string, type?: TypeEntry, script?: string, details?: string, location?: vscode.Location): void {
    const k = cleanStr(key);
    let entry = this.getKeyword(k, script || '');
    if (entry === undefined) {
      entry = new KeywordEntry(k, type, script, details, location);
      this.keywordList.push(entry);
    }
  }

  addTypeProperty(key: string, prop: string, type?: string, details?: string, location?: vscode.Location): void {
    const k = cleanStr(key);
    if (!this.typeDict.has(k)) {
      this.addType(k);
    }
    const entry = this.typeDict.get(k);
    if (entry === undefined) {
      return;
    }
    entry.addProperty(prop, type, details, location);
  }

  addKeywordProperty(
    key: string,
    prop: string,
    script?: string,
    type?: string,
    details?: string,
    location?: vscode.Location,
    ignorePrefix: boolean = false
  ): void {
    const k = cleanStr(key);

    const entry = this.getKeyword(k, script || '');
    if (entry === undefined) {
      return;
    }
    if (ignorePrefix && prop.startsWith(k + '.')) {
      prop = prop.substring(k.length + 1);
    }
    entry.addProperty(prop, type, details, location);
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
    kind: vscode.CompletionItemKind = vscode.CompletionItemKind.Property,
    range?: vscode.Range
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(complete, kind);
    if (info.length > 0) {
      item.documentation = new vscode.MarkdownString(info.join('  \n- '));
    }
    if (range) {
      item.range = range;
    }
    return item;
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

  private static convertTypes(type: string): string {
    return this.attributesToPropertiesTypesConversion.get(type) || 'undefined';
  }

  public makeCompletionsFromExpression(
    textToProcessBefore: string,
    textToProcessAfter: string,
    resultType: string,
    schema: string,
    position: vscode.Position,
    token?: vscode.CancellationToken,
    context?: vscode.CompletionContext
  ): vscode.CompletionList | undefined {
    logger.debug(`Processing expression: ${textToProcessBefore} Type: ${resultType} Schema: ${schema}`);

    if (token?.isCancellationRequested) {
      logger.debug(`Make completions cancelled.`);
      return undefined;
    }
    // Clean the input text
    textToProcessBefore = getSubStringByBreakCommonSymbol(textToProcessBefore, true);
    textToProcessAfter = getSubStringByBreakCommonSymbol(textToProcessAfter, false);

    const inCurlyBraces = getEnclosingCurlyBracesIndexes(textToProcessBefore + textToProcessAfter, textToProcessBefore.length);
    if (inCurlyBraces.length > 0) {
      // If we're inside curly braces, we need to adjust the expression
      textToProcessAfter = textToProcessAfter.substring(0, inCurlyBraces[1] - textToProcessBefore.length);
      textToProcessBefore = textToProcessBefore.substring(inCurlyBraces[0] + 1);
    }
    if (token?.isCancellationRequested) {
      logger.debug(`Make completions cancelled.`);
      return undefined;
    }
    // Use step-by-step analysis
    const completions = this.analyzeExpressionStepByStep(
      textToProcessBefore,
      textToProcessAfter.length,
      ScriptProperties.convertTypes(resultType),
      position,
      schema,
      token
    );

    if (completions === undefined) return undefined;

    if (token?.isCancellationRequested) {
      logger.debug(`Make completions cancelled.`);
      return undefined;
    }

    return this.makeCompletionList(completions);
  }

  /**
   * Step-by-step expression analysis as specified:
   * Each part is either "identified & completed" or "identified & not completed"
   * Tracks contentType through the analysis
   */
  private analyzeExpressionStepByStep(
    expression: string,
    suffixLength: number,
    resultType: string,
    position: vscode.Position,
    schema: string,
    token?: vscode.CancellationToken
  ): Map<string, vscode.CompletionItem> | undefined {
    const items = new Map<string, vscode.CompletionItem>();

    // Split expression into parts (empty parts are valid and should be processed)
    const parts = ScriptProperties.splitExpressionPreserveBraces(expression);
    logger.warn(`Analyzing expression: "${expression}" -> parts: [${parts.map((p) => `"${p}"`).join(', ')}]`);

    if (parts.length === 0) {
      return items;
    }

    if (token?.isCancellationRequested) {
      logger.debug(`Expression analysis cancelled: "${expression}"`);
      return undefined;
    }

    // Step 1: First part must be a keyword
    const firstPart = parts[0];
    const isVariableBased = ScriptProperties.isItVariable(firstPart);
    let keyword: KeywordEntry | TypeEntry | undefined;
    if (!isVariableBased) {
      keyword = this.getKeyword(firstPart, schema);
      if (!keyword) {
        // First part not found as keyword - provide keyword suggestions
        logger.debug(`First part "${firstPart}" not found as keyword, providing keyword suggestions`);
        const range = new vscode.Range(position.line, position.character - firstPart.length, position.line, position.character + suffixLength);
        this.addKeywordCompletions(items, firstPart, resultType, range, schema);
        return items;
      }
      logger.debug(`First part "${firstPart}" identified as keyword, type: ${keyword.name || 'none'}`);
    }

    if (token?.isCancellationRequested) {
      logger.debug(`Expression analysis cancelled: "${expression}"`);
      return undefined;
    }

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
    let types = [];
    let properties = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;

      logger.debug(`Property step ${i}: part="${part}", isLast=${isLastPart}, prefix="${prefix}", contentType="${currentContentType?.name}"`);

      if (token?.isCancellationRequested) {
        logger.debug(`Expression analysis cancelled: "${expression}"`);
        return undefined;
      }

      const result = this.analyzePropertyStep(part, currentContentType, types, resultType, properties, prefix, isLastPart, schema, token);
      if (result === undefined) {
        return undefined;
      }

      if (token?.isCancellationRequested) {
        if (logger.debug(`Expression analysis cancelled: "${expression}"`)) {
          return undefined;
        }
      }

      if (result.isCompleted) {
        // Part was completed, update contentType and continue
        currentContentType = result.newContentType!;
        prefix = ''; // Reset prefix for clean property step
        types = [];
        properties = [];
        logger.debug(`Part "${part}" completed, new contentType: "${currentContentType?.name}"`);
      } else {
        if (isLastPart && result.properties) {
          // Add completions and stop analysis
          const range = new vscode.Range(position.line, position.character - part.length, position.line, position.character + suffixLength);
          this.generateCompletionsFromProperties(result.properties, ScriptProperties.partsCount(prefix), items, range, schema);
          break;
        }
        // Part is identified but not completed - add to prefix and continue
        prefix = prefix ? `${prefix}.${part}` : part;
        types = result.newTypes || [];
        properties = result.properties || [];
        logger.debug(`Part "${part}" not completed, updated prefix: "${prefix}"`);
      }
    }

    return items;
  }

  private static partsCount(expression: string): number {
    const parts = ScriptProperties.splitExpressionPreserveBraces(expression);
    return expression ? parts.length : 0;
  }

  /**
   * Analyzes a single property step
   */
  private analyzePropertyStep(
    part: string,
    contentType: KeywordEntry | TypeEntry,
    typesPrevious: TypeEntry[],
    resultType: string,
    propertiesPrevious: PropertyEntry[],
    prefix: string,
    isLastPart: boolean,
    schema: string,
    token?: vscode.CancellationToken,
    isCompletionMode: boolean = true
  ):
    | {
        isCompleted: boolean;
        newContentType?: KeywordEntry | TypeEntry;
        newTypes?: TypeEntry[];
        property?: PropertyEntry;
        properties?: PropertyEntry[];
      }
    | undefined {
    const fullContentOnStep = prefix ? `${prefix}.${part}` : part;
    const prefixPartsCount = ScriptProperties.partsCount(prefix);
    const isTypeDefined = contentType !== undefined;
    const possibleTypes = isTypeDefined ? [contentType] : typesPrevious.length > 0 ? typesPrevious : Array.from(this.typeDict.values());
    const newTypes = [];
    if (token?.isCancellationRequested) {
      logger.debug(`Step cancelled: "${fullContentOnStep}"`);
      return undefined;
    }

    const properties = [];
    for (const currentType of possibleTypes) {
      // if (ScriptProperties.typesNotAssignableToVariable.has(currentType.name)) {
      //   continue; // Skip types that are not assignable to variables
      // }
      // Try to find exact property match
      if (currentType.hasProperty(fullContentOnStep, !isTypeDefined)) {
        const property = currentType.getProperty(fullContentOnStep)!;
        logger.debug(`Found exact property: "${fullContentOnStep}", type: "${property.type}"`);
        const newContentType = property.type ? this.typeDict.get(property.type) : undefined;
        if (resultType === 'undefined' || resultType === property.type || !property.type) {
          return { isCompleted: true, newContentType, property };
        }
      }

      if (token?.isCancellationRequested) {
        logger.debug(`Step cancelled: "${fullContentOnStep}"`);
        return undefined;
      }

      // Property not found exactly - try filtering by prefix using method
      const filtered = this.filterPropertiesByParts(currentType, part, prefixPartsCount, resultType, propertiesPrevious, schema, !isTypeDefined);
      if (token?.isCancellationRequested) {
        logger.debug(`Step cancelled: "${fullContentOnStep}"`);
        return undefined;
      }

      if (filtered.fullyMatched.length === 1 && filtered.fullyMatched[0]) {
        const property = filtered.properties[0];
        if (property.name.split('.').length === prefixPartsCount + 1 && part !== '') {
          const newContentType = property.type ? this.typeDict.get(property.type) : undefined;
          if (resultType === 'undefined' || resultType === property.type || !property.type) {
            return { isCompleted: true, newContentType, property };
          }
        }
      }

      if (filtered.properties.length > 0) {
        logger.debug(`Found ${filtered.properties.length} properties with prefix "${fullContentOnStep}"`);

        for (const property of filtered.properties) {
          if (!properties.find((p) => p.name === property.name && p.owner?.name === property.owner?.name)) {
            if (resultType === 'undefined' || resultType === property.type || !property.type) {
              properties.push(property);
            }
          }
        }
        if (!isLastPart) {
          // Not last part - this is a complex property, continue with same contentType
          if (!newTypes.find((t) => t.name === currentType.name)) {
            newTypes.push(currentType);
          }
          continue; // Skip to next type
        }
      }

      if (token?.isCancellationRequested) {
        logger.debug(`Step cancelled: "${fullContentOnStep}"`);
        return undefined;
      }
    }
    return { isCompleted: !isCompletionMode && properties.length > 0, newTypes, properties };
  }

  /**
   * Generates completions from filtered properties by removing prefix and suffixes
   */
  private generateCompletionsFromProperties(
    properties: PropertyEntry[],
    prefixPartsCount: number,
    items: Map<string, vscode.CompletionItem>,
    range: vscode.Range,
    schema: string
  ): void {
    // const items = new Map<string, vscode.CompletionItem>();
    const uniqueCompletions = new Set<string>();

    for (const property of properties) {
      const nameSplitted = property.name.split('.');

      if (nameSplitted.length > prefixPartsCount) {
        const completion = nameSplitted[prefixPartsCount];

        // Check if completion contains placeholder pattern like <classname>
        const placeholderMatch = completion?.match(ScriptProperties.regexLookupElement);

        if (placeholderMatch && schema) {
          // Expand placeholder to actual keyword values only if at the end of the property name
          this.expandPlaceholderInCompletion(completion, property, placeholderMatch[1], schema, items, range, uniqueCompletions);
        } else if (completion) {
          this.addToUniqueCompletions(completion, items, uniqueCompletions, property.getDescription(), range);
        }
      }
    }

    logger.debug(`Generated ${items.size} unique completions from ${properties.length} properties`);
    // return items;
  }

  private addToUniqueCompletions(
    completion: string,
    items: Map<string, vscode.CompletionItem>,
    uniqueCompletions: Set<string>,
    description: string[],
    range: vscode.Range
  ): void {
    if (!uniqueCompletions.has(completion)) {
      uniqueCompletions.add(completion);
      const item = ScriptProperties.createItem(completion, description, vscode.CompletionItemKind.Property);
      item.range = range;
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
  private addKeywordCompletions(items: Map<string, vscode.CompletionItem>, prefix: string, resultType: string, range: vscode.Range, schema: string): void {
    const keywords = this.getKeywords(schema);
    for (const keyword of keywords) {
      if (keyword.name.toLowerCase().startsWith(prefix.toLowerCase())) {
        if (resultType !== 'undefined') {
          if (keyword.supertype.name !== resultType) {
            if (!Array.from(keyword.properties.values()).some((p) => p.type === resultType || !p.type)) {
              continue;
            }
          }
        }
        const item = ScriptProperties.createItem(keyword.name, keyword.getDescription(), vscode.CompletionItemKind.Keyword, range);
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
    range: vscode.Range,
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
          description.push(`**${propName.replace(/([<>])/g, '\\$1')}**: ${prop.details}`);
        }
      }
      this.addToUniqueCompletions(expandedCompletion, items, uniqueCompletions, description, range);
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

  public filterPropertiesByParts(
    contentType: KeywordEntry | TypeEntry,
    part: string,
    prefixPartsCount: number,
    resultType: string,
    propertiesPrevious: PropertyEntry[],
    schema: string,
    directOnly
  ): {
    properties: PropertyEntry[];
    fullyMatched: boolean[];
  } {
    const properties: PropertyEntry[] = [];
    const fullyMatched: boolean[] = [];
    const props = propertiesPrevious.length > 0 ? propertiesPrevious : contentType.getProperties(directOnly).values();
    for (const prop of props) {
      if (resultType === 'undefined' || resultType === prop.type || !prop.type) {
        continue;
      }
      const name = prop.name;

      // Check for placeholder expansion in middle parts
      const nameSplitted = name.split('.');
      const nameSplittedCount = nameSplitted.length;

      if (nameSplittedCount > prefixPartsCount) {
        if (part === '') {
          properties.push(prop);
          fullyMatched.push(false);
          continue;
        }
        const namePart = nameSplitted[prefixPartsCount];
        if (part == namePart) {
          // Direct match
          properties.push(prop);
          fullyMatched.push(true);
          continue;
        } else if (namePart.startsWith(part)) {
          properties.push(prop);
          fullyMatched.push(false);
        }
        // Check for parameter matching like {$component} and {$faction}
        if (part.length > 2 && namePart.length > 2 && part.startsWith('{') && namePart.startsWith('{') && part.endsWith('}') && namePart.endsWith('}')) {
          properties.push(prop);
          fullyMatched.push(true);
          continue;
        }

        if (variablePatternExact.test(part) && namePart === '$<variable>') {
          properties.push(prop);
          fullyMatched.push(true);
          continue;
        }

        // Check for placeholder expansion in middle parts
        const placeholderMatch = namePart.match(ScriptProperties.regexLookupElement);
        if (placeholderMatch && schema) {
          if (part.length > 0 && ['mdscriptname', 'cuename'].includes(placeholderMatch[1])) {
            properties.push(prop);
            fullyMatched.push(true);
            continue; // Stub for md scripts
          }
          // Get the keyword item from the property's result attribute or directly from the placeholder name
          const keyword = this.getKeywordForPlaceholder(prop, placeholderMatch[1], schema);

          if (keyword && keyword.hasProperty(part)) {
            logger.debug(`Matched placeholder <${placeholderMatch[1]}> in "${namePart}" with prefix part "${part}"`);

            properties.push(prop);
            fullyMatched.push(true);
            continue;
          } else if (keyword && Array.from(keyword.getProperties().values()).some((p) => p.name.startsWith(part))) {
            properties.push(prop);
            fullyMatched.push(false);
            continue; // Partial match
          }
        }
      }
    }

    return {
      properties,
      fullyMatched,
    };
  }

  private static prepareExpression(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): {
    parts: string[];
    expressionLength: number;
    positionInExpression: number;
    startPosition: vscode.Position;
    endPosition: vscode.Position;
    phraseRange: vscode.Range;
  } {
    const phraseRegex = /([.]*[$@]*[a-zA-Z0-9_-{}])+/g;
    const phraseRange = document.getWordRangeAtPosition(position, phraseRegex);
    if (!phraseRange) {
      return undefined;
    }

    const fullExpression = document.getText(phraseRange);
    let expression = getSubStringByBreakCommonSymbol(fullExpression, true);

    if (token?.isCancellationRequested) {
      logger.debug(`Request cancelled, for expression: "${expression}".`);
      return undefined;
    }
    let expressionIndex = fullExpression.indexOf(expression);
    let expressionLength = expression.length;

    if (
      expressionIndex === -1 ||
      phraseRange.start.character + expressionIndex >= position.character ||
      phraseRange.start.character + expressionIndex + expressionLength < position.character
    ) {
      return undefined;
    }

    const inCurlyBraces = getEnclosingCurlyBracesIndexes(expression, position.character - phraseRange.start.character - expressionIndex);
    if (inCurlyBraces.length > 0) {
      // If we're inside curly braces, we need to adjust the expression
      expression = expression.substring(inCurlyBraces[0] + 1, inCurlyBraces[1]);
      expressionIndex += inCurlyBraces[0] + 1;
      expressionLength = expression.length;
    }

    const parts = ScriptProperties.splitExpressionPreserveBraces(expression);

    if (parts.length === 0) {
      return undefined;
    }

    logger.debug(`Expression analysis: "${expression}" -> parts: [${parts.map((p) => `"${p}"`).join(', ')}]`);

    if (token?.isCancellationRequested) {
      logger.debug(`Request cancelled, for expression: "${expression}".`);
      return undefined;
    }

    const startPosition = phraseRange.start.translate(0, expressionIndex);
    const endPosition = phraseRange.start.translate(0, expressionIndex + expressionLength);
    const positionInExpression = position.character - startPosition.character;
    return {
      parts,
      expressionLength,
      positionInExpression,
      startPosition,
      endPosition,
      phraseRange,
    };
  }

  public provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Definition | undefined {
    const schema = getDocumentScriptType(document);
    if (schema == '') {
      return undefined; // Skip if the document is not valid
    }
    logger.debug(`Providing definition for ${schema} at ${position.line}:${position.character}`);
    const prepared = ScriptProperties.prepareExpression(document, position, token);
    if (!prepared) {
      return undefined;
    }
    return this.analyzeExpressionForDefinition(
      prepared.parts,
      prepared.expressionLength,
      prepared.positionInExpression,
      prepared.startPosition,
      prepared.endPosition,
      schema,
      token
    );
  }

  /**
   * Analyzes an expression for definition information using step-by-step parsing
   */
  private analyzeExpressionForDefinition(
    parts: string[],
    expressionLength: number,
    positionInExpression: number,
    startPosition: vscode.Position,
    endPosition: vscode.Position,
    schema: string,
    token?: vscode.CancellationToken
  ): vscode.Definition | undefined {
    // Step 1: Analyze the first part
    const firstPart = parts[0];
    const isVariableBased = ScriptProperties.isItVariable(firstPart);
    let currentContentType: KeywordEntry | TypeEntry | undefined;
    let fullContentOnStep = firstPart;

    if (!isVariableBased) {
      // Look for keyword
      currentContentType = this.getKeyword(firstPart, schema);

      if (currentContentType) {
        const contentOnStepLength = fullContentOnStep.length;
        if (positionInExpression < contentOnStepLength) {
          return currentContentType.location;
        }
      } else {
        return undefined; // Unknown first part
      }
    }

    if (token?.isCancellationRequested) {
      logger.debug(`Hover request cancelled.`);
      return undefined;
    }

    if (token?.isCancellationRequested) {
      logger.debug(`Hover request cancelled.`);
      return undefined;
    }
    // Step 2: Analyze property chain
    let prefix = '';
    let types = [];
    let properties = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;
      fullContentOnStep = fullContentOnStep ? `${fullContentOnStep}.${part}` : part;
      const contentOnStepLength = fullContentOnStep.length;
      if (token?.isCancellationRequested) {
        logger.debug(`Definition request cancelled.`);
        return undefined;
      }

      logger.debug(`Definition step ${i}: part="${part}", prefix="${prefix}"`);

      const result = this.analyzePropertyStep(part, currentContentType, types, 'undefined', properties, prefix, isLastPart, schema, token, false);
      if (result === undefined || token?.isCancellationRequested) {
        logger.debug(`Definition request cancelled.`);
        return undefined;
      }
      if (result.isCompleted && (result.property || (isLastPart && result.properties))) {
        if (positionInExpression < contentOnStepLength) {
          return result.properties ? result.properties.map((p) => p.location) : result.property?.location;
        }
        if (!isLastPart) {
          currentContentType = result.newContentType;

          prefix = ''; // Reset prefix for next property step
          types = [];
          properties = [];
        }
      } else {
        prefix = prefix ? `${prefix}.${part}` : part;
        types = result.newTypes || [];
        properties = result.properties || [];
      }
    }

    return undefined;
  }

  /**
   * Hover provider using the step-by-step expression analysis
   * This method leverages the same parsing logic as completion for more accurate hover information
   */
  public provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): vscode.Hover | undefined {
    try {
      if (token?.isCancellationRequested) {
        logger.debug(`Hover request cancelled.`);
        return undefined;
      }
      const schema = getDocumentScriptType(document);
      if (schema === '') {
        return undefined;
      }

      const prepared = ScriptProperties.prepareExpression(document, position, token);
      if (!prepared) {
        return undefined;
      }

      // Analyze the expression to get type information
      const hoverInfo = this.analyzeExpressionForHover(
        prepared.parts,
        prepared.expressionLength,
        prepared.positionInExpression,
        prepared.startPosition,
        prepared.endPosition,
        schema,
        token
      );

      if (hoverInfo) {
        return new vscode.Hover(hoverInfo.content, hoverInfo.range || prepared.phraseRange);
      }

      return undefined;
    } catch (error) {
      logger.error('Error in provideHover:', error);
      return undefined;
    }
  }

  private static isItVariable(expression: string): boolean {
    return variablePatternExact.test(expression);
  }

  /**
   * Analyzes an expression for hover information using step-by-step parsing
   */
  private analyzeExpressionForHover(
    parts: string[],
    expressionLength: number,
    positionInExpression: number,
    startPosition: vscode.Position,
    endPosition: vscode.Position,
    schema: string,
    token?: vscode.CancellationToken
  ): { content: vscode.MarkdownString; range?: vscode.Range } | undefined {
    // Step 1: Analyze the first part
    const firstPart = parts[0];
    const isVariableBased = ScriptProperties.isItVariable(firstPart);
    let currentContentType: KeywordEntry | TypeEntry | undefined;
    const hoverContent = new vscode.MarkdownString();
    let fullContentOnStep = firstPart;

    if (isVariableBased) {
      hoverContent.appendMarkdown(`**${firstPart}**(*variable*):\n\n`);
    } else {
      // Look for keyword
      currentContentType = this.getKeyword(firstPart, schema);

      if (currentContentType) {
        // Add keyword/type information
        hoverContent.appendMarkdown(`**${currentContentType.name}**(*keyword*):`);
        if (currentContentType instanceof KeywordEntry && currentContentType.details) {
          hoverContent.appendMarkdown(` *${currentContentType.details}*:`);
        }
        hoverContent.appendMarkdown('\n\n');
        const contentOnStepLength = fullContentOnStep.length;
        if (positionInExpression < contentOnStepLength) {
          return {
            content: hoverContent,
            range: new vscode.Range(startPosition, endPosition.translate(0, -expressionLength + contentOnStepLength)),
          };
        }
      } else {
        return undefined; // Unknown first part
      }
    }

    if (token?.isCancellationRequested) {
      logger.debug(`Hover request cancelled.`);
      return undefined;
    }

    // If only one part, return keyword/variable information
    if (parts.length === 1) {
      if (currentContentType) {
        this.addTypePropertiesToHover(currentContentType, hoverContent, schema);
      }
      return {
        content: hoverContent,
        range: new vscode.Range(startPosition, endPosition.translate(0, -expressionLength + fullContentOnStep.length)),
      };
    }

    if (token?.isCancellationRequested) {
      logger.debug(`Hover request cancelled.`);
      return undefined;
    }
    // Step 2: Analyze property chain
    let prefix = '';
    let types = [];
    let properties = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;
      fullContentOnStep = fullContentOnStep ? `${fullContentOnStep}.${part}` : part;
      const contentOnStepLength = fullContentOnStep.length;
      if (token?.isCancellationRequested) {
        logger.debug(`Hover request cancelled.`);
        return undefined;
      }

      logger.debug(`Hover step ${i}: part="${part}", prefix="${prefix}"`);

      const result = this.analyzePropertyStep(part, currentContentType, types, 'undefined', properties, prefix, isLastPart, schema, token, false);
      if (result === undefined || token?.isCancellationRequested) {
        logger.debug(`Hover request cancelled.`);
        return undefined;
      }
      if (result.isCompleted && (result.property || (isLastPart && result.properties))) {
        const resultProperties = result.properties || [result.property];
        const isVariations = result.properties !== undefined;
        const indent = isVariations ? '  ' : '';
        if (isVariations) {
          hoverContent.appendMarkdown(`*Variations*:\n\n`);
        }
        for (const property of resultProperties) {
          if (isVariations) {
            hoverContent.appendMarkdown(`- **${property.owner.name}**(*type*):\n\n`);
          }
          hoverContent.appendMarkdown(`${indent}- *Property:*\n\n`);
          hoverContent.appendMarkdown(`  ${indent}- **${property.name.replace(/([<>])/g, '\\$1')}**`);
          if (property.details) {
            hoverContent.appendMarkdown(`: ${property.details}\n\n`);
          }
          if (positionInExpression < contentOnStepLength) {
            if (property.name === '$<variable>' && variablePatternExact.test(part)) {
              hoverContent.appendMarkdown(`${indent}**${part}**:\n\n`);
            }
            hoverContent.appendMarkdown(`${indent}**Result**: *${property.type || 'any'}*\n\n`);
            continue;
          }
          if (!isLastPart) {
            if (result.newContentType) {
              hoverContent.appendMarkdown(`${indent}**${result.newContentType.name}**(*type*):`);
              if (result.newContentType instanceof KeywordEntry && result.newContentType.details) {
                hoverContent.appendMarkdown(` *${result.newContentType.details}*:`);
              }
              hoverContent.appendMarkdown('\n\n');
            } else if (result.property.name === '$<variable>' && variablePatternExact.test(part)) {
              hoverContent.appendMarkdown(`${indent}**${part}**:\n\n`);
            }
            prefix = ''; // Reset prefix for next property step
            types = [];
            properties = [];
          }
        }
        if (positionInExpression < contentOnStepLength) {
          return {
            content: hoverContent,
            range: new vscode.Range(startPosition, endPosition.translate(0, -expressionLength + contentOnStepLength)),
          };
        }
        if (!isLastPart) {
          currentContentType = result.newContentType;
          prefix = ''; // Reset prefix for next property step
          types = [];
          properties = [];
        }
      } else {
        prefix = prefix ? `${prefix}.${part}` : part;
        types = result.newTypes || [];
        properties = result.properties || [];
      }
    }

    return undefined;
  }

  /**
   * Adds type properties overview to hover content
   */
  private addTypePropertiesToHover(contentType: KeywordEntry | TypeEntry, hoverContent: vscode.MarkdownString, schema: string): void {
    const properties = contentType.getProperties();
    const propertyCount = properties.size;

    if (propertyCount > 0) {
      hoverContent.appendMarkdown(`*Properties*: ${propertyCount} available\n\n`);

      // Show first few properties as examples
      const maxExamples = 5;
      let count = 0;
      for (const [name, prop] of properties) {
        if (count >= maxExamples) {
          hoverContent.appendMarkdown(`*...and ${propertyCount - maxExamples} more*\n`);
          break;
        }

        const shortDesc = prop.details ? ` - ${prop.details.substring(0, 50)}${prop.details.length > 50 ? '...' : ''}` : '';
        hoverContent.appendMarkdown(`- \`${name}\`${shortDesc}\n`);
        count++;
      }
    } else {
      hoverContent.appendMarkdown(`*No properties available*\n`);
    }
  }

  /**
   * Split an expression by '.' characters while preserving dots inside single-level brace groups
   * e.g. first.second.{some.thing}.four -> ["first","second","{some.thing}","four"]
   * Keeps empty segments consistent with String.split('.') behavior.
   */
  private static splitExpressionPreserveBraces(expression: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < expression.length; i++) {
      const ch = expression[i];
      if (ch === '{') {
        depth++;
        current += ch;
        continue;
      }
      if (ch === '}') {
        if (depth > 0) depth--;
        current += ch;
        continue;
      }
      if (ch === '.' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts;
  }
}

function cleanStr(text: string) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(text: string) {
  // https://stackoverflow.com/a/6969486
  return cleanStr(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export const scriptProperties: ScriptProperties = new ScriptProperties();
