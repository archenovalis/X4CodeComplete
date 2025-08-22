import * as vscode from 'vscode';
export const diagnosticCollection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection('x4CodeComplete');
export const lValueTypes: string[] = ['lvalueexpression'];

export function updateLValueTypes(newTypes: string[]) {
  if (Array.isArray(newTypes) && newTypes.length > 0) {
    for (const type of newTypes) {
      if (!lValueTypes.includes(type)) {
        lValueTypes.push(type);
      }
    }
  }
}
