import * as vscode from 'vscode';
import { logger } from '../logger/logger';
import * as sax from 'sax';

type ScriptMetadata = {
  scheme: string;
}
type ScriptsMetadata = WeakMap<vscode.TextDocument, ScriptMetadata>;

export let scriptsMetadata: ScriptsMetadata = new WeakMap();

export function scriptsMetadataSet(document: vscode.TextDocument, reSet: boolean = false): ScriptMetadata | undefined {
  if (document.languageId === 'xml') {
    if (reSet) {
      logger.debug(`Re-initializing script metadata for document: ${document.uri.toString()}`);
      scriptsMetadata.delete(document); // Clear metadata if re-initializing
    } else {
      logger.debug(`Setting script metadata for document: ${document.uri.toString()}`);
    }
    const scheme = getDocumentScriptType(document);
    if (scheme) {
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
export const scriptNodes = {
  'aiscript': {
    id: aiScriptId,
    info: 'AI Scripts',
  },
  'mdscript': {
    id: mdScriptId,
    info: 'Mission Director Scripts',
  }
};
const scriptNodesNames = Object.keys(scriptNodes);
const scriptTypesToSchema = {
  [aiScriptId]: 'aiscripts',
  [mdScriptId]: 'md',
};

export function getDocumentScriptType(document: vscode.TextDocument): string {
  let languageSubId: string = '';

  if (document.languageId !== 'xml') {
    logger.debug(`Document ${document.uri.toString()} is not recognized as a xml.`);
    return languageSubId; // Skip if the document is not recognized as a xml
  }

  const scriptMetaData = scriptsMetadata.get(document)!;
  if (scriptMetaData && scriptMetaData.scheme) {
    languageSubId = scriptMetaData.scheme;
    logger.debug(`Document ${document.uri.toString()} recognized as script type: ${languageSubId}`);
    return languageSubId; // Return the cached type if available
  }

  const text = document.getText();
  const parser = sax.parser(true); // Use strict mode for validation

  parser.onopentag = (node) => {
    // Check if the root element is <aiscript> or <mdscript>
    if (scriptNodesNames.includes(node.name)) {
      languageSubId = scriptNodes[node.name].id;
    }
    parser.close(); // Stop parsing as soon as the root element is identified
  };

  try {
    parser.write(text).close();
  } catch {
    // Will not react, as we have only one possibility to get a true
  }

  if (languageSubId) {
    // Cache the languageSubId for future use
    if (!scriptsMetadata.has(document)) {
      scriptsMetadata.set(document, { scheme: languageSubId });
    } else {
        scriptMetaData.scheme = languageSubId;
    }
    logger.debug(`Cached languageSubId: ${languageSubId} for document: ${document.uri.toString()}`);
  }

  return languageSubId;
}
