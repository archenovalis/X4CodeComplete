/**
 * X4CodeComplete VS Code Extension
 * 1. Imports and Dependencies
 * 2. Type Definitions and Constants
 * 3. Global Variables and Configuration
 * 4. Tracker Instances
 * 5. Utility Functions (Extension-specific)
 * 6. Extension Activation
 * 7. Language Provider Registrations
 * 8. Document Event Handlers
 * 9. Extension Startup Handler
 * 10. Configuration Change Handler
 * 11. Advanced Language Providers
 * 12. Extension Deactivation
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
import { X4CodeCompleteConfig, X4ConfigurationManager, ConfigChangeCallbacks } from './extension/configuration';

// Core functionality imports
import { xmlTracker, XmlElement, XmlStructureTracker } from './xml/xmlStructureTracker';
import { logger, setLoggerLevel } from './logger/logger';
import { XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from 'xsd-lookup';

// Script-specific functionality imports
import { ReferencedItemsTracker, ReferencedItemsWithExternalDefinitionsTracker, scriptReferencedItemsRegistry } from './scripts/scriptReferencedItems';
import { ScriptProperties } from './scripts/scriptProperties';
import { getDocumentScriptType, scriptsMetadata, aiScriptId, mdScriptId, scriptsMetadataSet, scriptsMetadataClearAll } from './scripts/scriptsMetadata';
import { VariableTracker } from './scripts/scriptVariables';
import { ScriptCompletion } from './scripts/scriptCompletion';
import { LanguageFileProcessor } from './languageFiles/languageFiles';
import { ScriptDocumentTracker } from './scripts/scriptDocumentTracker';

// ================================================================================================
// 2. TYPE DEFINITIONS AND CONSTANTS
// ================================================================================================

// ================================================================================================
// 3. GLOBAL VARIABLES AND CONFIGURATION
// ================================================================================================

/** Extension configuration and state variables */
let configManager: X4ConfigurationManager;

/** Core service instances */
let xsdReference: XsdReference;
let scriptProperties: ScriptProperties;
let languageProcessor: LanguageFileProcessor;
let scriptCompletionProvider: ScriptCompletion;
let scriptDocumentTracker: ScriptDocumentTracker;
let diagnosticCollection: vscode.DiagnosticCollection;

// ================================================================================================
// 4. TRACKER INSTANCES
// ================================================================================================

/** Global tracker instances for document analysis */
const variableTracker = new VariableTracker();

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
      await languageProcessor
        .loadLanguageFiles(config.unpackedFileLocation, config.extensionsFolder)
        .then(() => {
          logger.info('Language files reloaded successfully.');
        })
        .catch((error) => {
          logger.error('Failed to reload language files:', error);
        });
    },

    onResetReloadFlag: async () => {
      await vscode.workspace.getConfiguration().update('x4CodeComplete.reloadLanguageData', false, vscode.ConfigurationTarget.Global);
      logger.debug('Reload language data flag reset to false');
    },
  };

  // Initialize configuration manager
  configManager = new X4ConfigurationManager(configCallbacks);

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
  diagnosticCollection = vscode.languages.createDiagnosticCollection('x4CodeComplete');
  context.subscriptions.push(diagnosticCollection);

  // Initialize language processor and load language files
  languageProcessor = new LanguageFileProcessor();
  languageProcessor
    .loadLanguageFiles(configManager.config.unpackedFileLocation, configManager.config.extensionsFolder)
    .then(() => {
      logger.info('Language files loaded successfully.');
    })
    .catch((error) => {
      logger.error('Error loading language files:', error);
      vscode.window.showErrorMessage('Error loading language files: ' + error);
    });

  // Initialize script analysis services

  xsdReference = new XsdReference(configManager.librariesPath);
  scriptProperties = new ScriptProperties(path.join(configManager.librariesPath, '/'));
  scriptCompletionProvider = new ScriptCompletion(xsdReference, xmlTracker, scriptProperties, variableTracker);
  scriptDocumentTracker = new ScriptDocumentTracker(xmlTracker, xsdReference, variableTracker, diagnosticCollection);

  // ================================================================================================
  // 7. LANGUAGE PROVIDER REGISTRATIONS
  // ================================================================================================

  // Register language providers
  const xmlSelector: vscode.DocumentSelector = { language: 'xml' };

  // Register completion provider with trigger characters
  const disposableCompleteProvider = vscode.languages.registerCompletionItemProvider(xmlSelector, scriptCompletionProvider, '.', '"', '{', ' ', '<');
  context.subscriptions.push(disposableCompleteProvider);

  // Register definition provider for go-to-definition functionality
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(xmlSelector, {
      /**
       * Provides definition locations for symbols at a given position
       * Handles variables, actions, labels, and script properties
       */
      provideDefinition: async (document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> => {
        const schema = getDocumentScriptType(document);
        if (schema === '') {
          return undefined;
        }

        // Check if cursor is on a variable
        const variableDefinition = variableTracker.getVariableDefinition(document, position);
        if (variableDefinition) {
          logger.debug(`Variable definition found at position: ${position.line + 1}:${position.character} for variable: ${variableDefinition.name}`);
          return variableDefinition.definition;
        }

        // AI script specific features
        if (schema === aiScriptId) {
          for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
            const itemDefinition = trackerInfo.tracker.getItemDefinition(document, position);
            if (itemDefinition) {
              logger.debug(`Definition found for ${itemType}: ${itemDefinition.name}`);
              return itemDefinition.definition;
            }
          }
        }

        // Fallback to script properties
        return scriptProperties.provideDefinition(document, position);
      },
    })
  );

  // Register hover provider for displaying tooltips and documentation
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(xmlSelector, {
      /**
       * Provides hover information for symbols at a given position
       * Shows documentation for elements, attributes, variables, labels, and actions
       */
      provideHover: async (document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> => {
        const schema = getDocumentScriptType(document);
        if (schema === '') {
          return undefined;
        }

        // Check for language constructs first
        const languageConstructsHover = languageProcessor.provideHover(document, position);
        if (languageConstructsHover) {
          return languageConstructsHover;
        }

        // Check if we're in an XML element's start tag
        const element = xmlTracker.elementWithPosInStartTag(document, position);
        if (element) {
          // Check if hovering over an attribute name
          const attribute = xmlTracker.attributeWithPosInName(document, position);
          if (attribute) {
            const hoverText = new vscode.MarkdownString();
            const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(
              schema,
              attribute.element.name,
              attribute.element.hierarchy
            );
            const attributeInfo = elementAttributes.find((attr) => attr.name === attribute.name);

            if (attributeInfo) {
              hoverText.appendMarkdown(`**${attribute.name}**: ${attributeInfo.annotation ? '`' + attributeInfo.annotation + '`' : ''}  \n`);
              hoverText.appendMarkdown(`**Type**: \`${attributeInfo.type}\`  \n`);
              hoverText.appendMarkdown(`**Required**: \`${attributeInfo.required ? 'Yes' : 'No'}\`  \n`);
            } else {
              hoverText.appendMarkdown(`**${attribute.name}**: \`Wrong attribute!\`  \n`);
            }
            return new vscode.Hover(hoverText, attribute.nameRange);
          }
          // Check if hovering over an element name
          else if (xmlTracker.elementWithPosInName(document, position)) {
            const elementInfo = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
            const hoverText = new vscode.MarkdownString();

            if (elementInfo) {
              const annotationText = XsdReference.extractAnnotationText(elementInfo);
              hoverText.appendMarkdown(`**${element.name}**: ${annotationText ? '`' + annotationText + '`' : ''}  \n`);
            } else {
              hoverText.appendMarkdown(`**${element.name}**: \`Wrong element!\`  \n`);
            }
            return new vscode.Hover(hoverText, element.nameRange);
          }
        }

        // AI script specific hover information
        if (schema === aiScriptId) {
          for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
            // Check for action definitions
            const itemHover = trackerInfo.tracker.getItemHover(document, position);
            if (itemHover) {
              return itemHover;
            }
          }
        }

        // Check for variable hover
        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);
        if (variableAtPosition) {
          logger.debug(`Hovering over variable: ${variableAtPosition.variable.name}`);
          const hoverText = VariableTracker.getVariableDetails(variableAtPosition.variable);
          return new vscode.Hover(hoverText, variableAtPosition.location.range);
        }

        // Fallback to script properties
        return scriptProperties.provideHover(document, position);
      },
    })
  );

  // ================================================================================================
  // 8. DOCUMENT EVENT HANDLERS
  // ================================================================================================

  logger.info('XSD schemas loaded successfully.');

  // Listen for editor changes to parse documents as they become active
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && scriptsMetadataSet(editor.document)) {
        scriptDocumentTracker.trackScriptDocument(editor.document, true);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      // editors.forEach((editor) => {
      //   if (scriptsMetadataSet(editor.document)) {
      //    scriptDocumentTracker.trackScriptDocument(editor.document);
      //   }
      // });
      logger.debug(`Visible editors changed. Total visible editors: ${editors.length}`);
    })
  );

  // Parse newly opened documents only if they become the active document
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (scriptsMetadataSet(document)) {
        scriptDocumentTracker.trackScriptDocument(document, true);
      }
    })
  );

  // Update XML structure and trigger completion when documents change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || event.document !== activeEditor.document) return;

      if (scriptsMetadataSet(event.document, true)) {
        if (event.contentChanges.length > 0) {
          const cursorPos = activeEditor.selection.active;

          // Update the document structure on change
          scriptDocumentTracker.trackScriptDocument(event.document, true, cursorPos);

          // Check if we're in a specialized completion context and trigger suggestions if needed
          if (configManager.config.forcedCompletion && scriptCompletionProvider.prepareCompletion(event.document, cursorPos, true) !== undefined) {
            logger.info(`Triggering suggestions for document: ${event.document.uri.toString()}`);
            vscode.commands.executeCommand('editor.action.triggerSuggest');
          }
        }
      }
    })
  );

  // Update document structure when files are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (scriptsMetadataSet(document, true)) {
        scriptDocumentTracker.trackScriptDocument(document, true);
      }
    })
  );

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
        diagnosticCollection.delete(uri);
        scriptReferencedItemsRegistry.forEach((trackerInfo, itemType) => {
          trackerInfo.tracker.clearItemsForDocument(document);
        });
        logger.debug(`Removed cached data for document: ${uri.toString()}`);
      } else {
        logger.debug(`Skipped removing diagnostics for: ${uri.toString()} (still open in a tab)`);
      }
    })
  );

  // ================================================================================================
  // 9. EXTENSION STARTUP HANDLER
  // ================================================================================================

  onCodeCompleteStartupProcessed(() => {
    ReferencedItemsWithExternalDefinitionsTracker.collectExternalDefinitions(configManager.config);
    logger.info(`Doing post-startup work now`);
    const documentsUris: vscode.Uri[] = [];
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
    const openDocument = () => {
      const uri = documentsUris.shift();
      if (uri) {
        vscode.workspace.openTextDocument(uri).then((doc) => {
          openDocument();
        });
      } else {
        // Initialize by parsing the currently active document
        vscode.workspace.textDocuments.forEach((doc) => {
          logger.debug(`Document found on startup: ${doc.uri.toString()}`);
          if (doc.languageId === 'xml') {
            scriptDocumentTracker.trackScriptDocument(doc, true);
          }
        });
      }
    };
    openDocument();
  });

  context.subscriptions.push(codeCompleteStartupDone);

  // ================================================================================================
  // 10. CONFIGURATION CHANGE HANDLER
  // ================================================================================================

  // React to configuration changes and reload settings/data as needed
  const configChangeDisposable = configManager.registerConfigurationChangeListener();
  context.subscriptions.push(configChangeDisposable);

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
        const actions: vscode.CodeAction[] = [];

        // Process each diagnostic to provide appropriate quick fixes
        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === 'X4CodeComplete') {
            // Handle undefined label errors
            if (diagnostic.code.toString().startsWith('undefined-')) {
              const itemType = diagnostic.code.toString().split('-')[1];
              if (itemType && scriptReferencedItemsRegistry.has(itemType)) {
                const trackerInfo = scriptReferencedItemsRegistry.get(itemType);
                if (trackerInfo) {
                  const itemName = diagnostic.message.match(/'(.+)'/)?.[1];
                  const similarItems = trackerInfo.tracker.getSimilarItems(document, itemName);
                  similarItems.forEach((similarItem) => {
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
      provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext) {
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
        if (schema == aiScriptId) {
          for (const [itemType, trackerInfo] of scriptReferencedItemsRegistry) {
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
      provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string) {
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

  codeCompleteStartupDone.fire();

  logger.info('X4CodeComplete extension activated successfully.');
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
