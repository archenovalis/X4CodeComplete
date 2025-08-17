import * as vscode from 'vscode';
import { getDocumentScriptType, scriptIdDescription } from './scriptsMetadata';

/** Regular expressions and constants for pattern matching */
export const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
export const variablePatternExact = /^@?\$[a-zA-Z_][a-zA-Z0-9_]*$/;
export const tableKeyPattern = /table\[/;

export type ScriptVariableInfo = {
  name: string;
  schema: string;
  type: string;
  definition?: vscode.Location;
  definitionPriority?: number;
  locations: vscode.Location[];
};

type ScriptVariablesMap = Map<string, ScriptVariableInfo>;
type ScriptVariablesPerType = Map<string, ScriptVariablesMap>;
type ScriptVariablesPerDocument = WeakMap<vscode.TextDocument, ScriptVariablesPerType>;

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

export class VariableTracker {
  // Map to store variables per document: Map<scriptType, Map<DocumentURI, Map<variablesType, Map<variableName, {...}>>>>
  documentVariables: ScriptVariablesPerDocument = new WeakMap();

  public addVariable(
    type: string,
    name: string,
    schema: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    isDefinition: boolean = false,
    definitionPriority?: number
  ): void {
    const normalizedName = name.startsWith('$') ? name.substring(1) : name;

    // Get or create the scriptType level
    if (!this.documentVariables.has(document)) {
      this.documentVariables.set(document, new Map());
    }
    const variablesTypes = this.documentVariables.get(document)!;

    // Get or create the variable type level
    if (!variablesTypes.has(type)) {
      variablesTypes.set(type, new Map());
    }
    const typeMap = variablesTypes.get(type)!;

    // Get or create the variable name level
    if (!typeMap.has(normalizedName)) {
      typeMap.set(normalizedName, { name: normalizedName, schema: schema, type: type, locations: [] });
    }
    const variableData = typeMap.get(normalizedName)!;

    // Add to locations
    variableData.locations.push(new vscode.Location(document.uri, range));

    // Handle definition if this is marked as one
    if (isDefinition && definitionPriority !== undefined) {
      // Only set definition if we don't have one, or if this has higher priority (lower number = higher priority)
      if (!variableData.definition || !variableData.definitionPriority || definitionPriority < variableData.definitionPriority) {
        variableData.definition = new vscode.Location(document.uri, range);
        variableData.definitionPriority = definitionPriority;
      }
    }
  }

  public getVariableAtPosition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableAtPosition | undefined {
    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return undefined;

    // Check all variable types
    for (const [variableType, typeMap] of variablesTypes) {
      // Check all variable names
      for (const [variableName, variableData] of typeMap) {
        if (variableData.definition && variableData.definition.range.contains(position)) {
          return {
            variable: variableData,
            location: variableData.definition,
          };
        }
        const variableLocation = variableData.locations.find((loc) => loc.range.contains(position));
        if (variableLocation) {
          return {
            variable: variableData,
            location: variableLocation,
          };
        }
      }
    }

    return undefined;
  }

  public getVariableDefinition(document: vscode.TextDocument, position: vscode.Position): ScriptVariableDefinition | undefined {
    const variable = this.getVariableAtPosition(document, position);
    if (!variable) return undefined;

    return { name: variable.variable.name, definition: variable.variable.definition };
  }

  public getVariableLocations(document: vscode.TextDocument, position: vscode.Position): ScriptVariableReferences | undefined {
    const variable = this.getVariableAtPosition(document, position);
    if (!variable) return undefined;

    const references = [...variable.variable.locations];
    if (variable.variable.definition) {
      // Remove the definition from references if it exists
      references.unshift(variable.variable.definition);
    }

    return { name: variable.variable.name, references: references };
  }

  public updateVariableName(type: string, oldName: string, newName: string, document: vscode.TextDocument): void {
    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return;

    const typeMap = variablesTypes.get(type);
    if (!typeMap) return;

    const normalizedOldName = oldName.startsWith('$') ? oldName.substring(1) : oldName;
    const normalizedNewName = newName.startsWith('$') ? newName.substring(1) : newName;

    const variableData = typeMap.get(normalizedOldName);
    if (!variableData) return;
    variableData.name = normalizedNewName; // Update the name in the variable data

    // Move the variable data to the new name
    typeMap.set(normalizedNewName, variableData);
    typeMap.delete(normalizedOldName);
  }

  public clearVariablesForDocument(document: vscode.TextDocument): void {
    this.documentVariables.delete(document);
  }

  public getAllVariablesForDocumentMap(document: vscode.TextDocument, position: vscode.Position, prefix: string = ''): Map<string, vscode.MarkdownString> {
    const result: Map<string, vscode.MarkdownString> = new Map();
    // Navigate through the map levels
    const variablesTypes = this.documentVariables.get(document);
    if (!variablesTypes) return result;

    // Process all variable types
    for (const [variableType, typeMap] of variablesTypes) {
      // Process all variables
      for (const [variableName, variableData] of typeMap) {
        if (prefix === '' || variableName.startsWith(prefix)) {
          // Only add the item if it matches the prefix
          if (
            prefix !== '' &&
            variableData.definition === undefined &&
            variableData.locations.length === 1 &&
            variableData.locations[0].range.contains(position)
          ) {
            continue;
          }
          const info = VariableTracker.getVariableDetails(variableData);
          result.set(variableName, info);
        }
      }
    }

    return result;
  }

  public static getVariableDetails(variable: ScriptVariableInfo): vscode.MarkdownString {
    const details = new vscode.MarkdownString();
    details.appendMarkdown(
      `*${scriptIdDescription[variable.schema] || 'Script'} ${variableTypes[variable.type] || 'Variable'}*: **${variable.name}**` + '  \n'
    );

    details.appendMarkdown(`**Used**: ${variable.locations.length} time${variable.locations.length !== 1 ? 's' : ''}  \n`);
    details.appendMarkdown('**Defined**: ' + (variable.definition ? `at line ${variable.definition.range.start.line + 1}` : 'definition not found'));
    return details;
  }

  public dispose(): void {
    this.documentVariables = new WeakMap();
  }
}

export const variableTracker: VariableTracker = new VariableTracker();
