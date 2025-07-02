import * as vscode from 'vscode';
import { logger } from '../logger/logger';

export type ScriptReferencedItemInfo = {
  name: string;
  definition: vscode.Location;
  references: vscode.Location[];
};

export type ScriptReferencedItemAtPosition = {
  item: ScriptReferencedItemInfo;
  location: vscode.Location;
  isDefinition: boolean;
};

export type ScriptReferencedItems = Map<string, ScriptReferencedItemInfo>;

export type ScriptReferencedItemsDefinition = {
  name: string;
  definition: vscode.Location;
};

export type ScriptReferencedItemsReferences = {
  name: string;
  references: vscode.Location[];
};

export type ScriptReferencedCompletion = Map<string, vscode.MarkdownString>;

export type ScriptReferencedItemsDetectionItem = {
  type: 'label' | 'actions';
  attrType: 'definition' | 'reference';
};

type ScriptReferencedItemsDetectionMap = Map<string, ScriptReferencedItemsDetectionItem>;


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

const scriptReferencedItemsDetectionMap: ScriptReferencedItemsDetectionMap = new Map([
  ['label#name', { type: 'label', attrType: 'definition' }],
  ['resume#label', { type: 'label', attrType: 'reference' }],
  ['run_interrupt_script#resume', { type: 'label', attrType: 'reference' }],
  ['abort_called_scripts#resume', { type: 'label', attrType: 'reference' }],
  ['actions#name', { type: 'actions', attrType: 'definition' }],
  ['include_interrupt_actions#ref', { type: 'actions', attrType: 'reference' }],
]);



export function checkReferencedItemAttributeType(elementName, attributeName): ScriptReferencedItemsDetectionItem | undefined {
  let key = `${elementName}#${attributeName}`;
  if (scriptReferencedItemsDetectionMap.has(key)) {
    const item = scriptReferencedItemsDetectionMap.get(key);
    return item ? item : undefined;
  }
  return undefined;
}

export class ReferencedItemsTracker {
  // Map to store labels per document: Map<DocumentURI, Map<LabelName, vscode.Location>>
  private documentReferencedItems: WeakMap<vscode.TextDocument, ScriptReferencedItems> = new WeakMap();
  private itemType: string;
  private itemTypeCapitalized: string;

  constructor(itemType: string) {
    logger.info(`Initialized ReferencedItemsTracker for item type: ${itemType}`);
    this.itemType = itemType;
    this.itemTypeCapitalized = this.itemType.charAt(0).toUpperCase() + this.itemType.slice(1);
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

  public getItemDefinition(document: vscode.TextDocument, position: vscode.Position): ScriptReferencedItemsDefinition | undefined {

    const item = this.getItemAtPosition(document, position);
    if (!item) {
      return undefined;
    }
    return {
      name: item.item.name,
      definition: item.item.definition,
    };
  }

  public getItemReferences(document: vscode.TextDocument, position: vscode.Position): ScriptReferencedItemsReferences | undefined {
    const item = this.getItemAtPosition(document, position);
    if (!item) {
      return undefined;
    }

    const references = [...item.item.references];
    if (item.item.definition) {
      references.unshift(item.item.definition); // Include definition as a reference
    }
    return {name: item.item.name, references};
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
        result.set(itemName, this.getItemDetails(itemData, 'full'));
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
      if (!itemData.definition) {
        itemData.references.forEach((reference) => {
            const diagnostic = new vscode.Diagnostic(
            reference.range,
            `${this.itemTypeCapitalized} '${itemName}' is not defined`,
            vscode.DiagnosticSeverity.Error
            );
          diagnostic.code = `undefined-${this.itemType}`;
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      } else if (itemData.references.length === 0) {
        const diagnostic = new vscode.Diagnostic(
          itemData.definition.range,
          `${this.itemTypeCapitalized} '${itemName}' is not used`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = `unused-${this.itemType}`;
        diagnostic.source = 'X4CodeComplete';
        diagnostics.push(diagnostic);
      }
    }
    return diagnostics;
  }

  public getItemDetails(item: ScriptReferencedItemInfo, detailsType: 'full' | 'definition' | 'reference'): vscode.MarkdownString {
    const markdownString = new vscode.MarkdownString();
    const defined = `**Defined**: ${item.definition ? `at line ${item.definition.range.start.line + 1}` : '*No definition found!*'}`;
    const referenced = `**Referenced**: ${item.references.length} time${item.references.length !== 1 ? 's' : ''}`;
    if (detailsType === 'full') {
      markdownString.appendMarkdown(`**${this.itemTypeCapitalized}**: \`${item.name}\`\n\n`);
      markdownString.appendMarkdown(defined + '\n\n');
      markdownString.appendMarkdown(referenced);
    } else if (detailsType === 'definition') {
      markdownString.appendMarkdown(`**${this.itemTypeCapitalized} Definition**: \`${item.name}\`\n\n`);
      markdownString.appendMarkdown(referenced);
    } else {
      markdownString.appendMarkdown(`**${this.itemTypeCapitalized} Reference**: \`${item.name}\`\n\n`);
      markdownString.appendMarkdown(defined);
    }
    return markdownString;
  }

  public getItemHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const item = this.getItemAtPosition(document, position);
    if (!item) {
      return undefined;
    }
    const markdownString = this.getItemDetails(item.item, 'full');
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
    this.documentReferencedItems = new WeakMap();
  }
}
