/**
 * X4CodeComplete VS Code Extension
 *
 * This extension provides intelligent code completion, diagnostics, and navigation
 * for X4: Foundations script files (AI Scripts and Mission Director Scripts).
 *
 * Features:
 * - XML structure analysis and validation
 * - Script property completion
 * - Variable tracking and completion
 * - Label and action reference tracking
 * - Language file integration
 * - XSD-based validation
 *
 * Code Organization:
 * 1. Imports and Dependencies
 * 2. Type Definitions and Constants
 * 3. Global Variables and Configuration
 * 4. Tracker Instances
 * 5. Utility Functions
 * 6. Extension Activation
 * 7. Language Provider Registrations
 * 8. Document Event Handlers
 * 9. Extension Startup Handler
 * 10. Configuration Change Handler
 * 11. Advanced Language Providers
 * 12. Extension Deactivation
 */

// ================================================================================================
// 1. IMPORTS AND DEPENDENCIES
// ================================================================================================

// VS Code extensibility API imports
import * as vscode from 'vscode';
import * as path from 'path';

// Configuration imports
import { X4CodeCompleteConfig, configManager, ConfigChangeCallbacks } from './extension/configuration';
import { diagnosticCollection } from './extension/shared'; // Moved diagnosticCollection to shared for easier access

// Core functionality imports
import { xmlTracker, XmlElement, XmlStructureTracker } from './xml/xmlStructureTracker';
import { logger, setLoggerLevel } from './logger/logger';
import { xsdReference, XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from 'xsd-lookup';

// Script-specific functionality imports
import { ReferencedItemsTracker, ReferencedItemsWithExternalDefinitionsTracker, scriptReferencedItemsRegistry } from './scripts/scriptReferencedItems';
import { scriptProperties } from './scripts/scriptProperties';
import { getDocumentScriptType, scriptsMetadata, getDocumentMetadata, scriptsMetadataSet, scriptsMetadataClearAll } from './scripts/scriptsMetadata';
import { variableTracker, VariableTracker } from './scripts/scriptVariables';
import { scriptCompletion, ScriptCompletion } from './scripts/scriptCompletion';
import { languageProcessor } from './languageFiles/languageFiles';
import { scriptDocumentTracker } from './scripts/scriptDocumentTracker';
import { isInsideSingleQuotedString, isSingleQuoteExclusion } from './scripts/scriptUtilities';

// ================================================================================================
// 2. TYPE DEFINITIONS AND CONSTANTS
// ================================================================================================

// ================================================================================================
// 3. GLOBAL VARIABLES AND CONFIGURATION
// ================================================================================================

/** Activation state */
let isActivated = false;

/** Refresh timeout ID */
let refreshTimeoutId: NodeJS.Timeout | undefined;

/** Document selector for XML files */
const xmlSelector: vscode.DocumentSelector = { language: 'xml' };

/** Completion trigger characters for script completion */
const completionTriggerCharacters = ['.', '"', '{', ' ', '$', '<'];

const disposables: vscode.Disposable[] = [];

/** Document change tracking for batched processing */
interface DocumentChange {
  uri: vscode.Uri;
  version: number;
  ranges: vscode.Range[];
  timestamp: number;
  cursorPosition?: vscode.Position;
}

const documentChanges = new Map<string, DocumentChange>();
const urisToRefresh = new Set<string>();

// ================================================================================================
// 4. TRACKER INSTANCES
// ================================================================================================

// ================================================================================================
// 5. UTILITY FUNCTIONS (EXTENSION-SPECIFIC)
// ================================================================================================

/**
 * Note: Configuration-related utility functions have been moved to ./configuration.ts
 * This section is reserved for extension-specific utility functions that don't fit
 * into other modules.
 */

const codeCompleteStartupDone = new vscode.EventEmitter<void>();
export const onCodeCompleteStartupProcessed = codeCompleteStartupDone.event;

/**
 * Converts content changes to ranges for tracking
 */
function changesToRanges(contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): vscode.Range[] {
  return contentChanges.filter((change) => 'range' in change && change.range).map((change) => change.range as vscode.Range);
}

/**
 * Finds the active editor for a given document URI
 */
function findEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
}

/**
 * Adds a URI to the refresh queue and schedules processing
 */
function addUriToRefreshTimeout(uri: vscode.Uri): void {
  if (uri.scheme !== 'file') {
    logger.debug(`Skipping non-file URI: ${uri.toString()}`);
    return;
  }
  if (urisToRefresh.has(uri.toString())) {
    logger.debug(`URI already in refresh queue: ${uri.toString()}`);
    return;
  }
  const editor = findEditor(uri);
  if (!editor) {
    logger.debug(`No active editor found for URI: ${uri.toString()}`);
    return;
  }
  const document = editor.document;
  if (scriptsMetadataSet(document, true)) {
    urisToRefresh.add(uri.toString());
    scheduleUriRefresh();
  }
}

/**
 * Schedules batched processing of document changes
 */
function scheduleUriRefresh(): void {
  if (refreshTimeoutId || urisToRefresh.size < 1) {
    logger.debug('No pending document changes to process');
    return;
  }

  refreshTimeoutId = setTimeout(() => {
    if (documentChanges.size > 0) processQueuedDocumentChanges();
    refreshTimeoutId = undefined; // Clear the timeout ID
    scheduleUriRefresh();
  }, 200); // 200ms debounce delay
}

/**
 * Processes all queued document changes in batch
 */
const processQueuedDocumentChanges = (): void => {
  const urisToProcess = Array.from(urisToRefresh);

  // logger.debug(`Processing ${urisToProcess.length} queued document changes`);

  for (const uriString of urisToProcess) {
    const change = documentChanges.get(uriString);
    if (!change) {
      continue;
    }

    if (!urisToRefresh.has(uriString)) {
      documentChanges.delete(uriString);
      logger.debug(`URI no longer in refresh queue: ${uriString}`);
      continue;
    }

    const editor = findEditor(change.uri);
    if (!editor) {
      documentChanges.delete(uriString);
      urisToRefresh.delete(uriString);
      continue;
    }

    const document = editor.document;
    if (document.version !== change.version) {
      // Document has been modified since this change was recorded
      documentChanges.delete(uriString);
      continue;
    }

    const cursorPos = change.cursorPosition || editor.selection.active;

    logger.debug(`Processing batched change for: ${document.uri.toString()}, ranges: ${change.ranges.length}`);

    // Update the document structure
    scriptDocumentTracker.trackScriptDocument(document, true, cursorPos);

    // Clean up processed change
    documentChanges.delete(uriString);
  }
};

/**
 * Handles document change events with batching and debouncing
 */
async function onDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
  const { document, contentChanges } = event;
  const uriKey = document.uri.toString();

  const editor = findEditor(document.uri);
  if (!editor) {
    urisToRefresh.delete(uriKey);
    documentChanges.delete(uriKey);
    return;
  }

  if (!urisToRefresh.has(uriKey) && document.uri.scheme === 'file') {
    addUriToRefreshTimeout(document.uri);
  }
  const ranges = changesToRanges(contentChanges);

  if (!ranges.length) {
    documentChanges.delete(uriKey);
    return;
  }

  // Store the change for batched processing
  documentChanges.set(uriKey, {
    uri: document.uri,
    version: document.version,
    ranges,
    timestamp: performance.now(),
    cursorPosition: editor.selection.active,
  });
}

// ================================================================================================
// 6. EXTENSION ACTIVATION
// ================================================================================================

/**
 * Main extension activation function
 * Called when the extension is first activated
 *
 * @param context - VS Code extension context
 */
export function activate(context: vscode.ExtensionContext) {
  // Initialize configuration manager with callbacks
  const configCallbacks: ConfigChangeCallbacks = {
    onDebugChanged: (isDebugEnabled: boolean) => {
      if (isDebugEnabled) {
        setLoggerLevel('debug');
      } else {
        setLoggerLevel('info');
      }
      logger.info(`Debug logging ${isDebugEnabled ? 'enabled' : 'disabled'}`);
    },

    onLanguageFilesReload: async (config: X4CodeCompleteConfig) => {
      logger.info('Reloading language files due to configuration changes...');
      await vscode.commands.executeCommand('x4CodeComplete.reloadLanguageFiles');
    },

    onUnpackedFileLocationChanged: async (config: X4CodeCompleteConfig) => {
      logger.info('Unpacked file location changed.');
      await vscode.commands.executeCommand('x4CodeComplete.reloadExtractedFiles');
    },
  };

  // Initialize configuration manager
  configManager.setCallbacks(configCallbacks);

  if (!configManager.validateSettings()) {
    return;
  }

  // Configure logging based on debug setting
  if (configManager.config.debug) {
    setLoggerLevel('debug');
  } else {
    setLoggerLevel('info');
  }
  logger.debug('X4CodeComplete activation started.');

  // Initialize core services
  context.subscriptions.push(diagnosticCollection);

  // ================================================================================================
  // 9. EXTENSION STARTUP HANDLER
  // ================================================================================================

  onCodeCompleteStartupProcessed(async () => {
    // Heavy initialization logic extracted so we can optionally wrap it in a progress UI
    const performHeavyInitialization = async () => {
      logger.info('Starting deferred heavy services initialization...');

      if (disposables.length > 0) {
        logger.info(`Disposing ${disposables.length} old subscriptions...`);
        do {
          const disposable = disposables.pop();
          if (disposable) {
            disposable.dispose();
          }
        } while (disposables.length > 0);
      }

      // Initialize language processor and load language files
      await languageProcessor
        .loadLanguageFiles(configManager.config.unpackedFileLocation, configManager.config.extensionsFolder)
        .then(() => {
          logger.info('Language files loaded successfully.');
        })
        .catch((error) => {
          logger.error('Error loading language files:', error);
          vscode.window.showErrorMessage('Error loading language files: ' + error);
        });

      xsdReference.init(configManager.librariesPath);

      await scriptProperties.init(path.join(configManager.librariesPath, '/'));

      scriptCompletion.init(processQueuedDocumentChanges);

      scriptDocumentTracker.init();

      logger.info('Heavy services initialization completed.');

      // ================================================================================================
      // 7. LANGUAGE PROVIDER REGISTRATIONS
      // ================================================================================================

      // Register completion provider with trigger characters
      disposables.push(vscode.languages.registerCompletionItemProvider(xmlSelector, scriptCompletion, ...completionTriggerCharacters));

      // Register definition provider for go-to-definition functionality
      disposables.push(
        vscode.languages.registerDefinitionProvider(xmlSelector, {
          /**
           * Provides definition locations for symbols at a given position
           * Handles variables, actions, labels, and script properties
           */
          provideDefinition: async (
            document: vscode.TextDocument,
            position: vscode.Position,
            token: vscode.CancellationToken
          ): Promise<vscode.Definition | undefined> => {
            if (token.isCancellationRequested) return undefined;
            const schema = getDocumentScriptType(document);
            if (schema === '') {
              return undefined;
            }

            const element = xmlTracker.elementWithPosInStartTag(document, position);
            if (element) {
              const inNameElement = xmlTracker.elementWithPosInName(document, position, element);
              if (inNameElement) {
                const elementDefinition = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
                if (elementDefinition) {
                  const elementLocation = XsdReference.getElementLocation(elementDefinition);
                  if (elementLocation) {
                    logger.debug(
                      `Definition found for element: ${element.name} at ${elementLocation.uri.toString()}:${elementLocation.line}:${elementLocation.column}}`
                    );
                    return new vscode.Location(
                      vscode.Uri.parse(elementLocation.uri),
                      new vscode.Range(
                        new vscode.Position(elementLocation.line - 1, elementLocation.column - 1),
                        new vscode.Position(elementLocation.line - 1, elementLocation.column - 1 + elementLocation.lengthOfStartTag)
                      )
                    );
                  }
                }
              } else {
                const attributeWithPosInName = xmlTracker.attributeWithPosInName(document, position, element);
                if (attributeWithPosInName) {
                  const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(schema, element.name, element.hierarchy);
                  const attributeDefinition = elementAttributes.find((attr) => attr.name === attributeWithPosInName.name);
                  if (attributeDefinition && attributeDefinition.location) {
                    logger.debug(
                      `Definition found for attribute: ${attributeWithPosInName.name} at ${attributeDefinition.location.uri.toString()}:${attributeDefinition.location.line}:${attributeDefinition.location.column}}`
                    );
                    return new vscode.Location(
                      vscode.Uri.parse(attributeDefinition.location.uri),
                      new vscode.Range(
                        new vscode.Position(attributeDefinition.location.line - 1, attributeDefinition.location.column - 1),
                        new vscode.Position(
                          attributeDefinition.location.line - 1,
                          attributeDefinition.location.column - 1 + attributeDefinition.location.lengthOfStartTag
                        )
                      )
                    );
                  }
                }
                const attributeWithPosInValue = xmlTracker.attributeWithPosInValue(document, position, element);
                if (attributeWithPosInValue) {
                  // Check if cursor is on a variable
                  const variableDefinition = variableTracker.getVariableDefinition(document, position);
                  if (variableDefinition) {
                    logger.debug(`Variable definition found at position: ${position.line + 1}:${position.character} for variable: ${variableDefinition.name}`);
                    return variableDefinition.definition;
                  }

                  const attrValue = attributeWithPosInValue.value;
                  if (!attrValue.includes('$') && !attrValue.startsWith('event.') && !attrValue.startsWith('@event.')) {
                    // Process trackers
                    for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
                      if (token.isCancellationRequested) return undefined;
                      if (trackerInfo.tracker.schema === schema) {
                        const itemDefinition = trackerInfo.tracker.getItemDefinition(document, position);
                        if (itemDefinition) {
                          logger.debug(`Definition found for ${itemType}: ${itemDefinition.name}`);
                          return itemDefinition.definition;
                        }
                      }
                    }
                  }
                  // Fallback to script properties
                  return scriptProperties.provideDefinition(document, position, token);
                }
              }
            }
          },
        })
      );

      // Register hover provider for displaying tooltips and documentation
      disposables.push(
        vscode.languages.registerHoverProvider(xmlSelector, {
          /**
           * Provides hover information for symbols at a given position
           * Shows documentation for elements, attributes, variables, labels, and actions
           */
          provideHover: async (
            document: vscode.TextDocument,
            position: vscode.Position,
            token: vscode.CancellationToken
          ): Promise<vscode.Hover | undefined> => {
            if (token.isCancellationRequested) return undefined;
            const schema = getDocumentScriptType(document);
            if (schema === '') {
              return undefined;
            }

            // Check for language constructs first
            const languageConstructsHover = languageProcessor.provideHover(document, position, token);
            if (languageConstructsHover) {
              return languageConstructsHover;
            }

            // Check if we're in an XML element's start tag
            const element = xmlTracker.elementWithPosInStartTag(document, position);
            if (token.isCancellationRequested) return undefined;
            if (element) {
              // Check if hovering over an element name
              if (xmlTracker.elementWithPosInName(document, position, element)) {
                if (token.isCancellationRequested) return undefined;
                const elementInfo = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
                if (token.isCancellationRequested) return undefined;

                const hoverText = new vscode.MarkdownString();
                if (elementInfo) {
                  const annotationText = XsdReference.extractAnnotationText(elementInfo);
                  hoverText.appendMarkdown(`**${element.name}**: ${annotationText ? '`' + annotationText + '`' : ''}  \n`);
                } else {
                  hoverText.appendMarkdown(`**${element.name}**: \`Wrong element!\`  \n`);
                }
                return new vscode.Hover(hoverText, element.nameRange);
              }
              // Check if hovering over an attribute name
              const attribute = xmlTracker.attributeWithPosInName(document, position, element);
              if (token.isCancellationRequested) return undefined;
              if (attribute) {
                const hoverText = new vscode.MarkdownString();
                const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(
                  schema,
                  attribute.element.name,
                  attribute.element.hierarchy
                );
                if (token.isCancellationRequested) return undefined;
                const attributeInfo = elementAttributes.find((attr) => attr.name === attribute.name);

                if (attributeInfo) {
                  hoverText.appendMarkdown(`**${attribute.name}**: ${attributeInfo.annotation ? '`' + attributeInfo.annotation + '`' : ''}  \n`);
                  hoverText.appendMarkdown(`**Type**: \`${attributeInfo.type}\`  \n`);
                  hoverText.appendMarkdown(`**Required**: \`${attributeInfo.required ? 'Yes' : 'No'}\`  \n`);
                } else {
                  hoverText.appendMarkdown(`**${attribute.name}**: \`Wrong attribute!\`  \n`);
                }
                return new vscode.Hover(hoverText, attribute.nameRange);
              } else {
                const attribute = xmlTracker.attributeWithPosInValue(document, position, element);
                if (token.isCancellationRequested) return undefined;
                if (attribute) {
                  if (token.isCancellationRequested) return undefined;
                  // Check if it inside a single quoted string
                  if (
                    attribute.name === 'comment' ||
                    (!isSingleQuoteExclusion(element.name, attribute.name) &&
                      isInsideSingleQuotedString(
                        document.getText(attribute.valueRange),
                        document.offsetAt(position) - document.offsetAt(attribute.valueRange.start)
                      ))
                  ) {
                    logger.debug(`Hover will not be generated in comment or single-quoted attribute value: ${attribute.element.name}.${attribute.name}`);
                    return undefined;
                  }
                  const attrValue = attribute.value;
                  if (!attrValue.includes('$') && !attrValue.startsWith('event.') && !attrValue.startsWith('@event.')) {
                    // Trackers specific hover information
                    for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
                      if (token.isCancellationRequested) return undefined;
                      if (trackerInfo.tracker.schema === schema) {
                        // Check for action definitions
                        const itemHover = trackerInfo.tracker.getItemHover(document, position);
                        if (itemHover) {
                          return itemHover;
                        }
                      }
                    }
                  }
                  // Check for variable hover
                  const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
                  if (token.isCancellationRequested) return undefined;
                  if (variableAtPosition) {
                    logger.debug(`Hovering over variable: ${variableAtPosition.variable.name}`);
                    const hoverText = VariableTracker.getVariableDetails(variableAtPosition.variable);
                    return new vscode.Hover(hoverText, variableAtPosition.location.range);
                  }

                  // Final fallback to complex expressions hover implementation
                  if (token.isCancellationRequested) return undefined;
                  return scriptProperties.provideHover(document, position, token);
                }
              }
            }
          },
        })
      );

      // ================================================================================================
      // 8. DOCUMENT EVENT HANDLERS
      // ================================================================================================

      logger.info('XSD schemas loaded successfully.');

      // Listen for editor changes to parse documents as they become active
      disposables.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
          if (editor && scriptsMetadataSet(editor.document)) {
            scriptDocumentTracker.trackScriptDocument(editor.document, false);

            // Process any pending document changes when switching editors
            // This ensures immediate processing rather than waiting for next content change
            addUriToRefreshTimeout(editor.document.uri);
          }
        })
      );

      disposables.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
          editors.forEach((editor) => {
            addUriToRefreshTimeout(editor.document.uri);
          });
          logger.debug(`Visible editors changed. Total visible editors: ${editors.length}`);
        })
      );

      // Parse newly opened documents only if they become the active document
      disposables.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
          const scriptMetadata = getDocumentMetadata(document);
          if (scriptMetadata) {
            logger.debug(`Document is opened: ${document.uri.toString()}`);
            ReferencedItemsWithExternalDefinitionsTracker.clearExternalDefinitionsForFile(scriptMetadata.schema, document.uri.fsPath);
            scriptDocumentTracker.trackScriptDocument(document, true);
          }
        })
      );

      // Update XML structure and trigger completion when documents change
      disposables.push(vscode.workspace.onDidChangeTextDocument(onDocumentChange));

      // Update document structure when files are saved
      disposables.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
          if (scriptsMetadataSet(document, true)) {
            scriptDocumentTracker.trackScriptDocument(document, true);
          }
        })
      );

      // Register all disposables
      context.subscriptions.push(...disposables);

      // Clean up cached data when documents are closed
      context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
          const uri = document.uri;

          const stillOpenInTab = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .some((tab) => {
              const input = tab.input as any;
              return input?.uri?.toString() === uri.toString();
            });

          if (!stillOpenInTab) {
            const scriptMetadata = scriptsMetadata.get(document);
            if (scriptMetadata) {
              diagnosticCollection.delete(uri);
              scriptReferencedItemsRegistry.forEach((trackerInfo, itemType) => {
                trackerInfo.tracker.clearItemsForDocument(document);
              });
              ReferencedItemsWithExternalDefinitionsTracker.collectExternalDefinitionsForFile(scriptMetadata, document.uri.fsPath);
            }
            logger.debug(`Removed cached data for document: ${uri.toString()}`);
          } else {
            logger.debug(`Skipped removing diagnostics for: ${uri.toString()} (still open in a tab)`);
          }
        })
      );
      ReferencedItemsWithExternalDefinitionsTracker.clearAllExternalDefinitions();
      await ReferencedItemsWithExternalDefinitionsTracker.collectExternalDefinitions();
      logger.info(`Doing post-startup work now`);
      const documentsUris: vscode.Uri[] = [];

      const openDocument = () => {
        const uri = documentsUris.shift();
        if (uri) {
          const openedDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
          if (openedDoc) {
            logger.debug(`Document found on startup: ${openedDoc.uri.toString()}`);
            scriptDocumentTracker.trackScriptDocument(openedDoc, isActivated);
            openDocument();
          } else {
            vscode.workspace.openTextDocument(uri).then((doc) => {
              logger.debug(`Document re-opened on startup: ${doc.uri.toString()}`);
              openDocument();
            });
          }
        }
      };

      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input && (tab.input as any).uri) {
            const uri = (tab.input as any).uri as vscode.Uri;
            if (uri.fsPath.endsWith('.xml') && uri.scheme === 'file') {
              logger.debug(`Tab found on startup: ${uri.toString()}`);
              documentsUris.push(uri);
            }
          }
        }
      }
      logger.debug(`Documents URIs collected on startup: ${documentsUris.length}`);
      openDocument();
      isActivated = true;
    };
    try {
      if (isActivated) {
        // Show a progress notification that auto-closes when initialization completes
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'X4CodeComplete: refreshing data...' }, async () => {
          await performHeavyInitialization();
        });
      } else {
        await performHeavyInitialization();
      }
    } catch (error) {
      logger.error('Error during heavy services initialization:', error);
      vscode.window.showErrorMessage('Error initializing X4CodeComplete services: ' + error);
    }
  });

  context.subscriptions.push(codeCompleteStartupDone);

  // ================================================================================================
  // 10. CONFIGURATION CHANGE HANDLER
  // ================================================================================================

  // React to configuration changes and reload settings/data as needed
  const configChangeDisposable = configManager.registerConfigurationChangeListener();
  context.subscriptions.push(configChangeDisposable);

  // Commands: Reload language files
  context.subscriptions.push(
    vscode.commands.registerCommand('x4CodeComplete.reloadLanguageFiles', async () => {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'X4CodeComplete: reloading language files...' }, async () => {
          await languageProcessor
            .loadLanguageFiles(configManager.config.unpackedFileLocation, configManager.config.extensionsFolder)
            .then(() => logger.info('Language files reloaded via command.'))
            .catch((err) => {
              logger.error('Failed to reload language files via command:', err);
              vscode.window.showErrorMessage('Failed to reload language files: ' + err);
            });
        });
      } catch (e) {
        logger.error('Unexpected error reloading language files:', e);
      }
    })
  );

  // Commands: Reload extracted files (full heavy re-initialization)
  context.subscriptions.push(
    vscode.commands.registerCommand('x4CodeComplete.reloadExtractedFiles', async () => {
      try {
        codeCompleteStartupDone.fire();
      } catch (e) {
        logger.error('Unexpected error triggering extracted files reload:', e);
      }
    })
  );

  // // Update local references when configuration changes
  // context.subscriptions.push(
  //   vscode.workspace.onDidChangeConfiguration(configManager.handleConfigurationChange)
  // );

  // ================================================================================================
  // 11. ADVANCED LANGUAGE PROVIDERS (CODE ACTIONS, REFERENCES, RENAME)
  // ================================================================================================

  // Add code action provider for quick fixes and suggestions
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(xmlSelector, {
      /**
       * Provides quick fix actions for diagnostic errors
       * Currently handles:
       * - Undefined label errors: suggests similar existing labels or creates new ones
       * - Undefined action errors: creates new action definitions or suggests similar ones
       */
      provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
      ): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        if (token.isCancellationRequested) return undefined;
        const actions: vscode.CodeAction[] = [];

        // Process each diagnostic to provide appropriate quick fixes
        for (const diagnostic of context.diagnostics) {
          if (token.isCancellationRequested) return actions;
          if (diagnostic.source === 'X4CodeComplete') {
            // Handle undefined label errors
            if (diagnostic.code.toString().startsWith('undefined-')) {
              const itemType = diagnostic.code.toString().split('-')[1];
              if (itemType && scriptReferencedItemsRegistry.has(itemType)) {
                const trackerInfo = scriptReferencedItemsRegistry.get(itemType);
                if (trackerInfo) {
                  const itemName = diagnostic.message.match(/'(.+)'/)?.[1];
                  if (itemName) {
                    const similarItems = trackerInfo.tracker.getSimilarItems(document, itemName);
                    similarItems.forEach((similarItem) => {
                      if (token.isCancellationRequested) return;
                      if (similarItem === itemName) {
                        return; // Skip if the item is the same as the one causing the error
                      }
                      const replaceAction = new vscode.CodeAction(`Replace with existing ${itemType} '${similarItem}'`, vscode.CodeActionKind.QuickFix);
                      replaceAction.edit = new vscode.WorkspaceEdit();
                      replaceAction.edit.replace(document.uri, diagnostic.range, similarItem);
                      replaceAction.diagnostics = [diagnostic];
                      replaceAction.isPreferred = similarItems.indexOf(similarItem) === 0;
                      actions.push(replaceAction);
                    });
                  }
                } else {
                  logger.debug(`No tracker found for item type: ${itemType}`);
                }
              }
            }
          }
        }

        return actions;
      },
    } as vscode.CodeActionProvider)
  );

  // Add reference provider for actions in AIScript
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(xmlSelector, {
      provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken) {
        if (token.isCancellationRequested) return undefined;
        const schema = getDocumentScriptType(document);
        if (schema == '') {
          return undefined;
        }

        // Check if we're on a variable
        const variableReferences = variableTracker.getVariableLocations(document, position);
        if (variableReferences) {
          logger.debug(`References found for variable: ${variableReferences.name}`);
          return variableReferences.references;
        }
        for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
          if (token.isCancellationRequested) return undefined;
          if (trackerInfo.tracker.schema === schema) {
            const itemReferences = trackerInfo.tracker.getItemReferences(document, position);
            if (itemReferences) {
              logger.debug(`References found for ${itemType}: ${itemReferences.name}`);
              return itemReferences.references;
            }
          }
        }
        return [];
      },
    })
  );

  // Register rename provider for symbols (variables, actions, labels)
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(xmlSelector, {
      provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken) {
        if (token.isCancellationRequested) return undefined;
        const schema = getDocumentScriptType(document);
        if (schema == '') {
          return undefined; // Skip if the document is not valid
        }
        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
        if (variableAtPosition) {
          const variableName = variableAtPosition.variable.name;
          const variableType = variableAtPosition.variable.type;
          const locations = variableAtPosition.variable.locations;
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

          // Update the tracker with the new name
          variableTracker.updateVariableName(variableType, variableName, newName, document);

          return workspaceEdit;
        }

        // Debug log: No variable name found
        logger.debug(`No variable name found at position: ${position}`);
        return undefined;
      },
    })
  );

  logger.info('X4CodeComplete extension activated successfully.');
  logger.info('Heavy services will be initialized asynchronously...');
  codeCompleteStartupDone.fire();
}

// ================================================================================================
// 12. EXTENSION DEACTIVATION
// ================================================================================================

/**
 * Extension deactivation function
 * Called when the extension is being deactivated - performs cleanup of resources
 */
export function deactivate() {
  logger.info('Extension deactivation started...');

  try {
    // ================================================================================================
    // DOCUMENT CHANGE CLEANUP
    // ================================================================================================

    // Clear any pending refresh timeout
    if (refreshTimeoutId) {
      clearTimeout(refreshTimeoutId);
      refreshTimeoutId = undefined;
      logger.debug('Cleared pending refresh timeout');
    }

    // Clear document change tracking data
    documentChanges.clear();
    urisToRefresh.clear();
    logger.debug('Cleared document change tracking data');

    // ================================================================================================
    // DIAGNOSTIC COLLECTION CLEANUP
    // ================================================================================================

    if (diagnosticCollection) {
      diagnosticCollection.clear();
      diagnosticCollection.dispose();
      logger.debug('Diagnostic collection cleared and disposed');
    }

    // ================================================================================================
    // TRACKER CLEANUP
    // ================================================================================================

    // Clear variable tracking data
    if (variableTracker) {
      variableTracker.dispose();
      logger.debug('Variable tracker disposed');
    }

    // Clear referenced items tracking data
    for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
      if (trackerInfo.tracker) {
        trackerInfo.tracker.dispose();
        logger.debug(`Tracker for ${itemType} disposed`);
      }
    }

    // ================================================================================================
    // SERVICE PROVIDER CLEANUP
    // ================================================================================================

    // Clear script properties data
    if (scriptProperties) {
      scriptProperties.dispose();
      logger.debug('Script properties disposed');
    }

    // Clear language processor data
    if (languageProcessor) {
      languageProcessor.dispose();
      logger.debug('Language processor disposed');
    }

    // Clear XSD reference data
    if (xsdReference) {
      xsdReference.dispose();
      logger.debug('XSD reference disposed');
    }

    // ================================================================================================
    // CONFIGURATION MANAGER CLEANUP
    // ================================================================================================

    // Clear configuration manager
    if (configManager) {
      configManager.dispose();
      logger.debug('Configuration manager disposed');
    }

    // ================================================================================================
    // METADATA AND GLOBAL STATE CLEANUP
    // ================================================================================================

    // Clear scripts metadata
    if (scriptsMetadata) {
      scriptsMetadataClearAll();
      logger.debug('Scripts metadata cleared');
    }

    // Reset global configuration flags
    logger.debug('Global configuration flags reset');
    configManager.dispose();
    logger.info('Extension deactivated successfully');
  } catch (error) {
    logger.error('Error during extension deactivation:', error);
  }
}
