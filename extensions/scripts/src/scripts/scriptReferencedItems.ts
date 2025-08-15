import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import { X4CodeCompleteConfig } from '../extension/configuration';
import path from 'path';
import fs from 'fs';
import { aiScriptId, mdScriptId } from './scriptsMetadata';

export interface ScriptReferencedItemInfo {
  name: string;
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

export type ScriptReferencedItemTypeId = 'label' | 'actions' | 'handler' | 'library_run' | 'library_include';
export type ScriptReferencedItemClassId = 'basic' | 'external';
export type ScriptReferencedItemDetails = {
  type: ScriptReferencedItemTypeId;
  name: string;
  class: ScriptReferencedItemClassId;
  schema?: string;
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
  attribute: string; // The attribute to check for references
  type: ScriptReferencedItemTypeId;
  attrType: 'definition' | 'reference';
  filePrefix?: string; // Optional prefix for external definitions
  noCompletion?: boolean; // Optional flag to disable completion for this item
  filter?: ScriptReferencedItemsFilterItem[]; // Optional filter for item detection
}

type ScriptReferencedItemsDetectionList = ScriptReferencedItemsDetectionItem[];

interface ScriptItemExternalDefinition {
  name: string;
  definition: vscode.Location;
}

interface externalTrackerInfo {
  elementName: string;
  attributeName: string;
  filePrefix: string; // Optional prefix for external definitions
  tracker: ReferencedItemsWithExternalDefinitionsTracker;
}

interface ScriptReferencedItemsRegistryItem {
  type: string;
  tracker: ReferencedItemsTracker | ReferencedItemsWithExternalDefinitionsTracker;
}

type ScriptReferencedItemsRegistry = Map<string, ScriptReferencedItemsRegistryItem>;

const scriptReferencedItemType: ScriptReferencedItemType = new Map([
  ['label', { type: 'label', name: 'Label', class: 'basic', schema: aiScriptId }],
  ['actions', { type: 'actions', name: 'Actions', class: 'external', schema: aiScriptId }],
  ['handler', { type: 'handler', name: 'Handler', class: 'external', schema: aiScriptId }],
  ['library_run', { type: 'library_run', name: 'Library run Action', class: 'basic', schema: mdScriptId }],
  ['library_include', { type: 'library_include', name: 'Library include Action', class: 'basic', schema: mdScriptId }],
]);

const scriptReferencedItemsDetectionList: ScriptReferencedItemsDetectionList = [
  { element: 'label', attribute: 'name', type: 'label', attrType: 'definition', noCompletion: true },
  { element: 'resume', attribute: 'label', type: 'label', attrType: 'reference' },
  { element: 'run_interrupt_script', attribute: 'resume', type: 'label', attrType: 'reference' },
  { element: 'abort_called_scripts', attribute: 'resume', type: 'label', attrType: 'reference' },
  { element: 'actions', attribute: 'name', type: 'actions', attrType: 'definition', noCompletion: true, filePrefix: 'lib.|interrupt.' },
  { element: 'include_interrupt_actions', attribute: 'ref', type: 'actions', attrType: 'reference' },
  { element: 'handler', attribute: 'name', type: 'handler', attrType: 'definition', noCompletion: true, filePrefix: 'interrupt.' },
  { element: 'handler', attribute: 'ref', type: 'handler', attrType: 'reference' },
  {
    element: 'library',
    attribute: 'name',
    type: 'library_run',
    attrType: 'definition',
    noCompletion: true,
    filter: [{ attribute: 'purpose', value: 'run_actions', presented: true }],
  },
  { element: 'run_actions', attribute: 'ref', type: 'library_run', attrType: 'reference' },
  {
    element: 'library',
    attribute: 'name',
    type: 'library_include',
    attrType: 'definition',
    noCompletion: true,
    filter: [{ attribute: 'purpose', value: 'run_actions', presented: false }],
  },
  { element: 'include_actions', attribute: 'ref', type: 'library_include', attrType: 'reference' },
];

export const scriptReferencedItemsRegistry: ScriptReferencedItemsRegistry = new Map();

function initializeScriptReferencedItemsDetectionMap() {
  for (const [key, details] of scriptReferencedItemType.entries()) {
    switch (details.class) {
      case 'basic':
        new ReferencedItemsTracker(key, details.name, details.schema);
        break;
      case 'external':
        new ReferencedItemsWithExternalDefinitionsTracker(key, details.name, details.schema);
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

export function checkReferencedItemAttributeType(schema: string, element: object, attributeName: string): ScriptReferencedItemsDetectionItem | undefined {
  const references = scriptReferencedItemsDetectionList.filter((item) => {
    const result = scriptReferencedItemType.get(item.type)?.schema === schema && item.element === element?.['name'] && item.attribute === attributeName;
    return result;
  });
  if (references.length === 0) {
    return undefined;
  }
  for (const reference of references) {
    let allowed = true;
    if (reference.filter) {
      const attributes: any[] = element?.['attributes'] || [];
      for (const filter of reference.filter) {
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

  constructor(itemType: string, itemName: string, schema: string) {
    logger.info(`Initialized ReferencedItemsTracker for item type: ${itemType}`);
    this.itemType = itemType;
    this.schema = schema;
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

  public addItemDefinition(name: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentReferencedItems.has(document)) {
      this.documentReferencedItems.set(document, new Map<string, ScriptReferencedItemInfo>());
    }
    const itemsData = this.documentReferencedItems.get(document);

    if (!itemsData.has(name)) {
      // Create a new label info object if it doesn't exist
      itemsData.set(name, {
        name: name,
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
  }

  public addItemReference(name: string, document: vscode.TextDocument, range: vscode.Range): void {
    // Get or create the label map for the document
    if (!this.documentReferencedItems.has(document)) {
      this.documentReferencedItems.set(document, new Map<string, ScriptReferencedItemInfo>());
    }
    const itemsData = this.documentReferencedItems.get(document);

    if (!itemsData.has(name)) {
      // Create a new label info object if it doesn't exist
      itemsData.set(name, {
        name: name,
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
    const diagnostics: vscode.Diagnostic[] = [];
    const documentData = this.documentReferencedItems.get(document);
    if (!documentData) {
      return diagnostics;
    }

    for (const [itemName, itemData] of documentData.entries()) {
      // Check if the item is invalid (has no definition or references)
      const definition = this.getDefinition(document, itemData);
      if (!definition) {
        itemData.references.forEach((reference) => {
          const diagnostic = new vscode.Diagnostic(reference.range, `${this.itemName} '${itemName}' is not defined`, vscode.DiagnosticSeverity.Error);
          diagnostic.code = `undefined-${this.itemType}`;
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }
      const references = this.getReferences(document, itemData);
      if (references.length === 0) {
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
    this.documentReferencedItems.delete(document);
  }

  public dispose(): void {
    this.documentReferencedItems.clear();
  }
}

export class ReferencedItemsWithExternalDefinitionsTracker extends ReferencedItemsTracker {
  protected externalDefinitions: Map<string, ScriptItemExternalDefinition> = new Map();

  private static trackersWithExternalDefinitions: Map<string, externalTrackerInfo[]> = new Map();

  private static registerTracker(itemType: string, tracker: ReferencedItemsWithExternalDefinitionsTracker): void {
    const itemInfo = scriptReferencedItemsDetectionList.find((item) => item.type === itemType && item.attrType === 'definition');
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
        filePrefix,
        tracker,
      });
    }
  }

  public static clearExternalDefinitions(): void {
    for (const [schema, trackersInfo] of this.trackersWithExternalDefinitions.entries()) {
      for (const trackerInfo of trackersInfo) {
        trackerInfo.tracker.clearExternalDefinitions();
      }
    }
  }

  public static collectExternalDefinitions(config: X4CodeCompleteConfig) {
    const folders: string[] = [];
    const mainFolders: string[] = [];
    // if (config.extensionsFolder) {
    //   mainFolders.push(config.extensionsFolder);
    // }
    if (config.unpackedFileLocation) {
      mainFolders.push(config.unpackedFileLocation);
    }
    logger.debug(`Collecting external definitions from main folders: ${mainFolders.join(', ')}`);
    for (const [schema, trackersInfo] of this.trackersWithExternalDefinitions.entries()) {
      logger.debug(`Tracker for ${schema} has ${trackersInfo.length} trackers`);
      for (const mainFolder of mainFolders) {
        // Find and push any aiscripts subfolders, including indirect (up to 2 levels deep)
        if (fs.existsSync(mainFolder)) {
          const firstLevel = fs.readdirSync(mainFolder, { withFileTypes: true });
          for (const entry of firstLevel) {
            if (entry.isDirectory()) {
              const firstLevelPath = path.join(mainFolder, entry.name);
              if (entry.name.toLowerCase() === schema.toLowerCase()) {
                folders.push(firstLevelPath);
              } else {
                // Check second level
                const secondLevel = fs.readdirSync(firstLevelPath, { withFileTypes: true });
                for (const subEntry of secondLevel) {
                  if (subEntry.isDirectory() && subEntry.name.toLowerCase() === schema.toLowerCase()) {
                    folders.push(path.join(firstLevelPath, subEntry.name));
                  }
                }
              }
            }
          }
        }
      }
      logger.debug(`Collecting external definitions for ${folders.length} folders`);
      for (const folder of folders) {
        if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
          logger.debug(`Processing folder: ${folder}`);
          const files = fs
            .readdirSync(folder, { withFileTypes: true })
            .filter((item) => item.isFile() && item.name.endsWith('.xml'))
            .map((item) => path.join(folder, item.name));
          for (const file of files) {
            logger.debug(`Processing file: ${file}`);
            const fileName = path.basename(file, '.xml');
            let fileContent: string = '';
            for (const trackerInfo of trackersInfo) {
              const prefixes = trackerInfo.filePrefix ? trackerInfo.filePrefix.split('|') : [''];
              if (prefixes.length === 0 || prefixes.some((prefix) => fileName.startsWith(prefix))) {
                logger.debug(`Processing external definition for ${trackerInfo.elementName}#${trackerInfo.attributeName} in file: ${file}`);
                if (!fileContent && fs.existsSync(file)) {
                  fileContent = fs.readFileSync(file, 'utf8');
                }
                const regex = new RegExp(`<${trackerInfo.elementName}[^>]*?${trackerInfo.attributeName}="([^"]+)"[^>]*?>`, 'g');
                let match;
                while ((match = regex.exec(fileContent)) !== null) {
                  const value = match[1];
                  const valueIndex = match.index + match[0].indexOf(`"${value}"`);
                  logger.debug(`Found external definition for ${trackerInfo.elementName}#${trackerInfo.attributeName} in file: ${file}, value: ${value}`);
                  const line = fileContent.substring(0, match.index).split(/\r\n|\r|\n/).length - 1;
                  const lineStart = Math.max(fileContent.lastIndexOf('\n', valueIndex), fileContent.lastIndexOf('\r', valueIndex));
                  trackerInfo.tracker.addExternalDefinition(value, line, valueIndex - lineStart, value.length, file);
                }
              }
            }
          }
        }
      }
    }
  }

  constructor(itemType: string, itemName: string, schema: string) {
    super(itemType, itemName, schema);
    ReferencedItemsWithExternalDefinitionsTracker.registerTracker(itemType, this);
  }

  protected registerTracker(): void {
    scriptReferencedItemsRegistry.set(this.itemType, {
      type: this.itemType,
      tracker: this,
    });
    logger.debug(`Registered tracker type ${typeof this} for item type: ${this.itemType}`);
  }

  public addExternalDefinition(value: string, line: number, position: number, length: number, fileName: string): void {
    const definition = new vscode.Location(
      vscode.Uri.file(fileName),
      new vscode.Range(new vscode.Position(line, position), new vscode.Position(line, position + length))
    );
    this.externalDefinitions.set(value, { name: value, definition });
  }

  protected getDefinition(document: vscode.TextDocument, item: ScriptReferencedItemInfo): vscode.Location | undefined {
    if (item.definition) {
      return super.getDefinition(document, item);
    } else {
      const definitions = Array.from(this.documentReferencedItems.values());
      const externalDefinitions = definitions.filter((def) => def.has(item.name) && def.get(item.name)?.definition);
      if (externalDefinitions && externalDefinitions.length > 0) {
        return externalDefinitions[0].get(item.name)?.definition;
      }
      const externalDefinition = this.externalDefinitions.get(item.name);
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
          result.set(itemName, this.getItemDetails(document, { name: itemName, definition: externalDefinition.definition, references: [] }, 'external'));
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

  public clearExternalDefinitions(): void {
    this.externalDefinitions.clear();
  }
}

initializeScriptReferencedItemsDetectionMap();
