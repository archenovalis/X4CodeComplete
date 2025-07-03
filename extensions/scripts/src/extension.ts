// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as sax from 'sax';
import { xmlTracker, XmlElement, XmlStructureTracker } from './xml/xmlStructureTracker';
import { logger, setLoggerLevel } from './logger/logger';
import { XsdReference, AttributeInfo, EnhancedAttributeInfo, AttributeValidationResult } from 'xsd-lookup';
import { ReferencedItemsTracker, findSimilarItems, checkReferencedItemAttributeType, ScriptReferencedCompletion } from './scripts/scriptReferencedItems';
import { ScriptProperties } from './scripts/scriptProperties';
import { getDocumentScriptType, scriptsMetadata, aiScriptId, mdScriptId, scriptNodes, scriptsMetadataSet, scriptsMetadataClearAll } from './scripts/scriptsMetadata';
import { VariableTracker } from './scripts/scriptVariables';
import { ScriptCompletion } from './scripts/scriptCompletion';
import { LanguageFileProcessor } from './languageFiles/languageFiles';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
let isDebugEnabled = false;
let rootpath: string;
let extensionsFolder: string;
let forcedCompletion: boolean = false;
let xsdReference: XsdReference;
let scriptProperties: ScriptProperties;
let languageProcessor : LanguageFileProcessor;





// Flag to indicate if specialized completion is active
// let isSpecializedCompletion: boolean = false;

// Map to store languageSubId for each document
const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]+)/g;
const tableKeyPattern = /table\[/;



// Add settings validation function
function validateSettings(config: vscode.WorkspaceConfiguration): boolean {
  const requiredSettings = ['unpackedFileLocation', 'extensionsFolder'];

  let isValid = true;
  requiredSettings.forEach((setting) => {
    if (!config.get(setting)) {
      vscode.window.showErrorMessage(`Missing required setting: ${setting}. Please update your VSCode settings.`);
      isValid = false;
    }
  });

  return isValid;
}



const variableTracker = new VariableTracker();
const labelTracker = new ReferencedItemsTracker('label');
const actionsTracker = new ReferencedItemsTracker('actions');


type ExternalPositions = Map<string, number>;
type ExternalActions = Map<string, ExternalPositions>;
// ActionTracker class for tracking AIScript actions




// Diagnostic collection for tracking errors
let diagnosticCollection: vscode.DiagnosticCollection;

function validateReferences(document: vscode.TextDocument): vscode.Diagnostic[] {

  const diagnostics: vscode.Diagnostic[] = [];

  diagnostics.push(...labelTracker.validateItems(document));
  diagnostics.push(...actionsTracker.validateItems(document));

  return diagnostics;
}

function trackScriptDocument(document: vscode.TextDocument, update: boolean = false, position?: vscode.Position): void {
  const schema = getDocumentScriptType(document);
  if (schema == '') {
    return; // Skip processing if the document is not valid
  }
  const diagnostics: vscode.Diagnostic[] = [];

  const isXMLParsed = xmlTracker.checkDocumentParsed(document);
  if (isXMLParsed && !update) {
    logger.warn(`Document ${document.uri.toString()} is already parsed.`);
    return; // Skip if the document is already parsed
  }

  const lValueTypes = ['lvalueexpression', ...xsdReference.getSimpleTypesWithBaseType(schema, 'lvalueexpression')];
  const xmlElements: XmlElement[] = xmlTracker.parseDocument(document);
  const offsets = xmlTracker.getOffsets(document);
  for (const offset of offsets) {
    const documentLine = document.lineAt(document.positionAt(offset.index).line - 1);
    const tagStart = documentLine.text.lastIndexOf('<', offset.index);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        documentLine.range.start.translate(0, tagStart),
        documentLine.range.end
      ),
      'Unclosed XML tag',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostics.push(diagnostic);
  }

  // Clear existing data for this document
  variableTracker.clearVariablesForDocument(document);
  labelTracker.clearItemsForDocument(document);
  actionsTracker.clearItemsForDocument(document);

  // Use the XML structure to find labels, actions, and variables more efficiently
  const text = document.getText();

  // Process all elements recursively
  const processElement = (element: XmlElement) => {
    const parentName = element.parent?.name || '';
    const elementDefinition = xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
    if (elementDefinition === undefined) {
      const diagnostic = new vscode.Diagnostic(
        element.range,
        `Unknown element '${element.name}' in script type '${schema}'`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = 'unknown-element';
      diagnostic.source = 'X4CodeComplete';
      diagnostics.push(diagnostic);
    } else {
      const schemaAttributes = xsdReference.getElementAttributesWithTypes(schema, element.name, element.hierarchy);
      const attributes = element.attributes
        .map((attr) => attr.name)
        .filter((name) => !(name.startsWith('xmlns:') || name.startsWith('xsi:') || name === 'xmlns'));
      // Use the static method to validate attribute names
      const nameValidation = XsdReference.validateAttributeNames(schemaAttributes, attributes);
      // Handle wrong attributes (attributes not in schema)
      if (nameValidation.wrongAttributes.length > 0) {
        nameValidation.wrongAttributes.forEach((attr) => {
          const diagnostic = new vscode.Diagnostic(
            element.range,
            `Unknown attribute '${attr}' in element '${element.name}'`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'unknown-attribute';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }
      // Process attributes for references and variables
      element.attributes.forEach((attr) => {
        if (nameValidation.missingRequiredAttributes.includes(attr.name)) {
          const diagnostic = new vscode.Diagnostic(
            attr.nameRange,
            `Missing required attribute '${attr.name}' in element '${element.name}'`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'missing-required-attribute';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic); // Skip further processing for this attribute
        } else {
          const attrDefinition = schemaAttributes.find((a) => a.name === attr.name);
          const attributeValue = text.substring(
            document.offsetAt(attr.valueRange.start),
            document.offsetAt(attr.valueRange.end)
          );
          if (!(attr.name.startsWith('xmlns:') || attr.name.startsWith('xsi:') || attr.name === 'xmlns')) {
            const valueValidation = XsdReference.validateAttributeValueAgainstRules(
              schemaAttributes,
              attr.name,
              attributeValue
            );
            if (!valueValidation.isValid) {
              const diagnostic = new vscode.Diagnostic(
                attr.valueRange,
                `Invalid value '${attributeValue}' for attribute '${attr.name}' in element '${element.name}'`,
                vscode.DiagnosticSeverity.Error
              );
              diagnostic.code = 'invalid-attribute-value';
              diagnostic.source = 'X4CodeComplete';
              diagnostics.push(diagnostic);
            }
          }

          // Check for variables inside attribute values
          const attrValue = text.substring(
            document.offsetAt(attr.valueRange.start),
            document.offsetAt(attr.valueRange.end)
          );

          const referencedItemAttributeDetected = checkReferencedItemAttributeType(element.name, attr.name);
          if (referencedItemAttributeDetected) {
            switch (referencedItemAttributeDetected.type) {
              case 'label':
                switch (referencedItemAttributeDetected.attrType) {
                  case 'definition':
                    labelTracker.addItemDefinition(attrValue, document, attr.valueRange);
                    break;
                  case 'reference':
                    labelTracker.addItemReference(attrValue, document, attr.valueRange);
                    break;
                }
                break;
              case 'actions':
                switch (referencedItemAttributeDetected.attrType) {
                  case 'definition':
                    actionsTracker.addItemDefinition(attrValue, document, attr.valueRange);
                    break;
                  case 'reference':
                    actionsTracker.addItemReference(attrValue, document, attr.valueRange);
                    break;
                }
                break;
            }
          }

          if (schema === aiScriptId && element.name === 'param' && attr.name === 'name' && element.hierarchy.length > 0 && element.hierarchy[0] === 'params') {
            variableTracker.addVariable(
              'normal',
              attrValue,
              schema,
              document,
              new vscode.Range(attr.valueRange.start, attr.valueRange.end),
              true, // isDefinition
              0
            );
          }

          const tableIsFound = tableKeyPattern.test(attrValue);
          let match: RegExpExecArray | null;
          const variablePattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
          let priority = -1;
          const isLValueAttribute: boolean = lValueTypes.includes(attrDefinition?.type || '');
          if (schema === aiScriptId && isLValueAttribute) {
            if (element.hierarchy.includes('library')) {
              priority = 10;
            } else if (element.hierarchy.includes('init')) {
              priority = 20;
            } else if (element.hierarchy.includes('patch')) {
              priority = 30;
            } else if (element.hierarchy.includes('attention')) {
              priority = 40;
            }
          }
          while ((match = variablePattern.exec(attrValue)) !== null) {
            const variableName = match[1];
            const variableStartOffset = document.offsetAt(attr.valueRange.start) + match.index;
            const variableEndOffset = variableStartOffset + match[0].length;

            const start = document.positionAt(variableStartOffset);
            const end = document.positionAt(variableEndOffset);

            // Simple version of the existing variable type detection
            const variableType = tableIsFound ? 'tableKey' : 'normal';
            const variableRange = new vscode.Range(start, end);
            if (!(position && variableRange.contains(position))) {
              if (end.isEqual(attr.valueRange.end) && priority >= 0) {
                variableTracker.addVariable(
                  variableType,
                  variableName,
                  schema,
                  document,
                  new vscode.Range(start, end),
                  true, // isDefinition
                  priority
                );
              } else {
                variableTracker.addVariable(
                  variableType,
                  variableName,
                  schema,
                  document,
                  new vscode.Range(start, end)
                );
              }
            }
          }
        }
      });
    }
  };

  // Start processing from root elements
  xmlElements.forEach(processElement);

  // Validate references after tracking is complete
  diagnostics.push(...validateReferences(document));

  // Set diagnostics for the document
  diagnosticCollection.set(document.uri, diagnostics);
  logger.info(`Document ${document.uri.toString()} tracked.`);
}


let scriptCompletionProvider : ScriptCompletion;



export function activate(context: vscode.ExtensionContext) {
  let config = vscode.workspace.getConfiguration('x4CodeComplete');
  if (!config || !validateSettings(config)) {
    return;
  }
  extensionsFolder = config.get('extensionsFolder') || '';
  if (config.get('debug') || false) {
    isDebugEnabled = true;
    setLoggerLevel('debug'); // Set logger level to debug for detailed output
  } else {
    setLoggerLevel('info'); // Set logger level to info for normal operation
  }
  logger.debug('X4CodeComplete activation started.');

  rootpath = config.get('unpackedFileLocation') || '';
  forcedCompletion = config.get('forcedCompletion') || false;

  // Create diagnostic collection
  diagnosticCollection = vscode.languages.createDiagnosticCollection('x4CodeComplete');
  context.subscriptions.push(diagnosticCollection);
  languageProcessor = new LanguageFileProcessor();
 // Load language files and wait for completion
  languageProcessor.loadLanguageFiles(rootpath, extensionsFolder)
    .then(() => {
      logger.info('Language files loaded successfully.');
      // Proceed with the rest of the activation logic
    })
    .catch((error) => {
      logger.error('Error loading language files:', error);
      vscode.window.showErrorMessage('Error loading language files: ' + error);
    });
  // Load script properties
  scriptProperties = new ScriptProperties( path.join(rootpath, '/libraries'));
  xsdReference = new XsdReference(path.join(rootpath, 'libraries'));
  scriptCompletionProvider= new ScriptCompletion(xsdReference, xmlTracker, scriptProperties, labelTracker, actionsTracker, variableTracker)

  const sel: vscode.DocumentSelector = { language: 'xml' };

  const disposableCompleteProvider = vscode.languages.registerCompletionItemProvider(
    sel,
    // completionProvider,
    scriptCompletionProvider,
    '.',
    '"',
    '{',
    ' ',
    '<'
  );
  context.subscriptions.push(disposableCompleteProvider);

  // const disposableDefinitionProvider = vscode.languages.registerDefinitionProvider(sel, scriptProperties.definitionProvider);
  // context.subscriptions.push(disposableDefinitionProvider);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(sel, {
      provideDefinition:  async (document: vscode.TextDocument, position: vscode.Position) : Promise<vscode.Definition | undefined> => {
        const scheme = getDocumentScriptType(document);
        if (scheme === '') {
          return undefined;
        }

        // Check if we're on a variable
        const variableDefinition = variableTracker.getVariableDefinition(document, position);
        if (variableDefinition) {
          logger.debug(`Variable definition found at position: ${position.line + 1}:${position.character} for variable: ${variableDefinition.name}`);
          return variableDefinition.definition;
        }

        if (scheme == aiScriptId) {
          // Check if we're on an action (only in AI scripts)
          const actionsDefinition = actionsTracker.getItemDefinition(document, position);
          if (actionsDefinition) {
            logger.debug(`Definition found for action: ${actionsDefinition.name}`);
            return actionsDefinition.definition;
          }

          // Check if we're on a label
          const labelDefinition = labelTracker.getItemDefinition(document, position);
          if (labelDefinition) {
            logger.debug(`Definition found for label: ${labelDefinition.name}`);
            return labelDefinition.definition;
          }
        }
        // Default handling for other definitions
        return scriptProperties.provideDefinition(document, position);
      }
    })
  );

  // Hover provider to display tooltips
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, {
      provideHover: async (
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.Hover | undefined> => {
        const schema = getDocumentScriptType(document);
        if (schema == '') {
          return undefined; // Skip if the document is not valid
        }

        const languageConstructsHover = languageProcessor.provideHover(document, position);
        if (languageConstructsHover) {
          return languageConstructsHover; // Return hover for language constructs
        }

        const element = xmlTracker.elementWithPosInStartTag(document, position);
        if (element) {
          const attribute = xmlTracker.attributeWithPosInName(document, position);
          if (attribute) {
              const hoverText = new vscode.MarkdownString();
              const elementAttributes: EnhancedAttributeInfo[] = xsdReference.getElementAttributesWithTypes(schema, attribute.element.name, attribute.element.hierarchy);
              const attributeInfo = elementAttributes.find((attr) => attr.name === attribute.name);
              if (attributeInfo) {
                hoverText.appendMarkdown(`**${attribute.name}**: ${attributeInfo.annotation ? '\`' + attributeInfo.annotation + '\`' : ''}\n\n`);
                hoverText.appendMarkdown(`**Type**: \`${attributeInfo.type}\`\n\n`);
                hoverText.appendMarkdown(`**Required**: \`${attributeInfo.required ? 'Yes' : 'No'}\`\n\n`);
              } else {
                hoverText.appendMarkdown(`**${attribute.name}**: \`Wrong attribute!\`\n\n`);
              }
              return new vscode.Hover(hoverText, attribute.nameRange);
          } else if (xmlTracker.elementWithPosInName(document, position)) {
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

        if (schema == aiScriptId) {
          // Check for actions (only in AI scripts)
          const actionsHover = actionsTracker.getItemHover(document, position);
          if (actionsHover) {
            return actionsHover;
          }
          // Check for labels
          const labelHover = labelTracker.getItemHover(document, position);
          if (labelHover) {
            return labelHover;
          }
        }

        const variableAtPosition = variableTracker.getVariableAtPosition(document, position);

        if (variableAtPosition) {
          logger.debug(`Hovering over variable: ${variableAtPosition.variable.name}`);
          // Generate hover text for the variable
          const hoverText = VariableTracker.getVariableDetails(variableAtPosition.variable);
          return new vscode.Hover(hoverText, variableAtPosition.location.range); // Updated to use variableAtPosition[0].range
        }

        return scriptProperties.provideHover(document, position);
      },
    })
  );

  // Update the definition provider to support actions
  // scriptProperties.definitionProvider.provideDefinition =

  logger.info('XSD schemas loaded successfully.'); // Instead of parsing all open documents, just parse the active one
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document;
    if (scriptsMetadataSet(document)) {
      trackScriptDocument(document);
    }
  }

  // Listen for editor changes to parse documents as they become active
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && scriptsMetadataSet(editor.document)) {
        trackScriptDocument(editor.document);
      }
    })
  );

  // Keep the onDidOpenTextDocument handler for newly opened documents
  vscode.workspace.onDidOpenTextDocument((document) => {
    if (scriptsMetadataSet(document)) {
      // Only parse if this is the active document
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()) {
        trackScriptDocument(document);
      }
    }
  });

  // Update XML structure when documents change
  vscode.workspace.onDidChangeTextDocument((event) => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || event.document !== activeEditor.document) return;
    if (scriptsMetadataSet(event.document, true)) {
      if (event.contentChanges.length > 0) {
        const cursorPos = activeEditor.selection.active;

        trackScriptDocument(event.document, true, cursorPos); // Update the document structure on change
        // Check if we're in a specialized completion context
        // Move the position one character forward if possible
        if (forcedCompletion && scriptCompletionProvider.prepareCompletion(event.document, cursorPos, true) !== undefined) {
          // If the completion provider is ready, trigger suggestions
          logger.info(`Triggering suggestions for document: ${event.document.uri.toString()}`);
          vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
      }
    }
  });

  vscode.workspace.onDidSaveTextDocument((document) => {
    if (scriptsMetadataSet(document, true)) {
      trackScriptDocument(document, true); // Update the document structure on save
    }
  });

  // Clear the cached languageSubId and diagnosticCollection when a document is closed
  vscode.workspace.onDidCloseTextDocument((document) => {
    diagnosticCollection.delete(document.uri);
    logger.debug(`Removed cached data for document: ${document.uri.toString()}`);
  });

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('x4CodeComplete')) {
        logger.info('Configuration changed. Reloading settings...');
        config = vscode.workspace.getConfiguration('x4CodeComplete');

        // Update settings
        rootpath = config.get('unpackedFileLocation') || '';
        forcedCompletion = config.get('forcedCompletion') || false;
        extensionsFolder = config.get('extensionsFolder') || '';
        const debugValue = config.get('debug') || false ? true : false;
        if (debugValue !== isDebugEnabled) {
          isDebugEnabled = debugValue;
          if (isDebugEnabled) {
            setLoggerLevel('debug'); // Set logger level to debug for detailed output
          } else {
            setLoggerLevel('info'); // Set logger level to info for normal operation
          }
        }

        // Reload language files if paths have changed or reloadLanguageData is toggled
        if (
          event.affectsConfiguration('x4CodeComplete.unpackedFileLocation') ||
          event.affectsConfiguration('x4CodeComplete.extensionsFolder') ||
          event.affectsConfiguration('x4CodeComplete.languageNumber') ||
          event.affectsConfiguration('x4CodeComplete.limitLanguageOutput') ||
          event.affectsConfiguration('x4CodeComplete.reloadLanguageData')
        ) {
          logger.info('Reloading language files due to configuration changes...');
          languageProcessor.loadLanguageFiles(rootpath, extensionsFolder)
            .then(() => {
              logger.info('Language files reloaded successfully.');
            })
            .catch((error) => {
              logger.info('Failed to reload language files:', error);
            });

          // Reset the reloadLanguageData flag to false after reloading
          if (event.affectsConfiguration('x4CodeComplete.reloadLanguageData')) {
            vscode.workspace
              .getConfiguration()
              .update('x4CodeComplete.reloadLanguageData', false, vscode.ConfigurationTarget.Global);
          }
        }
      }
    })
  );

  // Add code action provider for quick fixes
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(sel, {
      provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
      ): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === 'X4CodeComplete') {
            if (diagnostic.code === 'undefined-label') {
              // Quick fix to create label definition
              const labelName = diagnostic.message.match(/'(.+)'/)?.[1];
              if (labelName) {
                const similarLabels = labelTracker.getSimilarItems(document, labelName);
                similarLabels.forEach((similarLabel) => {
                  const replaceAction = new vscode.CodeAction(
                    `Replace with existing label '${similarLabel}'`,
                    vscode.CodeActionKind.QuickFix
                  );
                  replaceAction.edit = new vscode.WorkspaceEdit();
                  replaceAction.edit.replace(document.uri, diagnostic.range, similarLabel);
                  replaceAction.diagnostics = [diagnostic];
                  replaceAction.isPreferred = similarLabels.indexOf(similarLabel) === 0; // Mark most similar as preferred
                  actions.push(replaceAction);
                });
              }
            } else if (diagnostic.code === 'undefined-action') {
              // Quick fix to create action definition
              const actionName = diagnostic.message.match(/'(.+)'/)?.[1];
              if (actionName) {
                // Action to create new action
                const createAction = new vscode.CodeAction(
                  `Create action '${actionName}'`,
                  vscode.CodeActionKind.QuickFix
                );
                createAction.edit = new vscode.WorkspaceEdit();

                // Find library section or create one
                const text = document.getText();
                const libraryMatch = text.match(/<library>/);
                let insertPosition: vscode.Position;
                let insertText: string;

                if (libraryMatch) {
                  // Insert into existing library
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

                const similarActions = actionsTracker.getSimilarItems(document, actionName);

                similarActions.forEach((similarAction) => {
                  const replaceAction = new vscode.CodeAction(
                    `Replace with existing action '${similarAction}'`,
                    vscode.CodeActionKind.QuickFix
                  );
                  replaceAction.edit = new vscode.WorkspaceEdit();
                  replaceAction.edit.replace(document.uri, diagnostic.range, similarAction);
                  replaceAction.diagnostics = [diagnostic];
                  replaceAction.isPreferred = similarActions.indexOf(similarAction) === 0; // Mark most similar as preferred
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
    vscode.languages.registerReferenceProvider(sel, {
      provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext) {
        const scheme = getDocumentScriptType(document);
        if (scheme == '') {
          return undefined;
        }

        // Check if we're on a variable
        const variableReferences = variableTracker.getVariableLocations(document, position);
        if (variableReferences) {
          logger.debug(`References found for variable: ${variableReferences.name}`);
          return variableReferences.references;
        }
        if (scheme == aiScriptId) {
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

  context.subscriptions.push(
    vscode.languages.registerRenameProvider(sel, {
      provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string) {
        const scheme = getDocumentScriptType(document);
        if (scheme == '') {
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
}

// this method is called when your extension is deactivated
export function deactivate() {
  logger.info('Extension deactivation started...');

  try {

    // Clear all diagnostic collections
    if (diagnosticCollection) {
      diagnosticCollection.clear();
      diagnosticCollection.dispose();
    }

    // Clear all tracking data
    if (variableTracker) {
      // Clear all document-specific data
      // Note: WeakMap will be garbage collected automatically, but we can clear specific documents if needed
      variableTracker.dispose();
    }

    if (labelTracker) {
      // Clear all document-specific data
      // Note: WeakMap will be garbage collected automatically
      labelTracker.dispose();
    }

    if (actionsTracker) {
      // Clear all document-specific data
      // Note: WeakMap will be garbage collected automatically
      actionsTracker.dispose();
    }

    // Clear XML tracker data
    if (xmlTracker) {
      xmlTracker.dispose();
    }

    // Clear completion provider data
    if (scriptProperties) {
      scriptProperties.dispose();
    }

    // Clear script completion provider
    if (scriptCompletionProvider) {
      // Script completion provider will be garbage collected
    }


    if (languageProcessor) {
      // Clear language processor data
      languageProcessor.dispose();
    }

    // Clear scripts metadata
    if (scriptsMetadata) {
      // Note: WeakMap will be garbage collected automatically
      scriptsMetadataClearAll();
    }

    // Clear XSD reference data
    if (xsdReference) {
      // XSD reference internal caches will be garbage collected
      xsdReference.dispose();
    }

    // Reset global flags
    isDebugEnabled = false;
    forcedCompletion = false;

    logger.info('Extension deactivated successfully');
  } catch (error) {
    logger.error('Error during extension deactivation:', error);
  }
}
