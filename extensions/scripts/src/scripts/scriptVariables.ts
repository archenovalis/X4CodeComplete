import * as vscode from 'vscode';
import { aiScriptSchema, getDocumentScriptType, scriptIdDescription } from './scriptsMetadata';
import { XmlElement } from '../xml/xmlStructureTracker';
import IntervalTree from 'node-interval-tree';

/** Regular expressions and constants for pattern matching */
export const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
export const variablePatternExact = /^@?\$[a-zA-Z_][a-zA-Z0-9_]*$/;
export const tableKeyPattern = /table\[/;

export interface ScriptVariableInfo {
  name: string;
  schema: string;
  type: string;
  scope: ScopeInfo;
  definition?: vscode.Location;
  definitionPriority?: number;
  references: vscode.Location[];
}

class ScriptVariablesIndex {
  private definitionIndex: IntervalTree<ScriptVariableAtPosition>;
  private referenceIndex: IntervalTree<ScriptVariableAtPosition>;
  private list: Record<string, ScriptVariableInfo>;

  constructor() {
    this.definitionIndex = new IntervalTree<ScriptVariableAtPosition>();
    this.referenceIndex = new IntervalTree<ScriptVariableAtPosition>();
    this.list = {};
  }

  private rangeToIndexes(document: vscode.TextDocument, range: vscode.Range): [number, number] {
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);
    return [startOffset, endOffset];
  }

  public addDefinition(document: vscode.TextDocument, variable: ScriptVariableInfo, range: vscode.Range): void {
    const key: string = `${variable.scope.name}:${variable.name}`;
    let current: ScriptVariableInfo | undefined = this.list[key];
    if (!current) {
      current = variable;
      this.list[key] = variable;
    }
    current.definition = new vscode.Location(document.uri, range);
    const [start, end] = this.rangeToIndexes(document, range);
    this.definitionIndex.insert(start, end, { variable: current, location: current.definition });
  }

  public addReference(document: vscode.TextDocument, variable: ScriptVariableInfo, range: vscode.Range): void {
    const key: string = `${variable.scope.name}:${variable.name}`;
    let current: ScriptVariableInfo | undefined = this.list[key];
    if (!current) {
      current = variable;
      this.list[key] = variable;
    }
    current.references.push(new vscode.Location(document.uri, range));
    const [start, end] = this.rangeToIndexes(document, range);
    this.referenceIndex.insert(start, end, { variable: current, location: new vscode.Location(document.uri, range) });
  }

  public getByDefinitionOffset(offset: number): ScriptVariableAtPosition | undefined {
    const results = this.definitionIndex.search(offset, offset);
    return results.length > 0 ? results[0] : undefined;
  }

  public getByReferenceOffset(offset: number): ScriptVariableAtPosition | undefined {
    const results = this.referenceIndex.search(offset, offset);
    return results.length > 0 ? results[0] : undefined;
  }

  public findByPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableAtPosition | undefined {
    const offset = document.offsetAt(position);
    const definitionResults = this.definitionIndex.search(offset, offset);
    if (definitionResults.length > 0) {
      return definitionResults[0];
    }
    const referenceResults = this.referenceIndex.search(offset, offset);
    return referenceResults.length > 0 ? referenceResults[0] : undefined;
  }

  public getAllVariables(): ScriptVariableInfo[] {
    return Object.values(this.list);
  }

  public renameVariable(variable: ScriptVariableInfo, newName: string): void {
    const oldKey = `${variable.scope.name}:${variable.name}`;
    const newKey = `${variable.scope.name}:${newName}`;
    if (this.list[oldKey]) {
      variable.name = newName;
      this.list[newKey] = variable;
      delete this.list[oldKey];
    }
  }
}

type ScriptVariablesMap = Map<string, ScriptVariableInfo>;
type ScriptVariablesPerType = Map<string, ScriptVariablesMap>;
type ScriptVariablesPerDocument = WeakMap<vscode.TextDocument, ScriptVariablesIndex>;

export type ScriptVariableAtPosition = {
  variable: ScriptVariableInfo;
  location: vscode.Location;
};

export type ScriptVariableDefinition = {
  name: string;
  definition: vscode.Location;
};

export type ScriptVariableReferences = {
  name: string;
  references: vscode.Location[];
};

const variableTypes = {
  normal: 'usual variable',
  tableKey: 'remote or table variable',
};

type ScopeInfo = {
  name: string;
  attributesPresented: Set<string>;
  attributesExcluded: Set<string>;
  priority: number;
  parent?: string;
  asScope?: string;
  topParent?: boolean;
  externalDefinitions: Set<string>;
};

export class ScopeParser {
  // Implementation for scope parsing
  public static tableKey: ScopeInfo = {
    name: 'tableKey',
    attributesPresented: new Set(),
    attributesExcluded: new Set(),
    priority: 0,
    parent: undefined,
    asScope: undefined,
    topParent: true,
    externalDefinitions: new Set(),
  };
  public static aiScriptScopes: ScopeInfo[] = [
    {
      name: 'aiscript',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 100,
      parent: undefined,
      asScope: undefined,
      topParent: true,
      externalDefinitions: new Set(),
    },
    {
      name: 'params',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 0,
      parent: undefined,
      asScope: 'aiscript',
      topParent: false,
      externalDefinitions: new Set(),
    },
    {
      name: 'init',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 10,
      parent: undefined,
      asScope: 'aiscript',
      topParent: false,
      externalDefinitions: new Set(),
    },
    {
      name: 'handler',
      attributesPresented: new Set(['name']),
      attributesExcluded: new Set(),
      priority: 200,
      parent: undefined,
      asScope: undefined,
      topParent: true,
      externalDefinitions: new Set(['any', 'aiscript']),
    },
    {
      name: 'actions',
      attributesPresented: new Set(['name']),
      attributesExcluded: new Set(),
      priority: 200,
      parent: undefined,
      asScope: undefined,
      topParent: true,
      externalDefinitions: new Set(['any', 'aiscript']),
    },
    {
      name: 'actions',
      attributesPresented: new Set(),
      attributesExcluded: new Set(['name']),
      priority: 100,
      parent: undefined,
      asScope: 'aiscript',
      topParent: false,
      externalDefinitions: new Set(),
    },
    {
      name: 'do_all',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 150,
      parent: undefined,
      asScope: undefined,
      topParent: false,
      externalDefinitions: new Set(['top-parent']),
    },
    {
      name: 'do_for_each',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 150,
      parent: undefined,
      asScope: undefined,
      topParent: false,
      externalDefinitions: new Set(['top-parent']),
    },
    {
      name: 'do_any',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 150,
      parent: undefined,
      asScope: undefined,
      topParent: false,
      externalDefinitions: new Set(),
    },
    {
      name: 'do_while',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 150,
      parent: undefined,
      asScope: 'parent',
      topParent: false,
      externalDefinitions: new Set(['top-parent']),
    },
  ];
  public static mdScriptScopes: ScopeInfo[] = [
    {
      name: 'cue',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 100,
      parent: undefined,
      asScope: undefined,
      topParent: true,
      externalDefinitions: new Set(),
    },
  ];
}

export class VariableTracker {
  // Map to store variables per document: Map<scriptType, Map<DocumentURI, Map<variablesType, Map<variableName, {...}>>>>
  documentVariables: ScriptVariablesPerDocument = new WeakMap<vscode.TextDocument, ScriptVariablesIndex>();

  public addVariable(
    type: string,
    name: string,
    schema: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    isDefinition: boolean = false,
    definitionPriority?: number,
    element?: XmlElement
  ): void {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;

    let variablesIndex: ScriptVariablesIndex;
    // Get or create the scriptType level
    if (!this.documentVariables.has(document)) {
      variablesIndex = new ScriptVariablesIndex();
      this.documentVariables.set(document, variablesIndex);
    } else {
      variablesIndex = this.documentVariables.get(document)!;
    }
    const variable = {
      name: normalizedName,
      schema: schema,
      type: type,
      references: [],
      scope: schema === aiScriptSchema ? ScopeParser.aiScriptScopes[0] : ScopeParser.mdScriptScopes[0],
    };
    if (type === 'tableKey') variable.scope = ScopeParser.tableKey;
    if (isDefinition) {
      variablesIndex.addDefinition(document, variable, range);
    } else {
      variablesIndex.addReference(document, variable, range);
    }

    // // Get or create the variable type level
    // if (!variablesIndex.has(type)) {
    //   variablesIndex.set(type, new Map());
    // }
    // const typeMap = variablesIndex.get(type)!;

    // // Get or create the variable name level
    // if (!typeMap.has(normalizedName)) {
    //   typeMap.set(normalizedName, { name: normalizedName, schema: schema, type: type, references: [], scope: new ScopeInfo() });
    // }
    // const variableData = typeMap.get(normalizedName)!;

    // // Add to locations
    // variableData.references.push(new vscode.Location(document.uri, range));

    // // Handle definition if this is marked as one
    // if (isDefinition && definitionPriority !== undefined) {
    //   // Only set definition if we don't have one, or if this has higher priority (lower number = higher priority)
    //   if (!variableData.definition || !variableData.definitionPriority || definitionPriority < variableData.definitionPriority) {
    //     variableData.definition = new vscode.Location(document.uri, range);
    //     variableData.definitionPriority = definitionPriority;
    //   }
    // }
  }

  public getVariableAtPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableAtPosition | undefined {
    // Navigate through the map levels
    const variablesIndex = this.documentVariables.get(document);
    if (!variablesIndex) return undefined;

    return variablesIndex.findByPosition(document, position);
  }

  public getVariableDefinition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableDefinition | undefined {
    const variable = this.getVariableAtPosition(document, position);
    if (!variable) return undefined;

    return { name: variable.variable.name, definition: variable.variable.definition };
  }

  public getVariableLocations(document: vscode.TextDocument, position: vscode.Position): ScriptVariableReferences | undefined {
    const variable = this.getVariableAtPosition(document, position);
    if (!variable) return undefined;

    const references = [...variable.variable.references];
    if (variable.variable.definition) {
      references.unshift(variable.variable.definition);
    }

    return { name: variable.variable.name, references: references };
  }

  public updateVariableName(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken
  ): vscode.WorkspaceEdit | undefined {
    // Navigate through the map levels
    const variablesIndex = this.documentVariables.get(document);
    if (!variablesIndex) return;

    const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
    if (variableAtPosition) {
      const variableName = variableAtPosition.variable.name;
      const variableType = variableAtPosition.variable.type;
      const locations = variableAtPosition.variable.references;
      if (variableAtPosition.variable.definition) {
        // If the variable has a definition, use its range for the rename
        locations.unshift(variableAtPosition.variable.definition);
      }

      // Debug log: Print old name, new name, and locations
      logger.debug(`Renaming variable: ${variableName} -> ${newName}`); // Updated to use variableAtPosition[0]
      logger.debug(`Variable type: ${variableType}`);
      logger.debug(`Locations to update:`, locations);
      const workspaceEdit = new vscode.WorkspaceEdit();
      locations.forEach((location) => {
        if (token.isCancellationRequested) return;
        // Debug log: Print each edit
        const rangeText = location.range ? document.getText(location.range) : '';
        const replacementText = rangeText.startsWith('$') ? `$${newName}` : newName;
        logger.debug(`Editing file: ${location.uri.fsPath}, Range: ${location.range}, Old Text: ${rangeText}, New Text: ${replacementText}`);
        workspaceEdit.replace(location.uri, location.range, replacementText);
      });
      return workspaceEdit;
    }
    return undefined;
  }

  public clearVariablesForDocument(document: vscode.TextDocument): void {
    this.documentVariables.delete(document);
  }

  public getAllVariablesForDocumentMap(document: vscode.TextDocument, position: vscode.Position, prefix: string = ''): Map<string, vscode.MarkdownString> {
    const result: Map<string, vscode.MarkdownString> = new Map();
    // Navigate through the map levels
    const variablesIndex = this.documentVariables.get(document);
    if (!variablesIndex) return result;
    const allVariables: ScriptVariableInfo[] = variablesIndex.getAllVariables();
    // Process all variable types
    allVariables.forEach((variable) => {
      const variableName = variable.name;
      if (prefix === '' || variableName.startsWith(prefix)) {
        // Only add the item if it matches the prefix
        if (!(prefix !== '' && variable.definition === undefined && variable.references.length === 1 && variable.references[0].range.contains(position))) {
          const info = VariableTracker.getVariableDetails(variable);
          result.set(variableName, info);
        }
      }
    });

    return result;
  }

  public static getVariableDetails(variable: ScriptVariableInfo): vscode.MarkdownString {
    const details = new vscode.MarkdownString();
    details.appendMarkdown(
      `*${scriptIdDescription[variable.schema] || 'Script'} ${variableTypes[variable.type] || 'Variable'}*: **${variable.name}**` + '  \n'
    );

    details.appendMarkdown(`**Used**: ${variable.references.length} time${variable.references.length !== 1 ? 's' : ''}  \n`);
    details.appendMarkdown('**Defined**: ' + (variable.definition ? `at line ${variable.definition.range.start.line + 1}` : 'definition not found'));
    return details;
  }

  public dispose(): void {
    this.documentVariables = new WeakMap();
  }
}

export const variableTracker: VariableTracker = new VariableTracker();
