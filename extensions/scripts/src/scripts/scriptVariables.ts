import * as vscode from 'vscode';
import { aiScriptSchema, getDocumentScriptType, mdScriptSchema, scriptIdDescription } from './scriptsMetadata';
import { XmlElement, XmlElementAttribute } from '../xml/xmlStructureTracker';
import IntervalTree from 'node-interval-tree';
import { EnhancedAttributeInfo } from 'xsd-lookup';
import { lValueTypes } from '../extension/shared';
import path from 'path/win32';

/** Regular expressions and constants for pattern matching */
export const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
export const variablePatternExact = /^@?\$[a-zA-Z_][a-zA-Z0-9_]*$/;
export const tableKeyPattern = /table\[/;

export interface ScriptVariableInfo {
  name: string;
  schema: string;
  type: string;
  scope: string;
  definitionPath: string;
  definedBy?: XmlElement;
  removedBy?: XmlElement;
  validIn?: XmlElement;
  definition?: vscode.Location;
  definitionPriority?: number;
  references: vscode.Location[];
}
export interface ScriptVariableWithLocation extends ScriptVariableInfo {
  location: vscode.Location;
}

interface ScriptVariableAndLocation {
  variable: ScriptVariableInfo;
  location: vscode.Location;
}

class ScriptVariablesIndex {
  private definitionIndex: IntervalTree<ScriptVariableAndLocation>;
  private referenceIndex: IntervalTree<ScriptVariableAndLocation>;
  private list: Record<string, ScriptVariableInfo>;
  private scopePaths: Record<string, Set<string>>;

  constructor() {
    this.definitionIndex = new IntervalTree<ScriptVariableAndLocation>();
    this.referenceIndex = new IntervalTree<ScriptVariableAndLocation>();
    this.list = {};
    this.scopePaths = {};
  }

  private rangeToIndexes(document: vscode.TextDocument, range: vscode.Range): [number, number] {
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);
    return [startOffset, endOffset];
  }

  public addVariable(
    schema: string,
    document: vscode.TextDocument,
    variable: ScriptVariableInfo,
    range: vscode.Range,
    scopeKey: string,
    scope: ScopeInfo,
    elem: XmlElement,
    isDefinition: boolean
  ): void {
    let existing: ScriptVariableInfo | undefined;
    let key: string | undefined;
    let path: string | undefined;
    if (scope.externalDefinitions && scope.externalDefinitions.size > 0) {
      for (const scopeId of scope.externalDefinitions) {
        const paths = this.scopePaths[scopeId] || [];
        for (path of paths) {
          key = `${variable.name}:${path}`;
          existing = this.list[key] as ScriptVariableWithLocation | undefined;
          if (existing) {
            break;
          }
        }
        if (existing) {
          break;
        }
      }
    }
    if (!existing) {
      path = elem ? VariableTracker.makeScopePath(schema, elem) : scopeKey;
      key = `${variable.name}:${path}`;
      existing = this.list[key] as ScriptVariableWithLocation | undefined;
    }
    let addScopePath: string | undefined;
    if (!existing || (isDefinition && !existing.definition)) {
      if (!existing) {
        variable.definitionPath = path;
        variable.scope = scopeKey;
        this.list[key] = variable;
        existing = variable;
        addScopePath = path;
      } else if (isDefinition && existing.definitionPath !== path) {
        delete this.list[`${existing.name}:${existing.definitionPath}`];
        this.list[`${existing.name}:${path}`] = existing;
        addScopePath = path;
        existing.definitionPath = path;
        existing.scope = scopeKey;
      }
    }
    if (isDefinition && (!existing || !existing.definition)) {
      existing.definition = new vscode.Location(document.uri, range);
      const [start, end] = this.rangeToIndexes(document, range);
      this.definitionIndex.insert(start, end, { variable: existing, location: existing.definition });
    } else {
      existing.references.push(new vscode.Location(document.uri, range));
      const [start, end] = this.rangeToIndexes(document, range);
      this.referenceIndex.insert(start, end, { variable: existing, location: new vscode.Location(document.uri, range) });
    }
    if (addScopePath) {
      if (!this.scopePaths[scopeKey]) {
        this.scopePaths[scopeKey] = new Set<string>();
      }
      this.scopePaths[scopeKey].add(addScopePath);
    }
  }

  public getByDefinitionOffset(offset: number): ScriptVariableWithLocation | undefined {
    const results = this.definitionIndex.search(offset, offset);
    return results.length > 0 ? { ...results[0].variable, location: results[0].location } : undefined;
  }

  public getByReferenceOffset(offset: number): ScriptVariableWithLocation | undefined {
    const results = this.referenceIndex.search(offset, offset);
    return results.length > 0 ? { ...results[0].variable, location: results[0].location } : undefined;
  }

  public findByPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableWithLocation | undefined {
    const offset = document.offsetAt(position);
    const definitionResults = this.definitionIndex.search(offset, offset);
    if (definitionResults.length > 0) {
      return { ...definitionResults[0].variable, location: definitionResults[0].location };
    }
    const referenceResults = this.referenceIndex.search(offset, offset);
    return referenceResults.length > 0 ? { ...referenceResults[0].variable, location: referenceResults[0].location } : undefined;
  }

  public getAllVariables(): ScriptVariableInfo[] {
    return Object.values(this.list);
  }

  public renameVariable(variable: ScriptVariableInfo, newName: string): void {
    const oldKey = `${variable.definitionPath}:${variable.name}`;
    const newKey = `${variable.definitionPath}:${newName}`;
    if (this.list[oldKey]) {
      variable.name = newName;
      this.list[newKey] = variable;
      delete this.list[oldKey];
    }
  }
}

type ScriptVariablesPerDocument = WeakMap<vscode.TextDocument, ScriptVariablesIndex>;

const variableTypes = {
  normal: 'usual variable',
  tableKey: 'remote or table variable',
};

type ScopeInfo = {
  name: string;
  attributesPresented?: Set<string>;
  attributesExcluded?: Set<string>;
  priority: number;
  parent?: string;
  asScope?: string;
  exactScopeIndex?: number;
  shortPath?: boolean;
  topParent?: boolean;
  inlineScope?: string;
  pathAttribute?: string;
  externalDefinitions: Set<string>;
};

export class VariableTracker {
  private static tableKey: ScopeInfo = {
    name: 'tableKey',
    attributesPresented: new Set(),
    attributesExcluded: new Set(),
    priority: 0,
    asScope: undefined,
    topParent: true,
    inlineScope: undefined,
    externalDefinitions: new Set(),
  };

  private static aiScriptScopes: Record<string, ScopeInfo> = {
    aiscript: {
      name: 'aiscript',
      priority: 100,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(),
    },
    params: {
      name: 'param',
      parent: 'params',
      priority: 0,
      asScope: 'self',
      topParent: false,
      externalDefinitions: new Set(),
    },
    order: {
      name: 'order',
      priority: 0,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(['params']),
    },
    init: {
      name: 'init',
      priority: 10,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(),
    },
    patch: {
      name: 'patch',
      priority: 0,
      asScope: 'self',
      topParent: true,
      parent: 'aiscript',
      pathAttribute: 'sinceversion',
      externalDefinitions: new Set(['params', 'init', 'attention']),
    },
    handler: {
      name: 'handler',
      attributesExcluded: new Set(['name', 'ref']),
      priority: 200,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(['params', 'init', 'attention', 'any']),
    },
    handlerNamed: {
      name: 'handler',
      attributesPresented: new Set(['name']),
      pathAttribute: 'name',
      priority: 200,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(['params', 'init', 'attention', 'any']),
    },
    actions: {
      name: 'actions',
      attributesPresented: new Set(['name']),
      pathAttribute: 'name',
      priority: 200,
      asScope: 'self',
      parent: 'library',
      topParent: true,
      externalDefinitions: new Set(['params', 'init', 'attention', 'any']),
    },
    attention: {
      name: 'attention',
      pathAttribute: 'min',
      priority: 100,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(['params', 'init', 'actions', 'any']),
    },
    do_all: {
      name: 'do_all',
      priority: 150,
      asScope: 'top-parent',
      inlineScope: 'self',
      externalDefinitions: new Set(),
    },
    do_for_each: {
      name: 'do_for_each',
      priority: 150,
      asScope: 'top-parent',
      inlineScope: 'self',
      externalDefinitions: new Set(),
    },
    do_any: {
      name: 'do_any',
      priority: 150,
      asScope: 'top-parent',
      inlineScope: 'self',
      externalDefinitions: new Set(),
    },
    do_while: {
      name: 'do_while',
      priority: 150,
      asScope: 'top-parent',
      inlineScope: 'self',
      externalDefinitions: new Set(),
    },
  };

  private static aiScriptScopesKeys: string[] = Object.keys(VariableTracker.aiScriptScopes).sort();

  private static mdScriptScopes: Record<string, ScopeInfo> = {
    cue: {
      name: 'cue',
      attributesPresented: new Set(),
      attributesExcluded: new Set(),
      priority: 100,
      asScope: 'self',
      topParent: true,
      externalDefinitions: new Set(),
    },
  };

  private static mdScriptScopesKeys: string[] = Object.keys(VariableTracker.mdScriptScopes).sort();

  // Map to store variables per document: Map<scriptType, Map<DocumentURI, Map<variablesType, Map<variableName, {...}>>>>
  documentVariables: ScriptVariablesPerDocument = new WeakMap<vscode.TextDocument, ScriptVariablesIndex>();

  public addVariable(
    type: string,
    name: string,
    schema: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    attribute?: XmlElementAttribute,
    attributeDefinition?: EnhancedAttributeInfo
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
    const element: XmlElement = attribute.element;
    const variable: ScriptVariableInfo = {
      name: normalizedName,
      schema: schema,
      definitionPath: '',
      type: type,
      references: [],
      scope: '',
    };
    let isDefinition: boolean = VariableTracker.isDefinition(attribute, element, attributeDefinition);
    if (isDefinition && element.name === 'remove_value') {
      isDefinition = false;
    }
    if (type === 'tableKey') {
      variablesIndex.addVariable(schema, document, variable, range, 'table', VariableTracker.tableKey, undefined, isDefinition);
    } else {
      // if (element.name === 'remove_value') {
      //   variable.removedBy = element;
      // }
      const { key, scope, elem } = this.processVariableScope(schema, element, isDefinition);
      variablesIndex.addVariable(schema, document, variable, range, key, scope, elem, isDefinition);
    }
  }

  private static isDefinition(attribute: XmlElementAttribute, element: XmlElement, attributeDefinition: EnhancedAttributeInfo): boolean {
    // Check if the attribute is a definition based on its definition info
    if (element.name === 'param' && attribute.name === 'name' && element.hierarchy.length > 0 && element.hierarchy[0] === 'params') {
      return true;
    } else if (lValueTypes.includes(attributeDefinition?.type || '')) {
      return true;
    }
    return false;
  }

  private static getScopeWithKey(schema: string, elem: XmlElement): { key: string | undefined; scope: ScopeInfo | undefined } {
    let scopeKey: string | undefined;

    const scopes = schema === aiScriptSchema ? this.aiScriptScopes : this.mdScriptScopes;
    const scopesKeys = schema === aiScriptSchema ? this.aiScriptScopesKeys : this.mdScriptScopesKeys;

    for (const key of scopesKeys) {
      const scope = scopes[key];

      // 1. Name must match
      if (scope.name !== elem.name) continue;

      // 2. If attributesPresented is defined, at least one must match
      if (scope.attributesPresented && !elem.attributes.some((a) => scope.attributesPresented!.has(a.name))) continue;

      // 3. If attributesExcluded is defined, none may match
      if (scope.attributesExcluded && elem.attributes.some((a) => scope.attributesExcluded!.has(a.name))) continue;

      // 4. Parent logic: undefined or positive/negated match
      const parentName = elem.parent?.name;
      if (scope.parent !== undefined) {
        const negated = scope.parent[0] === '!';
        const target = negated ? scope.parent.slice(1) : scope.parent;
        if (negated ? parentName === target : parentName !== target) {
          continue;
        }
      }

      // Found a matching key → assign and break out
      scopeKey = key;
      break;
    }
    return { key: scopeKey, scope: scopes[scopeKey || ''] };
  }

  public static makeScopePath(schema: string, element: XmlElement): string {
    let path = '';
    while (element) {
      path += `${path ? '.' : ''}${element.name}`;
      const { key: _key, scope } = VariableTracker.getScopeWithKey(schema, element);
      if (scope) {
        if (scope.pathAttribute) {
          const attribute = element.attributes.find((a) => a.name === scope.pathAttribute);
          if (attribute) {
            path += `(${scope.pathAttribute}="${attribute.value || ''}")`;
          }
        }
        if (scope.topParent) {
          break;
        }
      }
      element = element.parent;
    }
    return path;
  }

  private processVariableScope(schema: string, element: XmlElement, isDefinition: boolean): { key: string; scope: ScopeInfo; elem: XmlElement } {
    const scopes = schema === aiScriptSchema ? VariableTracker.aiScriptScopes : VariableTracker.mdScriptScopes;
    let scope: ScopeInfo | undefined;
    let elem: XmlElement | undefined = element;
    let breakOnTopParent = false;
    let scopeKey: string | undefined;
    while (elem) {
      if (!scope) {
        const { key, scope: foundScope } = VariableTracker.getScopeWithKey(schema, elem);
        scopeKey = key;
        scope = foundScope;
      }
      if (scope && elem.name === scope.name) {
        if (isDefinition && elem === element && scope.inlineScope) {
          break;
        }
        if (scope.asScope === 'top-parent') {
          breakOnTopParent = true;
        } else if (scope.asScope === 'self') {
          break;
        } else if (scope.asScope) {
          scopeKey = scope.asScope;
          scope = scopes[scopeKey];
          elem = elem.parent;
          continue;
        }
        if (breakOnTopParent && scope.topParent) {
          break;
        }
      }
      elem = elem.parent;
      scope = undefined;
    }
    return { key: scopeKey, scope, elem };
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
