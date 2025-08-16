import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import { X4CodeCompleteConfig } from '../extension/configuration';
import { XmlElement } from '../xml/xmlStructureTracker';
import path from 'path';
import fs from 'fs';
import { aiScriptSchema, mdScriptSchema, scriptsSchemas, getMetadata, getDocumentMetadata, ScriptMetadata } from './scriptsMetadata';

export interface ScriptReferencedItemInfo {
  name: string;
  scriptName: string;
  definition: vscode.Location;
  references: vscode.Location[];
}

export interface ScriptReferencedItemAtPosition {
  item: ScriptReferencedItemInfo;
  location: vscode.Location;
  isDefinition: boolean;
}

export type ScriptReferencedItems = Map<string, ScriptReferencedItemInfo>;

export interface ScriptReferencedItemsDefinition {
  name: string;
  definition: vscode.Location;
}

export interface ScriptReferencedItemsReferences {
  name: string;
  references: vscode.Location[];
}

export type ScriptReferencedItemTypeId = 'label' | 'actions' | 'handler' | 'cue' | 'library_run' | 'library_include';
export type ScriptReferencedItemClassId = 'basic' | 'external' | 'cue';
interface ScriptReferencedItemOptions {
  skipNotUsed?: boolean; // Optional flag to ignore "not used" warnings
  prepareExternalReferences?: boolean; // Optional flag to prepare references for completion
  referenceAsExpression?: boolean; // Optional flag to treat references as expressions
}
export type ScriptReferencedItemDetails = {
  type: ScriptReferencedItemTypeId;
  name: string;
  class: ScriptReferencedItemClassId;
  schema?: string;
  options?: ScriptReferencedItemOptions;
};

type ScriptReferencedItemType = Map<ScriptReferencedItemTypeId, ScriptReferencedItemDetails>;

export type ScriptReferencedCompletion = Map<string, vscode.MarkdownString>;

export interface ScriptReferencedItemsFilterItem {
  attribute: string;
  value: string;
  presented: boolean;
}

export interface ScriptReferencedItemsDetectionItem {
  element: string; // The element to check for references
  attribute?: string; // The attribute to check for references
  attributeType?: string; // The type of the attribute to check for references
  type: ScriptReferencedItemTypeId;
  class: 'definition' | 'reference';
  filePrefix?: string; // Optional prefix for external definitions
  noCompletion?: boolean; // Optional flag to disable completion for this item
  filters?: ScriptReferencedItemsFilterItem[]; // Optional filter for item detection
}

type ScriptReferencedItemsDetectionList = ScriptReferencedItemsDetectionItem[];

interface ScriptItemExternalDefinition {
  name: string;
  scriptName: string;
  definition: vscode.Location;
}

interface externalTrackerInfo {
  elementName: string;
  attributeName: string;
  filters: ScriptReferencedItemsFilterItem[];
  filePrefix: string; // Optional prefix for external definitions
  tracker: ReferencedItemsWithExternalDefinitionsTracker | ReferencedCues;
}

interface ScriptReferencedItemsRegistryItem {
  type: string;
  tracker: ReferencedItemsTracker | ReferencedItemsWithExternalDefinitionsTracker | ReferencedCues;
}

type ReferencesToCompletionItems = Map<string, Map<string, string[]>>;
export const referencesToCompletionItems: ReferencesToCompletionItems = new Map();

type ScriptReferencedItemsRegistry = Map<string, ScriptReferencedItemsRegistryItem>;

const scriptReferencedItemType: ScriptReferencedItemType = new Map([
  ['label', { type: 'label', name: 'Label', class: 'basic', schema: aiScriptSchema }],
  ['actions', { type: 'actions', name: 'Actions', class: 'external', schema: aiScriptSchema }],
  ['handler', { type: 'handler', name: 'Handler', class: 'external', schema: aiScriptSchema }],
  [
    'cue',
    {
      type: 'cue',
      name: 'Cue',
      class: 'cue',
      schema: mdScriptSchema,
      options: { skipNotUsed: true, prepareReferences: true, referenceAsExpression: true },
    },
  ],
  ['library_run', { type: 'library_run', name: 'Library run Action', class: 'external', schema: mdScriptSchema }],
  ['library_include', { type: 'library_include', name: 'Library include Action', class: 'external', schema: mdScriptSchema }],
]);

const scriptReferencedItemsDetectionList: ScriptReferencedItemsDetectionList = [
  { element: 'label', attribute: 'name', type: 'label', class: 'definition', noCompletion: true },
  { element: 'resume', attribute: 'label', type: 'label', class: 'reference' },
  { element: 'run_interrupt_script', attribute: 'resume', type: 'label', class: 'reference' },
  { element: 'abort_called_scripts', attribute: 'resume', type: 'label', class: 'reference' },
  { element: 'actions', attribute: 'name', type: 'actions', class: 'definition', noCompletion: true, filePrefix: 'lib.|interrupt.' },
  { element: 'include_interrupt_actions', attribute: 'ref', type: 'actions', class: 'reference' },
  { element: 'handler', attribute: 'name', type: 'handler', class: 'definition', noCompletion: true, filePrefix: 'interrupt.' },
  { element: 'handler', attribute: 'ref', type: 'handler', class: 'reference' },
  { element: 'cue', attribute: 'name', type: 'cue', class: 'definition', noCompletion: true },
  { element: '*', attributeType: 'cuename', type: 'cue', class: 'reference' },
  {
    element: 'library',
    attribute: 'name',
    type: 'library_run',
    class: 'definition',
    noCompletion: true,
    filters: [{ attribute: 'purpose', value: 'run_actions', presented: true }],
  },
  { element: 'run_actions', attribute: 'ref', type: 'library_run', class: 'reference' },
  {
    element: 'library',
    attribute: 'name',
    type: 'library_include',
    class: 'definition',
    noCompletion: true,
    filters: [{ attribute: 'purpose', value: 'run_actions', presented: false }],
  },
  { element: 'include_actions', attribute: 'ref', type: 'library_include', class: 'reference' },
];

export const scriptReferencedItemsRegistry: ScriptReferencedItemsRegistry = new Map();

function initializeScriptReferencedItemsDetectionMap() {
  for (const [key, details] of scriptReferencedItemType.entries()) {
    switch (details.class) {
      case 'basic':
        new ReferencedItemsTracker(key, details.name, details.schema, details.options || {});
        break;
      case 'external':
        new ReferencedItemsWithExternalDefinitionsTracker(key, details.name, details.schema, details.options || {});
        break;
      case 'cue':
        new ReferencedCues(key, details.name, details.schema, details.options || {});
        break;
      default:
        logger.warn(`Unknown item type '${details.class}' for key '${key}' in scriptReferencedItemType`);
    }
  }
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
export function findSimilarItems(targetName: string, availableItems: string[], maxSuggestions: number = 5): string[] {
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

export function checkReferencedItemAttributeType(
  schema: string,
  element: object,
  attributeName: string,
  attributeType: string
): ScriptReferencedItemsDetectionItem | undefined {
  const references = scriptReferencedItemsDetectionList.filter((item) => {
    const result =
      scriptReferencedItemType.get(item.type)?.schema === schema &&
      (item.element === '*' || item.element === element?.['name']) &&
      (item.attribute === undefined || item.attribute === attributeName) &&
      (item.attributeType === undefined || item.attributeType === attributeType);
    return result;
  });
  if (references.length === 0) {
    return undefined;
  }
  for (const reference of references) {
    let allowed = true;
    if (reference.filters) {
      const attributes: any[] = element?.['attributes'] || [];
      for (const filter of reference.filters) {
        const attribute = attributes.find((attr) => attr.name === filter.attribute);
        if (
          (filter.presented && (attribute === undefined || attribute['value'] !== filter.value)) ||
          (!filter.presented && attribute?.['value'] === filter.value)
        ) {
          allowed = false;
          break;
        }
      }
    }
    if (allowed) {
      return reference;
    }
  }
  return undefined;
}

export class ReferencedItemsTracker {
  // Map to store labels per document: Map<DocumentURI, Map<LabelName, vscode.Location>>
  public schema: string;
  protected documentReferencedItems: Map<vscode.TextDocument, ScriptReferencedItems> = new Map();
  protected itemType: string;
  protected itemName: string;
  protected options: ScriptReferencedItemOptions;

  constructor(itemType: string, itemName: string, schema: string, options?: ScriptReferencedItemOptions) {
    logger.info(`Initialized ReferencedItemsTracker for item type: ${itemType}`);
    this.itemType = itemType;
    this.schema = schema;
    this.options = options || {};
    this.itemName = itemName;
    // Register this tracker in the global registry
    this.registerTracker();
  }

  protected registerTracker(): void {
    scriptReferencedItemsRegistry.set(this.itemType, {
      type: this.itemType,
      tracker: this,
    });
    logger.debug(`Registered tracker type ${typeof this} for item type: ${this.itemType}`);
  }

  public static addReferencesForCompletion(type: string, script: string, name: string): void {
    const typeInfo = scriptReferencedItemType.get(type as ScriptReferencedItemTypeId);
    if (!typeInfo) {
      return;
    }
    if (!typeInfo.options?.prepareExternalReferences) {
      return; // Skip if prepareReferences is not enabled for this type
    }
    if (!referencesToCompletionItems.has(type)) {
      referencesToCompletionItems.set(type, new Map<string, string[]>());
    }
    const typeCompletions = referencesToCompletionItems.get(type);
    if (!typeCompletions.has(script)) {
      typeCompletions.set(script, []);
    }
    typeCompletions.get(script)?.push(name);
  }

  public static removeReferencesForCompletion(type: string, script: string, name: string): void {
    const typeCompletions = referencesToCompletionItems.get(type);
    if (!typeCompletions) {
      return;
    }
    const scriptCompletions = typeCompletions.get(script);
    if (!scriptCompletions) {
      return;
    }
    const index = scriptCompletions.indexOf(name);
    if (index !== -1) {
      scriptCompletions.splice(index, 1);
    }
    if (scriptCompletions.length === 0) {
      typeCompletions.delete(script);
    }
    if (typeCompletions.size === 0) {
      referencesToCompletionItems.delete(type);
    }
  }

  public addItemDefinition(metadata: ScriptMetadata, name: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentReferencedItems.has(document)) {
      this.documentReferencedItems.set(document, new Map<string, ScriptReferencedItemInfo>());
    }
    const itemsData = this.documentReferencedItems.get(document);

    if (!itemsData.has(name)) {
      // Create a new label info object if it doesn't exist
      itemsData.set(name, {
        name: name,
        scriptName: metadata.name,
        definition: new vscode.Location(document.uri, range),
        references: [],
      });
    } else {
      // If it exists, update the definition location if it's not already set
      const existingItem = itemsData.get(name)!;
      if (!existingItem.definition || existingItem.definition.range.isEmpty) {
        existingItem.definition = new vscode.Location(document.uri, range);
      }
    }
    ReferencedItemsTracker.addReferencesForCompletion(this.itemType, metadata.name, name);
  }

  public addItemReference(metadata: ScriptMetadata, name: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentReferencedItems.has(document)) {
      this.documentReferencedItems.set(document, new Map<string, ScriptReferencedItemInfo>());
    }
    let scriptName = metadata.name;
    if (metadata.schema === mdScriptSchema) {
      const nameSplitted = name.split('.');
      if (nameSplitted.length === 3 && nameSplitted[0] === 'md') {
        name = nameSplitted[2];
        scriptName = nameSplitted[1];
      }
    }
    const itemsData = this.documentReferencedItems.get(document);

    if (!itemsData.has(name)) {
      // Create a new label info object if it doesn't exist
      itemsData.set(name, {
        name: name,
        scriptName: scriptName,
        definition: undefined,
        references: [new vscode.Location(document.uri, range)],
      });
    } else {
      // If it exists, update the definition location if it's not already set
      const existingItem = itemsData.get(name)!;
      if (!existingItem.references.some((ref) => ref.range.isEqual(range))) {
        existingItem.references.push(new vscode.Location(document.uri, range));
      }
    }
  }

  public getItemAtPosition(document: vscode.TextDocument, position: vscode.Position): ScriptReferencedItemAtPosition | undefined {
    const documentData = this.documentReferencedItems.get(document);
    if (!documentData) {
      return undefined;
    }

    for (const [itemName, itemData] of documentData.entries()) {
      // Check if position is at a label definition
      if (itemData.definition && itemData.definition.range.contains(position)) {
        return {
          item: itemData,
          location: itemData.definition,
          isDefinition: true,
        };
      }
      // Check if position is at a label reference
      const referenceLocation = itemData.references.find((loc) => loc.range.contains(position));
      if (referenceLocation) {
        return {
          item: itemData,
          location: referenceLocation,
          isDefinition: false,
        };
      }
    }

    return undefined;
  }

  protected getDefinition(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location | undefined {
    return item.definition;
  }

  public getItemDefinition(document: vscode.TextDocument, position: vscode.Position): ScriptReferencedItemsDefinition | undefined {
    const item = this.getItemAtPosition(document, position);
    if (!item) {
      return undefined;
    }
    return {
      name: item.item.name,
      definition: this.getDefinition(document, item.item),
    };
  }

  protected getReferences(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location[] {
    return item.references;
  }

  public getItemReferences(document: vscode.TextDocument, position: vscode.Position): ScriptReferencedItemsReferences | undefined {
    const item = this.getItemAtPosition(document, position);
    if (!item) {
      return undefined;
    }

    const references = [...this.getReferences(document, item.item)];
    const definition = this.getDefinition(document, item.item);
    if (definition) {
      references.unshift(definition); // Include definition as a reference
    }
    return { name: item.item.name, references };
  }

  public getAllItemsForCompletion(document: vscode.TextDocument, prefix: string = ''): ScriptReferencedCompletion {
    const result: ScriptReferencedCompletion = new Map();
    const documentData = this.documentReferencedItems.get(document);
    if (!documentData) {
      return result;
    }
    // Process all labels
    for (const [itemName, itemData] of documentData.entries()) {
      if (itemData.definition && (prefix === '' || itemName.startsWith(prefix))) {
        // Only add the item if it matches the prefix
        result.set(itemName, this.getItemDetails(document, itemData, 'full'));
      }
    }

    return result;
  }

  public validateItems(document: vscode.TextDocument): vscode.Diagnostic[] {
    const metadata = getDocumentMetadata(document);
    const diagnostics: vscode.Diagnostic[] = [];
    const documentData = this.documentReferencedItems.get(document);
    if (!documentData) {
      return diagnostics;
    }

    for (const [itemName, itemData] of documentData.entries()) {
      // Check if the item is invalid (has no definition or references)
      const definition = this.getDefinition(document, itemData);
      if (!definition && !this.options.referenceAsExpression) {
        itemData.references.forEach((reference) => {
          let name = itemName;
          if (metadata.schema === mdScriptSchema && itemData.scriptName !== metadata.name) {
            name = `md.${itemData.scriptName}.${name}`;
          }
          const diagnostic = new vscode.Diagnostic(reference.range, `${this.itemName} '${name}' is not defined`, vscode.DiagnosticSeverity.Error);
          diagnostic.code = `undefined-${this.itemType}`;
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }
      const references = this.getReferences(document, itemData);
      if (references.length === 0 && !this.options.skipNotUsed) {
        const diagnostic = new vscode.Diagnostic(itemData.definition.range, `${this.itemName} '${itemName}' is not used`, vscode.DiagnosticSeverity.Warning);
        diagnostic.code = `unused-${this.itemType}`;
        diagnostic.source = 'X4CodeComplete';
        diagnostics.push(diagnostic);
      }
    }
    return diagnostics;
  }

  protected definitionToMarkdown(document: vscode.TextDocument, item: ScriptReferencedItemInfo): string {
    return `**Defined**: ${item.definition ? `at line ${item.definition.range.start.line + 1}` : '*No definition found!*'}`;
  }

  public getItemDetails(
    document: vscode.TextDocument,
    item: ScriptReferencedItemInfo,
    detailsType: 'full' | 'external' | 'definition' | 'reference'
  ): vscode.MarkdownString {
    const markdownString = new vscode.MarkdownString();
    const defined = this.definitionToMarkdown(document, item);
    const references = this.getReferences(document, item);
    const referenced = `**Referenced**: ${references.length} time${references.length !== 1 ? 's' : ''}`;
    if (detailsType === 'full' || detailsType === 'external') {
      markdownString.appendMarkdown(`*${this.itemName}*: **${item.name}**  \n`);
      markdownString.appendMarkdown(defined + '  \n');
      if (detailsType === 'full') {
        markdownString.appendMarkdown(referenced);
      }
    } else if (detailsType === 'definition') {
      markdownString.appendMarkdown(`**${this.itemName} Definition**: \`${item.name}\`  \n`);
      markdownString.appendMarkdown(referenced);
    } else {
      markdownString.appendMarkdown(`**${this.itemName} Reference**: \`${item.name}\`  \n`);
      markdownString.appendMarkdown(defined);
    }
    return markdownString;
  }

  public getItemHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const item = this.getItemAtPosition(document, position);
    if (!item) {
      return undefined;
    }
    const markdownString = this.getItemDetails(document, item.item, 'full');
    return new vscode.Hover(markdownString);
  }

  public getSimilarItems(document: vscode.TextDocument, name: string): string[] {
    const documentData = this.documentReferencedItems.get(document);
    if (!documentData) {
      return [];
    }

    const availableItems = Array.from(documentData.keys());
    const similarItems = findSimilarItems(name, availableItems);
    return similarItems;
  }

  public clearItemsForDocument(document: vscode.TextDocument): void {
    if (!this.documentReferencedItems.has(document)) {
      return; // No items to clear for this document
    }
    const thisDocumentData = this.documentReferencedItems.get(document);
    if (!thisDocumentData) {
      return; // No items to clear for this document
    }
    for (const item of thisDocumentData.values()) {
      ReferencedItemsTracker.removeReferencesForCompletion(this.itemType, item.scriptName, item.name);
    }
    thisDocumentData.clear();
    this.documentReferencedItems.delete(document);
  }

  public dispose(): void {
    this.documentReferencedItems.clear();
  }
}

export class ReferencedItemsWithExternalDefinitionsTracker extends ReferencedItemsTracker {
  protected externalDefinitions: Map<string, ScriptItemExternalDefinition> = new Map();

  protected static trackersWithExternalDefinitions: Map<string, externalTrackerInfo[]> = new Map();

  protected static registerTracker(itemType: string, tracker: ReferencedItemsWithExternalDefinitionsTracker | ReferencedCues): void {
    const itemInfo = scriptReferencedItemsDetectionList.find((item) => item.type === itemType && item.class === 'definition');
    if (!itemInfo) {
      logger.warn(`No item info found for item type: ${itemType}`);
      return;
    }
    const filePrefix = itemInfo?.filePrefix || '';
    const schema = tracker.schema || '';
    if (schema) {
      if (!this.trackersWithExternalDefinitions.has(schema)) {
        this.trackersWithExternalDefinitions.set(schema, []);
      }
      this.trackersWithExternalDefinitions.get(schema)?.push({
        elementName: itemInfo.element,
        attributeName: itemInfo.attribute,
        filters: itemInfo.filters || [],
        filePrefix,
        tracker,
      });
    }
  }

  public static clearAllExternalDefinitions(): void {
    for (const [schema, trackersInfo] of this.trackersWithExternalDefinitions.entries()) {
      for (const trackerInfo of trackersInfo) {
        trackerInfo.tracker.clearAllExternalDefinitions();
      }
    }
  }

  public static clearExternalDefinitionsForFile(schemaOfFile: string, filePath: string): void {
    for (const [schema, trackersInfo] of this.trackersWithExternalDefinitions.entries()) {
      if (schema !== schemaOfFile) {
        continue; // Skip if the schema does not match
      }
      for (const trackerInfo of trackersInfo) {
        trackerInfo.tracker.clearExternalDefinitionsForFile(filePath);
      }
    }
  }

  protected static collectExternalDefinitionsForTrackerAndFile(
    trackerInfo: externalTrackerInfo,
    filePath: string,
    fileContent: string,
    schema: string = '',
    metadata?: ScriptMetadata
  ): void {
    const prefixes = trackerInfo.filePrefix ? trackerInfo.filePrefix.split('|') : [''];
    const fileName = path.basename(filePath, '.xml');
    if (prefixes.length === 0 || prefixes.some((prefix) => fileName.startsWith(prefix))) {
      logger.debug(`Processing external definition for ${trackerInfo.elementName}#${trackerInfo.attributeName} in file: ${filePath}`);
      metadata = metadata || getMetadata(fileContent);
      if (!metadata) {
        logger.debug(`No metadata found for file: ${filePath}`);
        return;
      }
      if (schema && metadata.schema !== schema) {
        logger.debug(`Metadata schema mismatch for file: ${filePath}, expected: ${schema}, found: ${metadata.schema}`);
        return; // Skip if metadata is invalid or schema does not match
      }
      const regex = new RegExp(`<${trackerInfo.elementName}[^>]*?${trackerInfo.attributeName}="([^"]+)"[^>]*?>`, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(fileContent)) !== null) {
        if (trackerInfo.filters.length > 0) {
          const elementText = match[0];
          let allowed = true;
          for (const filter of trackerInfo.filters) {
            const attributeString = `${filter.attribute}="${filter.value}"`;
            if (
              (filter.presented && (elementText === undefined || !elementText.includes(attributeString))) ||
              (!filter.presented && elementText.includes(attributeString))
            ) {
              allowed = false;
              break;
            }
          }
          if (!allowed) {
            continue; // skip this match if it doesn't pass the filters
          }
        }
        const value = match[1];
        const valueIndex = match.index + match[0].indexOf(`"${value}"`);
        logger.debug(`Found external definition for ${trackerInfo.elementName}#${trackerInfo.attributeName} in file: ${filePath}, value: ${value}`);
        const line = fileContent.substring(0, match.index).split(/\r\n|\r|\n/).length - 1;
        const lineStart = Math.max(fileContent.lastIndexOf('\n', valueIndex), fileContent.lastIndexOf('\r', valueIndex));
        trackerInfo.tracker.addExternalDefinition(metadata, value, line, valueIndex - lineStart, value.length, filePath);
      }
    }
  }

  public static async collectExternalDefinitionsForFile(schemaOfFile: string, filePath: string): Promise<void> {
    let fileContent = '';
    try {
      fileContent = await fs.promises.readFile(filePath, 'utf8');
    } catch {
      logger.error(`Failed to read file: ${filePath}`);
      return;
    }
    this.clearExternalDefinitionsForFile(schemaOfFile, filePath);
    for (const [schema, trackersInfo] of this.trackersWithExternalDefinitions.entries()) {
      if (schema !== schemaOfFile) {
        continue; // Skip if the schema does not match
      }
      for (const trackerInfo of trackersInfo) {
        this.collectExternalDefinitionsForTrackerAndFile(trackerInfo, filePath, fileContent);
      }
    }
  }

  public static async collectExternalDefinitions(config: X4CodeCompleteConfig): Promise<void> {
    const mainFolders: string[] = [];
    if (config.unpackedFileLocation) {
      mainFolders.push(config.unpackedFileLocation);
    }
    if (config.extensionsFolder) {
      mainFolders.push(config.extensionsFolder);
    }
    logger.debug(`Collecting external definitions from main folders: ${mainFolders.join(', ')}`);

    const isDir = async (p: string): Promise<boolean> => {
      try {
        const st = await fs.promises.stat(p);
        return st.isDirectory();
      } catch {
        return false;
      }
    };
    const filesData: Map<string, { content: string; metadata: ScriptMetadata }> = new Map();
    const folders: string[] = [];
    for (const mainFolder of mainFolders) {
      if (await isDir(mainFolder)) {
        let firstLevel: fs.Dirent[] = [];
        try {
          firstLevel = await fs.promises.readdir(mainFolder, { withFileTypes: true });
        } catch {
          firstLevel = [];
        }
        for (const entry of firstLevel) {
          if (entry.isDirectory()) {
            const firstLevelPath = path.join(mainFolder, entry.name);
            if (scriptsSchemas.includes(entry.name.toLowerCase())) {
              folders.push(firstLevelPath);
            } else {
              try {
                const secondLevel = await fs.promises.readdir(firstLevelPath, { withFileTypes: true });
                for (const subEntry of secondLevel) {
                  if (subEntry.isDirectory() && scriptsSchemas.includes(subEntry.name.toLowerCase())) {
                    folders.push(path.join(firstLevelPath, subEntry.name));
                  }
                }
              } catch {
                // ignore subfolder read errors
              }
            }
          }
        }
      }
    }

    for (const [schema, trackersInfo] of this.trackersWithExternalDefinitions.entries()) {
      logger.debug(`Collecting external definitions for ${folders.length} folders`);
      for (const folder of folders) {
        if (await isDir(folder)) {
          logger.debug(`Processing folder: ${folder}`);
          let entry: fs.Dirent[] = [];
          try {
            entry = await fs.promises.readdir(folder, { withFileTypes: true });
          } catch {
            entry = [];
          }
          const files = entry.filter((d) => d.isFile() && d.name.endsWith('.xml')).map((d) => path.join(folder, d.name));
          for (const filePath of files) {
            logger.debug(`Processing file: ${filePath}`);
            let fileContent = '';
            let fileMetadata: ScriptMetadata | undefined;
            if (filesData.has(filePath)) {
              const { content, metadata } = filesData.get(filePath)!;
              fileContent = content;
              fileMetadata = metadata;
            } else {
              try {
                logger.debug(`Read file: ${filePath}`);
                fileContent = await fs.promises.readFile(filePath, 'utf8');
              } catch {
                return; // skip unreadable files
              }
              fileMetadata = getMetadata(fileContent);
              filesData.set(filePath, { content: fileContent, metadata: fileMetadata });
            }
            for (const trackerInfo of trackersInfo) {
              this.collectExternalDefinitionsForTrackerAndFile(trackerInfo, filePath, fileContent, schema, fileMetadata);
            }
          }
        }
      }
    }
  }

  constructor(itemType: string, itemName: string, schema: string, options?: ScriptReferencedItemOptions) {
    super(itemType, itemName, schema, options);
    ReferencedItemsWithExternalDefinitionsTracker.registerTracker(itemType, this);
  }

  protected registerTracker(): void {
    scriptReferencedItemsRegistry.set(this.itemType, {
      type: this.itemType,
      tracker: this,
    });
    logger.debug(`Registered tracker type ${typeof this} for item type: ${this.itemType}`);
  }

  public addExternalDefinition(metadata: ScriptMetadata, value: string, line: number, position: number, length: number, fileName: string): void {
    const definition = new vscode.Location(
      vscode.Uri.file(fileName),
      new vscode.Range(new vscode.Position(line, position), new vscode.Position(line, position + length))
    );
    this.externalDefinitions.set(metadata.schema === aiScriptSchema ? value : `md.${metadata.name}.${value}`, {
      name: value,
      scriptName: metadata.name,
      definition,
    });
    ReferencedItemsTracker.addReferencesForCompletion(this.itemType, metadata.name, value);
  }

  protected getDefinition(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location | undefined {
    const metadata = getDocumentMetadata(document);
    if (item.definition) {
      if (metadata.schema === aiScriptSchema || item.scriptName === metadata.name) {
        return super.getDefinition(document, item);
      }
    } else {
      const definitions = Array.from(this.documentReferencedItems.values());
      const externalDefinitions = definitions.filter(
        (def) =>
          def.has(item.name) && (metadata.schema === aiScriptSchema || def.get(item.name)?.scriptName === item.scriptName) && def.get(item.name)?.definition
      );
      if (externalDefinitions && externalDefinitions.length > 0) {
        return externalDefinitions[0].get(item.name)?.definition;
      }
      const externalDefinition = this.externalDefinitions.get(metadata.schema === aiScriptSchema ? item.name : `md.${item.scriptName}.${item.name}`);
      if (externalDefinition) {
        return externalDefinition.definition;
      }
    }
    return undefined;
  }

  protected getReferences(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location[] {
    return Array.from(this.documentReferencedItems.values()).flatMap((itemMap) => itemMap.get(item.name)?.references || []);
  }

  public getAllItemsForCompletion(document: vscode.TextDocument, prefix: string = ''): ScriptReferencedCompletion {
    const result: ScriptReferencedCompletion = new Map();
    const documentData = this.documentReferencedItems.get(document);
    if (!documentData) {
      return result;
    }

    // Process all labels
    for (const [itemName, itemData] of documentData.entries()) {
      if (itemData.definition && (prefix === '' || itemName.startsWith(prefix))) {
        // Only add the item if it matches the prefix
        result.set(itemName, this.getItemDetails(document, itemData, 'full'));
      }
    }
    const documentFolder = path.dirname(document.uri.fsPath);
    // Process all labels
    for (const [itemName, itemData] of documentData.entries()) {
      if (itemData.definition && (prefix === '' || itemName.startsWith(prefix)) && itemData.definition.uri.fsPath.startsWith(documentFolder)) {
        // Only add the item if it matches the prefix
        if (!result.has(itemName)) {
          result.set(itemName, this.getItemDetails(document, itemData, 'external'));
        }
      }
    }
    for (const [itemName, externalDefinition] of this.externalDefinitions.entries()) {
      if (externalDefinition.definition && (prefix === '' || itemName.startsWith(prefix))) {
        // Only add the item if it matches the prefix
        if (!result.has(itemName)) {
          result.set(
            itemName,
            this.getItemDetails(
              document,
              { name: itemName, scriptName: externalDefinition.scriptName, definition: externalDefinition.definition, references: [] },
              'external'
            )
          );
        }
      }
    }

    return result;
  }

  protected definitionToMarkdown(document: vscode.TextDocument, item: ScriptReferencedItemInfo): string {
    const definition = this.getDefinition(document, item);
    if (definition === undefined || definition.uri.toString() === document.uri.toString()) {
      return super.definitionToMarkdown(document, item);
    } else {
      return `**Defined**: at line ${definition.range.start.line + 1} in \`${path.basename(definition.uri.fsPath)}\``;
    }
  }

  public clearExternalDefinitionsForFile(filePath: string): void {
    for (const [value, definition] of this.externalDefinitions.entries()) {
      if (definition.definition.uri.fsPath === filePath) {
        ReferencedItemsTracker.removeReferencesForCompletion(this.itemType, definition.scriptName, definition.name);
        this.externalDefinitions.delete(value);
      }
    }
  }

  public clearAllExternalDefinitions(): void {
    this.externalDefinitions.clear();
  }
}
export class ReferencedCues extends ReferencedItemsWithExternalDefinitionsTracker {
  constructor(itemType: string, itemName: string, schema: string, options?: ScriptReferencedItemOptions) {
    super(itemType, itemName, schema, options);
  }

  protected static findCueElementForName(name: string, element: XmlElement): XmlElement | undefined {
    let cue = element;
    while (
      cue &&
      cue.parent &&
      (cue.name !== 'cue' || (name === 'namespace' && !(cue.attributes.some((attr) => attr.name === 'namespace') || cue.parent?.name === 'cues')))
    ) {
      cue = cue.parent;
    }
    if (name === 'parent') {
      let parent = cue;
      if (parent && parent.name === 'cue') {
        while (parent && parent.name !== 'cue' && parent.parent) {
          parent = parent.parent;
        }
      }
      cue = parent;
    }
    if (cue && cue.name === 'cue') {
      return;
    }
    return undefined;
  }

  protected getDefinition(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location | undefined {
    return super.getDefinition(document, item);
  }

  protected getReferences(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location[] {
    return super.getReferences(document, item);
  }

  public addItemReference(metadata: ScriptMetadata, name: string, document: vscode.TextDocument, range: vscode.Range): void {
    if (!this.documentReferencedItems.has(document)) {
      this.documentReferencedItems.set(document, new Map<string, ScriptReferencedItemInfo>());
    }
    const itemsData = this.documentReferencedItems.get(document);
    if (!itemsData.has(name) && ['this', 'parent', 'static', 'namespace'].includes(name)) {
      itemsData.set(name, {
        name: name,
        scriptName: metadata.name,
        definition: new vscode.Location(document.uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1))),
        references: [],
      });
    }
    super.addItemReference(metadata, name, document, range);
  }
}
initializeScriptReferencedItemsDetectionMap();
