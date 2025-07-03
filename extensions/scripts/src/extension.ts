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

// Core functionality imports
import { xmlTracker, XmlElement, XmlStructureTracker } from './xml/xmlStructureTracker';
import { logger, setLoggerLevel } from './logger/logger';
import { XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from 'xsd-lookup';

// Script-specific functionality imports
import { ReferencedItemsTracker, ReferencedItemsWithExternalTracker } from './scripts/scriptReferencedItems';
import { ScriptProperties } from './scripts/scriptProperties';
import { getDocumentScriptType, scriptsMetadata, aiScriptId, mdScriptId, scriptNodes, scriptsMetadataSet, scriptsMetadataClearAll } from './scripts/scriptsMetadata';
import { VariableTracker } from './scripts/scriptVariables';
import { ScriptCompletion } from './scripts/scriptCompletion';
import { LanguageFileProcessor } from './languageFiles/languageFiles';
import { ScriptDocumentTracker} from './scripts/scriptDocumentTracker';

// ================================================================================================
// 2. TYPE DEFINITIONS AND CONSTANTS
// ================================================================================================

/** Extension configuration interface */
interface X4CodeCompleteConfig {
  /** Path to unpacked X4 game files */
  unpackedFileLocation: string;
  /** Path to extensions folder */
  extensionsFolder: string;
  /** Enable debug logging */
  debug: boolean;
  /** Force completion suggestions */
  forcedCompletion: boolean;
  /** Language number for language files (default: '44' for English) */
  languageNumber: string;
  /** Limit language output to prevent performance issues */
  limitLanguageOutput: boolean;
  /** Flag to trigger reloading of language data */
  reloadLanguageData: boolean;
}

/** Type definitions for external action tracking (future use) */
type ExternalPositions = Map<string, number>;
type ExternalActions = Map<string, ExternalPositions>;

/** Configuration constants */
const EXTENSION_NAME = 'X4CodeComplete';
const REQUIRED_SETTINGS = ['unpackedFileLocation', 'extensionsFolder'] as const;
const CONFIG_SECTION = 'x4CodeComplete';

// ================================================================================================
// 3. GLOBAL VARIABLES AND CONFIGURATION
// ================================================================================================

/** Extension configuration and state variables */
let isDebugEnabled = false;
let extensionConfig: X4CodeCompleteConfig;

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
const labelTracker = new ReferencedItemsTracker('label');
const actionsTracker = new ReferencedItemsWithExternalTracker('actions');

// ================================================================================================
// 5. UTILITY FUNCTIONS
// ================================================================================================

/**
 * Loads configuration from VS Code settings
 * @param config - The VS Code workspace configuration
 * @returns The extension configuration object
 */
function loadExtensionConfig(config: vscode.WorkspaceConfiguration): X4CodeCompleteConfig {
  return {
    unpackedFileLocation: config.get('unpackedFileLocation') || '',
    extensionsFolder: config.get('extensionsFolder') || '',
    debug: config.get('debug') || false,
    forcedCompletion: config.get('forcedCompletion') || false,
    languageNumber: config.get('languageNumber') || '44',
    limitLanguageOutput: config.get('limitLanguageOutput') || false,
    reloadLanguageData: config.get('reloadLanguageData') || false
  };
}

/**
 * Creates a default configuration object
 * @returns Default configuration with safe fallback values
 */
function createDefaultConfig(): X4CodeCompleteConfig {
  return {
    unpackedFileLocation: '',
    extensionsFolder: '',
    debug: false,
    forcedCompletion: false,
    languageNumber: '44',
    limitLanguageOutput: false,
    reloadLanguageData: false
  };
}

/**
 * Validates that all required extension settings are configured
 * @param config - The extension configuration object
 * @returns true if all required settings are present, false otherwise
 */
function validateSettings(config: X4CodeCompleteConfig): boolean {
  let isValid = true;
  REQUIRED_SETTINGS.forEach((setting) => {
    if (!config[setting]) {
      vscode.window.showErrorMessage(`Missing required setting: ${setting}. Please update your VSCode settings.`);
      isValid = false;
    }
  });

  return isValid;
}

/**
 * Gets the libraries path from configuration
 * @returns Full path to the libraries directory
 */
function getLibrariesPath(): string {
  return path.join(extensionConfig.unpackedFileLocation, 'libraries');
}


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
  // Load and validate configuration
  let config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  extensionConfig = loadExtensionConfig(config);

  if (!validateSettings(extensionConfig)) {
    return;
  }

  // Configure logging based on debug setting
  if (extensionConfig.debug) {
    isDebugEnabled = true;
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
  languageProcessor.loadLanguageFiles(extensionConfig.unpackedFileLocation, extensionConfig.extensionsFolder)
    .then(() => {
      logger.info('Language files loaded successfully.');
    })
    .catch((error) => {
      logger.error('Error loading language files:', error);
      vscode.window.showErrorMessage('Error loading language files: ' + error);
    });

  // Initialize script analysis services
  scriptProperties = new ScriptProperties(path.join(getLibrariesPath(), '/'));
  xsdReference = new XsdReference(getLibrariesPath());
  scriptCompletionProvider = new ScriptCompletion(
    xsdReference,
    xmlTracker,
    scriptProperties,
    labelTracker,
    actionsTracker,
    variableTracker
  );

  scriptDocumentTracker = new ScriptDocumentTracker(
    xmlTracker,
    xsdReference,
    variableTracker,
    labelTracker,
    actionsTracker,
    diagnosticCollection,
  );
  // ================================================================================================
  // 7. LANGUAGE PROVIDER REGISTRATIONS
  // ================================================================================================

  // Register language providers
  const xmlSelector: vscode.DocumentSelector = { language: 'xml' };

  // Register completion provider with trigger characters
  const disposableCompleteProvider = vscode.languages.registerCompletionItemProvider(
    xmlSelector,
    scriptCompletionProvider,
    '.', '"', '{', ' ', '<'
  );
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
          // Check for action definitions
          const actionsDefinition = actionsTracker.getItemDefinition(document, position);
          if (actionsDefinition) {
            logger.debug(`Definition found for action: ${actionsDefinition.name}`);
            return actionsDefinition.definition;
          }

          // Check for label definitions
          const labelDefinition = labelTracker.getItemDefinition(document, position);
          if (labelDefinition) {
            logger.debug(`Definition found for label: ${labelDefinition.name}`);
            return labelDefinition.definition;
          }
        }

        // Fallback to script properties
        return scriptProperties.provideDefinition(document, position);
      }
    })
  );

  // Register hover provider for displaying tooltips and documentation
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(xmlSelector, {
      /**
       * Provides hover information for symbols at a given position
       * Shows documentation for elements, attributes, variables, labels, and actions
       */
      provideHover: async (
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.Hover | undefined> => {
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
              hoverText.appendMarkdown(`**${attribute.name}**: ${attributeInfo.annotation ? '\`' + attributeInfo.annotation + '\`' : ''}\n\n`);
              hoverText.appendMarkdown(`**Type**: \`${attributeInfo.type}\`\n\n`);
              hoverText.appendMarkdown(`**Required**: \`${attributeInfo.required ? 'Yes' : 'No'}\`\n\n`);
            } else {
              hoverText.appendMarkdown(`**${attribute.name}**: \`Wrong attribute!\`\n\n`);
            }
            return new vscode.Hover(hoverText, attribute.nameRange);
          }
          // Check if hovering over an element name
          else if (xmlTracker.elementWithPosInName(document, position)) {
            const elementInfo = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
            const hoverText = new vscode.MarkdownString();

            if (elementInfo) {
              const annotationText = XsdReference.extractAnnotationText(elementInfo);
              hoverText.appendMarkdown(`**${element.name}**: ${annotationText ? '\`' + annotationText + '\`' : ''}\n\n`);
            } else {
              hoverText.appendMarkdown(`**${element.name}**: \`Wrong element!\`\n\n`);
            }
            return new vscode.Hover(hoverText, element.nameRange);
          }
        }

        // AI script specific hover information
        if (schema === aiScriptId) {
          // Check for action hover
          const actionsHover = actionsTracker.getItemHover(document, position);
          if (actionsHover) {
            return actionsHover;
          }

          // Check for label hover
          const labelHover = labelTracker.getItemHover(document, position);
          if (labelHover) {
            return labelHover;
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
        // // Only parse if this is the active document
        // const activeEditor = vscode.window.activeTextEditor;
        // if (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()) {
         scriptDocumentTracker.trackScriptDocument(document);
      //   }
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
          if (extensionConfig.forcedCompletion && scriptCompletionProvider.prepareCompletion(event.document, cursorPos, true) !== undefined) {
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
      diagnosticCollection.delete(document.uri);
      actionsTracker.clearItemsForDocument(document);
      labelTracker.clearItemsForDocument(document);
      logger.debug(`Removed cached data for document: ${document.uri.toString()}`);
    })
  );


  // ================================================================================================
  // 9. EXTENSION STARTUP HANDLER
  // ================================================================================================

  onCodeCompleteStartupProcessed(() => {
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
        vscode.workspace.textDocuments.forEach(doc => {
          logger.debug(`Document found on startup: ${doc.uri.toString()}`);
          if (doc.languageId === 'xml') {
            scriptDocumentTracker.trackScriptDocument(doc, true);
          }
        });
      }
    };
    openDocument();
  });

  context.subscriptions.push(
    codeCompleteStartupDone
  );

  // ================================================================================================
  // 10. CONFIGURATION CHANGE HANDLER
  // ================================================================================================

  // React to configuration changes and reload settings/data as needed
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        logger.info('Configuration changed. Reloading settings...');
        config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        extensionConfig = loadExtensionConfig(config);

        // Update debug logging level if changed
        if (extensionConfig.debug !== isDebugEnabled) {
          isDebugEnabled = extensionConfig.debug;
          if (isDebugEnabled) {
            setLoggerLevel('debug');
          } else {
            setLoggerLevel('info');
          }
        }

        // Reload language files if relevant paths or settings have changed
        if (
          event.affectsConfiguration('x4CodeComplete.unpackedFileLocation') ||
          event.affectsConfiguration('x4CodeComplete.extensionsFolder') ||
          event.affectsConfiguration('x4CodeComplete.languageNumber') ||
          event.affectsConfiguration('x4CodeComplete.limitLanguageOutput') ||
          event.affectsConfiguration('x4CodeComplete.reloadLanguageData')
        ) {
          logger.info('Reloading language files due to configuration changes...');
          languageProcessor.loadLanguageFiles(extensionConfig.unpackedFileLocation, extensionConfig.extensionsFolder)
            .then(() => {
              logger.info('Language files reloaded successfully.');
            })
            .catch((error) => {
              logger.info('Failed to reload language files:', error);
            });

          // Reset the reloadLanguageData flag to false after processing
          if (event.affectsConfiguration('x4CodeComplete.reloadLanguageData')) {
            vscode.workspace
              .getConfiguration()
              .update('x4CodeComplete.reloadLanguageData', false, vscode.ConfigurationTarget.Global);
          }
        }
      }
    })
  );

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
            if (diagnostic.code === 'undefined-label') {
              const labelName = diagnostic.message.match(/'(.+)'/)?.[1];
              if (labelName) {
                // Suggest similar existing labels as replacements
                const similarLabels = labelTracker.getSimilarItems(document, labelName);
                similarLabels.forEach((similarLabel) => {
                  const replaceAction = new vscode.CodeAction(
                    `Replace with existing label '${similarLabel}'`,
                    vscode.CodeActionKind.QuickFix
                  );
                  replaceAction.edit = new vscode.WorkspaceEdit();
                  replaceAction.edit.replace(document.uri, diagnostic.range, similarLabel);
                  replaceAction.diagnostics = [diagnostic];
                  replaceAction.isPreferred = similarLabels.indexOf(similarLabel) === 0;
                  actions.push(replaceAction);
                });
              }
            }
            // Handle undefined action errors
            else if (diagnostic.code === 'undefined-action') {
              const actionName = diagnostic.message.match(/'(.+)'/)?.[1];
              if (actionName) {
                // Create action to add new action definition
                const createAction = new vscode.CodeAction(
                  `Create action '${actionName}'`,
                  vscode.CodeActionKind.QuickFix
                );
                createAction.edit = new vscode.WorkspaceEdit();

                // Determine where to insert the new action definition
                const text = document.getText();
                const libraryMatch = text.match(/<library>/);
                let insertPosition: vscode.Position;
                let insertText: string;

                if (libraryMatch) {
                  // Insert into existing library section
                  const libraryStartIndex = text.indexOf('<library>') + '<library>'.length;
                  insertPosition = document.positionAt(libraryStartIndex);
                  insertText = `\n  <actions name="${actionName}">\n    <!-- TODO: Implement action -->\n  </actions>`;
                } else {
                  // Create new library section
                  const aiscriptMatch = text.match(/<aiscript[^>]*>/);
                  if (aiscriptMatch) {
                    const aiscriptEndIndex = text.indexOf('>', text.indexOf(aiscriptMatch[0])) + 1;
                    insertPosition = document.positionAt(aiscriptEndIndex);
                    insertText = `\n  <library>\n    <actions name="${actionName}">\n      <!-- TODO: Implement action -->\n    </actions>\n  </library>`;
                  } else {
                    insertPosition = new vscode.Position(1, 0);
                    insertText = `<library>\n  <actions name="${actionName}">\n    <!-- TODO: Implement action -->\n  </actions>\n</library>\n`;
                  }
                }

                createAction.edit.insert(document.uri, insertPosition, insertText);
                createAction.diagnostics = [diagnostic];
                actions.push(createAction);

                // Also suggest similar existing actions as alternatives
                const similarActions = actionsTracker.getSimilarItems(document, actionName);
                similarActions.forEach((similarAction) => {
                  const replaceAction = new vscode.CodeAction(
                    `Replace with existing action '${similarAction}'`,
                    vscode.CodeActionKind.QuickFix
                  );
                  replaceAction.edit = new vscode.WorkspaceEdit();
                  replaceAction.edit.replace(document.uri, diagnostic.range, similarAction);
                  replaceAction.diagnostics = [diagnostic];
                  replaceAction.isPreferred = similarActions.indexOf(similarAction) === 0;
                  actions.push(replaceAction);
                });
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
          // Check if we're on an action
          const actionsReferences = actionsTracker.getItemReferences(document, position);
          if (actionsReferences) {
            logger.debug(`References found for action: ${actionsReferences.name}`);
            return actionsReferences.references;
          }

          // Check if we're on a label
          const labelReferences = labelTracker.getItemReferences(document, position);
          if (labelReferences) {
            logger.debug(`References found for label: ${labelReferences.name}`);
            return labelReferences.references;
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
            logger.debug(
              `Editing file: ${location.uri.fsPath}, Range: ${location.range}, Old Text: ${rangeText}, New Text: ${replacementText}`
            );
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

    // Clear label tracking data
    if (labelTracker) {
      labelTracker.dispose();
      logger.debug('Label tracker disposed');
    }

    // Clear action tracking data
    if (actionsTracker) {
      actionsTracker.dispose();
      logger.debug('Actions tracker disposed');
    }

    // Clear XML structure tracking data
    if (xmlTracker) {
      xmlTracker.dispose();
      logger.debug('XML tracker disposed');
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
    // METADATA AND GLOBAL STATE CLEANUP
    // ================================================================================================

    // Clear scripts metadata
    if (scriptsMetadata) {
      scriptsMetadataClearAll();
      logger.debug('Scripts metadata cleared');
    }

    // Reset global configuration flags
    isDebugEnabled = false;
    extensionConfig = createDefaultConfig();
    logger.debug('Global configuration flags reset');

    logger.info('Extension deactivated successfully');
  } catch (error) {
    logger.error('Error during extension deactivation:', error);
  }
}
