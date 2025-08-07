import * as vscode from 'vscode';
import { logger } from '../logger/logger';

type ScriptMetadata = {
  schema: string;
};
type ScriptsMetadata = WeakMap<vscode.TextDocument, ScriptMetadata>;

const SCRIPT_REGEX = /^\s*<\?xml[^>]*\?>\s*(?:<!--[\s\S]*?-->\s*)*<(mdscript|aiscript)[^>]*?\s+xsi:noNamespaceSchemaLocation="[^"]*?(aiscripts|md).xsd"/im;

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

export function getDocumentScriptType(document: vscode.TextDocument): string {
  let languageSubId: string = '';

  if (document.languageId !== 'xml') {
    logger.debug(`Document ${document.uri.toString()} is not recognized as a xml.`);
    return languageSubId; // Skip if the document is not recognized as a xml
  }

  const scriptMetaData = scriptsMetadata.get(document)!;
  if (scriptMetaData && scriptMetaData.schema) {
    languageSubId = scriptMetaData.schema;
    logger.debug(`Document ${document.uri.toString()} recognized as script type: ${languageSubId}`);
    return languageSubId; // Return the cached type if available
  }

  const text = document.getText();
  if (!SCRIPT_REGEX.test(text)) {
    logger.debug(`Document ${document.uri.toString()} does not match script regex.`);
    return languageSubId; // Skip if the document does not match the script regex
  }
  const match = SCRIPT_REGEX.exec(text);
  if (!match || match.length < 3) {
    logger.debug(`Document ${document.uri.toString()} does not contain valid script type.`);
    return languageSubId; // Skip if the document does not contain a valid script type
  }
  languageSubId = match[2].toLowerCase();
  if (languageSubId) {
    // Cache the languageSubId for future use
    if (!scriptsMetadata.has(document)) {
      scriptsMetadata.set(document, { schema: languageSubId });
    } else {
      scriptMetaData.schema = languageSubId;
    }
    logger.debug(`Cached languageSubId: ${languageSubId} for document: ${document.uri.toString()}`);
  }

  return languageSubId;
}
