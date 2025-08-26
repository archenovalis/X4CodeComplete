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
  private definitionIndex: IntervalTree<ScriptVariableWithLocation>;
  private referenceIndex: IntervalTree<ScriptVariableWithLocation>;
  private list: Record<string, ScriptVariableInfo>;

  constructor() {
    this.definitionIndex = new IntervalTree<ScriptVariableWithLocation>();
    this.referenceIndex = new IntervalTree<ScriptVariableWithLocation>();
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
    this.definitionIndex.insert(start, end, { ...current, location: current.definition });
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
    this.referenceIndex.insert(start, end, { ...current, location: new vscode.Location(document.uri, range) });
  }

  public getByDefinitionOffset(offset: number): ScriptVariableWithLocation | undefined {
    const results = this.definitionIndex.search(offset, offset);
    return results.length > 0 ? results[0] : undefined;
  }

  public getByReferenceOffset(offset: number): ScriptVariableWithLocation | undefined {
    const results = this.referenceIndex.search(offset, offset);
    return results.length > 0 ? results[0] : undefined;
  }

  public findByPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableWithLocation | undefined {
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

type ScriptVariablesPerDocument = WeakMap<vscode.TextDocument, ScriptVariablesIndex>;

export interface ScriptVariableWithLocation extends ScriptVariableInfo {
  location: vscode.Location;
}

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

export class VariableTracker {
  private static tableKey: ScopeInfo = {
    name: 'tableKey',
    attributesPresented: new Set(),
    attributesExcluded: new Set(),
    priority: 0,
    parent: undefined,
    asScope: undefined,
    topParent: true,
    externalDefinitions: new Set(),
  };

  private static aiScriptScopes: ScopeInfo[] = [
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

  private static mdScriptScopes: ScopeInfo[] = [
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
      scope: schema === aiScriptSchema ? VariableTracker.aiScriptScopes[0] : VariableTracker.mdScriptScopes[0],
    };
    if (type === 'tableKey') variable.scope = VariableTracker.tableKey;
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

  public getVariableAtPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableWithLocation | undefined {
    // Navigate through the map levels
    const variablesIndex = this.documentVariables.get(document);
    if (!variablesIndex) return undefined;

    return variablesIndex.findByPosition(document, position);
  }

  public getVariableDefinition(document: vscode.TextDocument, position: vscode.Position, variable?: ScriptVariableWithLocation): vscode.Location | undefined {
    if (!variable) variable = this.getVariableAtPosition(document, position);
    if (!variable) return undefined;

    logger.debug(`Variable definition found at position: ${position.line + 1}:${position.character} for variable: ${variable.name}`);

    return variable.definition;
  }

  public getVariableLocations(document: vscode.TextDocument, position: vscode.Position, variable?: ScriptVariableWithLocation): vscode.Location[] | undefined {
    if (!variable) variable = this.getVariableAtPosition(document, position);
    if (!variable) return undefined;

    logger.debug(`References found for variable: ${variable.name}`);
    const references = [...variable.references];
    if (variable.definition) {
      references.unshift(variable.definition);
    }

    return references;
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
      const variableName = variableAtPosition.name;
      const variableType = variableAtPosition.type;
      const locations = this.getVariableLocations(document, position, variableAtPosition);

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
