import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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

let logFilePath: string;
export function activateLog(context: vscode.ExtensionContext) {
  logFilePath = path.join(context.globalStorageUri.fsPath, 'extension.log');
  // Now you're good to go
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
}

export function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFilePath, entry, { encoding: 'utf8' });
}
