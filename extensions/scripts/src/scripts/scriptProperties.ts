import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as xpath from 'xpath';
import { DOMParser, Node, Element, Text } from '@xmldom/xmldom';
import { getDocumentScriptType, aiScriptId, mdScriptId } from './scriptsMetadata';
import { getNearestBreakSymbolIndexForExpressions, getSubStringByBreakSymbolForExpressions } from './scriptUtilities';
import { LanguageFileProcessor } from '../languageFiles/languageFiles';
import { variablePatternExact } from './scriptVariables';

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

  private domParser: DOMParser = new DOMParser();
  private librariesFolder: string;
  private languageProcessor: LanguageFileProcessor;
  private scriptPropertiesPath: string;
  private locationDict: Map<string, vscode.Location> = new Map<string, vscode.Location>();
  private typeDict: Map<string, TypeEntry> = new Map<string, TypeEntry>();
  private keywordList: KeywordEntry[] = [];
  private descriptions: Map<string, string> = new Map<string, string>();

  constructor(librariesFolder: string, languageProcessor: LanguageFileProcessor) {
    this.librariesFolder = librariesFolder;
    this.scriptPropertiesPath = path.join(librariesFolder, 'scriptproperties.xml');
    this.languageProcessor = languageProcessor;
  }

  /**
   * Initialize ScriptProperties asynchronously to avoid blocking the extension host.
   * Must be awaited before using properties/completions.
   */
  public async initialize(): Promise<void> {
    await this.readScriptPropertiesAsync(this.scriptPropertiesPath);
  }

  dispose(): void {
    this.domParser = undefined;
    this.locationDict.clear();
    this.typeDict.clear();
    this.keywordList = [];
    this.descriptions.clear();
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
    if (this.languageProcessor) {
      return this.languageProcessor.replaceSimplePatternsByText(text);
    }
    return text;
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

  private async processKeyword(rawData: string, e: Keyword) {
    const name = e.$.name;
    this.addNonPropertyLocation(rawData, name, 'keyword');
    const type = this.typeDict.get(e.$.type || '');
    this.addKeyword(name, type, e.$.script, e.$.description);
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
          this.addKeywordProperty(name, value, script, type, this.processTextPatterns(description), ignorePrefix);
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
    this.addNonPropertyLocation(rawData, name, 'datatype');
    logger.debug('Datatype read: ' + name);
    this.addType(name, e.$.type, e.$.suffix);
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

  addLocation(name: string, file: string, start: vscode.Position, end: vscode.Position): void {
    const range = new vscode.Range(start, end);
    const uri = vscode.Uri.file(file);
    this.locationDict.set(cleanStr(name), new vscode.Location(uri, range));
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
    if (entry === undefined) {
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
    kind: vscode.CompletionItemKind = vscode.CompletionItemKind.Property
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(complete, kind);
    if (info.length > 0) {
      item.documentation = new vscode.MarkdownString(info.join('  \n- '));
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

  public makeCompletionsFromExpression(
    textToProcessBefore: string,
    textToProcessAfter: string,
    type: string,
    schema: string,
    position: vscode.Position,
    token?: vscode.CancellationToken
  ): vscode.CompletionList | undefined {
    logger.debug('Processing expression: ', textToProcessBefore, ' Type: ', type, ' Schema: ', schema);

    // Clean the input text
    textToProcessBefore = getSubStringByBreakSymbolForExpressions(textToProcessBefore, true);

    if (token?.isCancellationRequested) return undefined;

    // Use step-by-step analysis
    const completions = this.analyzeExpressionStepByStep(textToProcessBefore, schema, token);

    if (completions === undefined || token?.isCancellationRequested) return undefined;

    return this.makeCompletionList(completions);
  }

  /**
   * Step-by-step expression analysis as specified:
   * Each part is either "identified & completed" or "identified & not completed"
   * Tracks contentType through the analysis
   */
  private analyzeExpressionStepByStep(expression: string, schema: string, token?: vscode.CancellationToken): Map<string, vscode.CompletionItem> | undefined {
    const items = new Map<string, vscode.CompletionItem>();

    // Split expression into parts (empty parts are valid and should be processed)
    const parts = ScriptProperties.splitExpressionPreserveBraces(expression);

    logger.warn(`Analyzing expression: "${expression}" -> parts: [${parts.map((p) => `"${p}"`).join(', ')}]`);

    if (parts.length === 0) {
      return items;
    }

    if (token?.isCancellationRequested) return undefined;

    // Step 1: First part must be a keyword
    const firstPart = parts[0];
    const isVariableBased = ScriptProperties.isItVariable(firstPart);
    let keyword: KeywordEntry | TypeEntry | undefined;
    if (!isVariableBased) {
      keyword = this.getKeyword(firstPart, schema);
      if (!keyword) {
        // First part not found as keyword - provide keyword suggestions
        logger.debug(`First part "${firstPart}" not found as keyword, providing keyword suggestions`);
        this.addKeywordCompletions(items, firstPart, schema);
        return items;
      }
      logger.debug(`First part "${firstPart}" identified as keyword, type: ${keyword.name || 'none'}`);
    }

    if (token?.isCancellationRequested) return undefined;

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

      logger.debug(`Property step ${i}: part="${part}", isLast=${isLastPart}, prefix="${prefix}", contentType="${currentContentType?.name}"`);

      if (token?.isCancellationRequested) return undefined;

      const result = this.analyzePropertyStep(part, currentContentType, prefix, isLastPart, schema, token);

      if (result === undefined || token?.isCancellationRequested) return undefined;

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
        logger.debug(`Part "${part}" completed, new contentType: "${currentContentType?.name}"`);
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
    schema: string,
    token?: vscode.CancellationToken,
    isCompletionMode: boolean = true
  ):
    | {
        isCompleted: boolean;
        completions?: Map<string, vscode.CompletionItem>;
        newContentType?: KeywordEntry | TypeEntry;
        property?: PropertyEntry;
      }
    | undefined {
    const fullContentOnStep = prefix ? `${prefix}.${part}` : part;
    const possibleTypes = contentType !== undefined ? [contentType] : Array.from(this.typeDict.values());

    if (token?.isCancellationRequested) return undefined;

    const completions = new Map<string, vscode.CompletionItem>();
    for (const currentType of possibleTypes) {
      // if (ScriptProperties.typesNotAssignableToVariable.has(currentType.name)) {
      //   continue; // Skip types that are not assignable to variables
      // }
      // Try to find exact property match
      if (currentType.hasProperty(fullContentOnStep)) {
        const property = currentType.getProperty(fullContentOnStep)!;
        logger.debug(`Found exact property: "${fullContentOnStep}", type: "${property.type}"`);

        if (isLastPart && isCompletionMode) {
          // Last part and found - provide next level completions if property has a type
          if (property.type) {
            const typeEntry = this.typeDict.get(property.type);
            if (typeEntry) {
              typeEntry.prepareItems('', completions, undefined, token);
            } else {
              logger.warn(`Type entry not found for property type: "${property.type}"`);
            }
          }
          return { isCompleted: true, completions };
        } else {
          // Not last part - continue with the property's type
          const newContentType = property.type ? this.typeDict.get(property.type) : undefined;
          return { isCompleted: true, newContentType, property };
        }
      }

      if (token?.isCancellationRequested) return undefined;

      // Property not found exactly - try filtering by prefix using enhanced method
      const filteredProperties = this.filterPropertiesByPrefix(currentType, fullContentOnStep, true, schema);

      if (token?.isCancellationRequested) return undefined;

      if (filteredProperties.length === 1) {
        const property = filteredProperties[0];
        if (ScriptProperties.splitExpressionPreserveBraces(fullContentOnStep).length === property.name.split('.').length) {
          const newContentType = property.type ? this.typeDict.get(property.type) : undefined;
          return { isCompleted: true, newContentType, property };
        }
      }

      if (filteredProperties.length > 0) {
        logger.debug(`Found ${filteredProperties.length} properties with prefix "${fullContentOnStep}"`);

        if (!isLastPart) {
          // Not last part - this is a complex property, continue with same contentType
          // return { isCompleted: false };
          continue; // Skip to next type
        }
      }

      if (token?.isCancellationRequested) return undefined;

      // No properties found
      if (isLastPart) {
        // Last part and nothing found - try without dot one more time using enhanced method
        const candidateProperties = this.filterPropertiesByPrefix(currentType, fullContentOnStep, false, schema);

        if (token?.isCancellationRequested) return undefined;

        if (candidateProperties.length > 0) {
          this.generateCompletionsFromProperties(candidateProperties, fullContentOnStep, completions, schema);

          if (token?.isCancellationRequested) return undefined;

          // return { isCompleted: false, completions };
          continue; // Skip to next type
        }
      }
    }
    if (completions.size > 0) {
      return { isCompleted: false, completions };
    } else {
      return { isCompleted: false };
    }
  }

  /**
   * Generates completions from filtered properties by removing prefix and suffixes
   */
  private generateCompletionsFromProperties(
    properties: PropertyEntry[],
    fullContentOnStep: string,
    items: Map<string, vscode.CompletionItem>,
    schema?: string
  ): void {
    // const items = new Map<string, vscode.CompletionItem>();
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
    // return items;
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
          description.push(`**${propName.replace(/([<>])/g, '\\$1')}**: ${prop.details}`);
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
    const prefixSplitted = ScriptProperties.splitExpressionPreserveBraces(prefix);
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
        let matched = maxItems > 0;

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

          if (variablePatternExact.test(prefixPart) && namePart === '$<variable>') {
            continue;
          }

          // Check for placeholder expansion in middle parts
          const placeholderMatch = namePart.match(ScriptProperties.regexLookupElement);
          if (placeholderMatch && schema) {
            if (prefixPart.length > 0 && ['mdscriptname', 'cuename'].includes(placeholderMatch[1])) {
              continue; // Stub for md scripts
            }
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
      if (this.locationDict.has(relevant)) {
        return this.locationDict.get(relevant);
      }
      relevant = relevant.substring(relevant.indexOf('.') + 1);
    } while (relevant.length > 0);
    return undefined;
  }

  /**
   * Enhanced hover provider using the step-by-step expression analysis
   * This method leverages the same parsing logic as completion for more accurate hover information
   */
  public provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): vscode.Hover | undefined {
    try {
      if (token?.isCancellationRequested) return undefined;
      const schema = getDocumentScriptType(document);
      if (schema === '') {
        return undefined;
      }
      // Get the expression at the cursor position
      const phraseRegex = /([.]*[$@]*[a-zA-Z0-9_-{}])+/g;
      const phraseRange = document.getWordRangeAtPosition(position, phraseRegex);
      if (!phraseRange) {
        return undefined;
      }

      const fullExpression = document.getText(phraseRange);
      const cleanExpression = getSubStringByBreakSymbolForExpressions(fullExpression, true);
      if (token?.isCancellationRequested) return undefined;

      logger.debug('Enhanced hover - Full expression:', fullExpression);
      logger.debug('Enhanced hover - Clean expression:', cleanExpression);

      // Analyze the expression to get type information
      const hoverInfo = this.analyzeExpressionForHover(cleanExpression, schema, position, phraseRange, fullExpression, token);

      if (hoverInfo) {
        return new vscode.Hover(hoverInfo.content, hoverInfo.range || phraseRange);
      }

      return undefined;
    } catch (error) {
      logger.error('Error in provideEnhancedHover:', error);
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
    expression: string,
    schema: string,
    position: vscode.Position,
    phraseRange: vscode.Range,
    fullExpression: string,
    token?: vscode.CancellationToken
  ): { content: vscode.MarkdownString; range?: vscode.Range } | undefined {
    const parts = ScriptProperties.splitExpressionPreserveBraces(expression);

    if (parts.length === 0) {
      return undefined;
    }

    logger.debug(`Enhanced hover analysis: "${expression}" -> parts: [${parts.map((p) => `"${p}"`).join(', ')}]`);
    if (token?.isCancellationRequested) return undefined;

    const expressionIndex = fullExpression.indexOf(expression);
    const expressionLength = expression.length;
    const startPosition = phraseRange.start.translate(0, expressionIndex);
    const endPosition = phraseRange.start.translate(0, expressionIndex + expressionLength);
    const positionInExpression = position.character - startPosition.character;
    // Step 1: Analyze the first part
    const firstPart = parts[0];
    const isVariableBased = ScriptProperties.isItVariable(firstPart);
    let currentContentType: KeywordEntry | TypeEntry | undefined;
    const hoverContent = new vscode.MarkdownString();
    let fullContentOnStep = firstPart;

    if (isVariableBased) {
      hoverContent.appendMarkdown(`**${firstPart}**:\n\n`);
    } else {
      // Look for keyword
      currentContentType = this.getKeyword(firstPart, schema);

      if (currentContentType) {
        // Add keyword/type information
        hoverContent.appendMarkdown(`**${currentContentType.name}**:`);
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

    if (token?.isCancellationRequested) return undefined;

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

    if (token?.isCancellationRequested) return undefined;

    // Step 2: Analyze property chain
    let prefix = '';
    let finalProperty: PropertyEntry | undefined;
    // let finalContentType: KeywordEntry | TypeEntry | undefined = currentContentType;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const isLastPart = i === parts.length - 1;
      fullContentOnStep = fullContentOnStep ? `${fullContentOnStep}.${part}` : part;
      const contentOnStepLength = fullContentOnStep.length;
      if (token?.isCancellationRequested) return undefined;

      logger.debug(`Enhanced hover step ${i}: part="${part}", prefix="${prefix}"`);

      const result = this.analyzePropertyStep(part, currentContentType, prefix, false, schema, token, false);
      if (result === undefined || token?.isCancellationRequested) return undefined;
      if (result.isCompleted && result.property) {
        hoverContent.appendMarkdown(`- *Property`);
        if (!currentContentType && result.property.owner) {
          hoverContent.appendMarkdown(` of ${result.property.owner.name}`);
        }
        hoverContent.appendMarkdown(`:*\n\n  - **${result.property.name.replace(/([<>])/g, '\\$1')}**`);
        if (result.property.details) {
          hoverContent.appendMarkdown(`: ${result.property.details}\n\n`);
        }
        if (positionInExpression < contentOnStepLength) {
          if (result.property.name === '$<variable>' && variablePatternExact.test(part)) {
            hoverContent.appendMarkdown(`**${part}**:\n\n`);
          }
          hoverContent.appendMarkdown(`**Result**: *${result.newContentType?.name || 'any'}*\n\n`);
          return {
            content: hoverContent,
            range: new vscode.Range(startPosition, endPosition.translate(0, -expressionLength + contentOnStepLength)),
          };
        }
        if (!isLastPart) {
          currentContentType = result.newContentType;
          if (currentContentType) {
            hoverContent.appendMarkdown(`**${currentContentType.name}**:`);
            if (currentContentType instanceof KeywordEntry && currentContentType.details) {
              hoverContent.appendMarkdown(` *${currentContentType.details}*:`);
            }
            hoverContent.appendMarkdown('\n\n');
          } else if (result.property.name === '$<variable>' && variablePatternExact.test(part)) {
            hoverContent.appendMarkdown(`**${part}**:\n\n`);
          }
          prefix = ''; // Reset prefix for next property step
        }
      } else {
        prefix = prefix ? `${prefix}.${part}` : part;
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
