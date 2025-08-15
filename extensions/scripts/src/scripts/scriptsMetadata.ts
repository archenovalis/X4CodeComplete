import * as vscode from 'vscode';
import { logger } from '../logger/logger';

export type ScriptMetadata = {
  schema: string;
  name: string;
};
type ScriptsMetadata = WeakMap<vscode.TextDocument, ScriptMetadata>;

export const scriptHeaderRegex =
  /^\s*<\?xml[^>]*\?>\s*(?:<!--[\s\S]*?-->\s*)*<(mdscript|aiscript)[^>]*?\s+xsi:noNamespaceSchemaLocation="[^"]*?(aiscripts|md).xsd"/im;
export const scriptNameRegex = /name\s*=\s*"([^"]+)"/i;

export let scriptsMetadata: ScriptsMetadata = new WeakMap();

export function scriptsMetadataSet(document: vscode.TextDocument, reSet: boolean = false): ScriptMetadata | undefined {
  if (document.uri.scheme === 'file' && document.languageId === 'xml') {
    if (reSet) {
      logger.debug(`Re-initializing script metadata for document: ${document.uri.toString()}`);
      scriptsMetadata.delete(document); // Clear metadata if re-initializing
    } else {
      logger.debug(`Setting script metadata for document: ${document.uri.toString()}`);
    }
    const schema = getDocumentScriptType(document);
    if (schema) {
      return scriptsMetadata.get(document);
    }
  }
  return undefined;
}

export function scriptsMetadataUpdateName(document: vscode.TextDocument, newName: string): void {
  const metadata = scriptsMetadata.get(document);
  if (metadata) {
    metadata.name = newName;
    logger.debug(`Updated script name for document: ${document.uri.toString()} to: ${newName}`);
  }
}

export function scriptsMetadataClearAll(): void {
  scriptsMetadata = new WeakMap();
  logger.debug('Cleared all script metadata.');
}

export const aiScriptId = 'aiscripts';
export const mdScriptId = 'md';
export const scriptIdDescription = {
  aiscripts: 'AI Script',
  md: 'Mission Director Script',
};

export function getMetadata(text: string): ScriptMetadata | undefined {
  if (!scriptHeaderRegex.test(text)) {
    logger.debug(`Document does not match script regex.`);
    return undefined; // Skip if the document does not match the script regex
  }
  const match = scriptHeaderRegex.exec(text);
  if (!match || match.length < 3) {
    logger.debug(`Document does not contain valid script type.`);
    return undefined; // Skip if the document does not contain a valid script type
  }
  const languageSubId = match[2].toLowerCase();
  if (languageSubId) {
    const nameMatch = scriptNameRegex.exec(match[0]);
    const scriptName = nameMatch && nameMatch[1] ? nameMatch[1] : '';
    return { schema: languageSubId, name: scriptName };
  }
  return undefined;
}

export function getDocumentMetadata(document: vscode.TextDocument): ScriptMetadata | undefined {
  if (document.languageId !== 'xml') {
    logger.debug(`Document ${document.uri.toString()} is not recognized as a xml.`);
    return undefined; // Skip if the document is not recognized as a xml
  }

  const scriptMetaData = scriptsMetadata.get(document)!;
  if (scriptMetaData && scriptMetaData.schema) {
    logger.debug(`Document ${document.uri.toString()} is already recognized as script type: ${scriptMetaData.schema}`);
    return scriptMetaData; // Return the cached type if available
  }

  const text = document.getText();
  const metadata = getMetadata(text);
  if (metadata) {
    if (!scriptsMetadata.has(document)) {
      scriptsMetadata.set(document, metadata);
    } else {
      scriptMetaData.schema = metadata.schema;
      scriptMetaData.name = metadata.name;
    }
    logger.debug(`Document: ${document.uri.toString()} is now recognized as script type: ${metadata.schema}`);
    return metadata;
  }
  return undefined;
}

export function getDocumentScriptType(document: vscode.TextDocument): string {
  const metadata = getDocumentMetadata(document);
  return metadata ? metadata.schema : '';
}
