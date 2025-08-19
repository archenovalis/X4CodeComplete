import * as vscode from 'vscode';
import * as sax from 'sax';
import { logger } from '../logger/logger';

export type ScriptMetadata = {
  schema: string;
  name: string;
};
type ScriptsMetadata = WeakMap<vscode.TextDocument, ScriptMetadata>;

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

const schemaKeyId = 'xsi:noNamespaceSchemaLocation'.toLowerCase();
export const aiScriptSchema = 'aiscripts';
export const mdScriptSchema = 'md';
const aiScriptNodeName = 'aiscript';
const mdScriptNodeName = 'mdscript';
const nodeNameToSchema = {
  [aiScriptNodeName]: aiScriptSchema,
  [mdScriptNodeName]: mdScriptSchema,
};
const keysIds = Object.keys(nodeNameToSchema);
export const scriptsSchemas = Object.values(nodeNameToSchema);
export const scriptIdDescription = {
  aiscripts: 'AI Script',
  md: 'Mission Director Script',
};

function getFirstNode(xml: string): sax.Tag | sax.QualifiedTag | undefined {
  const parser = sax.parser(false, { lowercase: true });
  let firstNode: sax.Tag | sax.QualifiedTag | undefined;
  let shouldStop = false;

  parser.onopentag = (node) => {
    if (!firstNode) {
      firstNode = node;
      shouldStop = true; // signal to stop feeding
    }
  };

  parser.onerror = () => {
    firstNode = undefined;
    shouldStop = true;
  };

  // Feed XML in small chunks
  const chunkSize = 64; // or smaller if needed
  for (let i = 0; i < xml.length && !shouldStop; i += chunkSize) {
    parser.write(xml.slice(i, i + chunkSize));
  }

  return firstNode;
}

export function getMetadata(text: string): ScriptMetadata | undefined {
  // Create a non-strict parser to be more tolerant of errors
  const node = getFirstNode(text);
  if (node && keysIds.includes(node.name)) {
    let scriptSchema = node.attributes?.[schemaKeyId]?.toString().split('/').pop()?.split('.')[0].toLowerCase();
    if (!scriptSchema || !scriptsSchemas.includes(scriptSchema)) {
      scriptSchema = nodeNameToSchema[node.name.toLowerCase()] || '';
    }
    if (scriptSchema) {
      const scriptName = node.attributes.name?.toString() || '';
      return { schema: scriptSchema, name: scriptName };
    }
  }
  return undefined; // Return undefined if no valid metadata is found
}

export function getDocumentMetadata(document: vscode.TextDocument): ScriptMetadata | undefined {
  if (document.languageId !== 'xml') {
    logger.debug(`Document ${document.uri.toString()} is not recognized as a xml.`);
    return undefined; // Skip if the document is not recognized as a xml
  }

  const scriptMetaData = scriptsMetadata.get(document)!;
  if (scriptMetaData && scriptMetaData.schema) {
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
