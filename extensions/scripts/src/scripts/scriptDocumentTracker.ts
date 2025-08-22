import * as vscode from 'vscode';
import { xsdReference, XsdReference } from 'xsd-lookup';
import { diagnosticCollection, lValueTypes } from '../extension/shared';
import { xmlTracker, XmlElement } from '../xml/xmlStructureTracker';
import { variableTracker, VariableTracker, variablePattern, tableKeyPattern } from './scriptVariables';
import { checkReferencedItemAttributeType, scriptReferencedItemsRegistry } from './scriptReferencedItems';
import { getDocumentScriptType, getDocumentMetadata, scriptsMetadataUpdateName, aiScriptSchema, mdScriptSchema, ScriptMetadata } from './scriptsMetadata';

export class ScriptDocumentTracker {
  constructor() {
    return;
  }

  public init(): void {
    // Initialization logic for the script document tracker
    diagnosticCollection.clear();
  }

  /**
   * Validates script references (labels and actions) in a document
   * @param document - The text document to validate
   * @returns Array of diagnostic issues found
   */
  private validateReferences(document: vscode.TextDocument): vscode.Diagnostic[] {
    const schema = getDocumentScriptType(document);
    const diagnostics: vscode.Diagnostic[] = [];

    scriptReferencedItemsRegistry.forEach((trackerInfo, itemType) => {
      if (trackerInfo.tracker.schema === schema) {
        diagnostics.push(...trackerInfo.tracker.validateItems(document));
      }
    });

    return diagnostics;
  }

  public static processElement(element: XmlElement, document: vscode.TextDocument, metadata: ScriptMetadata, diagnostics: vscode.Diagnostic[]) {
    if (element.parent) {
      const parentName = element.parent?.name || '';
      const parentHierarchy = element.parent.hierarchy || [];
      const previousName = element.previous?.name || '';
      const isValidElement = xsdReference.isValidChild(metadata.schema, element.name, parentName, parentHierarchy, previousName);
      if (!isValidElement) {
        const diagnostic = new vscode.Diagnostic(
          element.startTagRange,
          `Invalid child element '${element.name}' in parent '${parentName}' after '${previousName}'`,
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.code = 'invalid-child-element';
        diagnostic.source = 'X4CodeComplete';
        diagnostics.push(diagnostic);
        return;
      }
    }
    if ((metadata.schema === aiScriptSchema && element.name === 'aiscript') || (metadata.schema === mdScriptSchema && element.name === 'mdscript')) {
      const nameOfScript = element.attributes.find((attr) => attr.name === 'name')?.value || '';
      if (metadata.name !== nameOfScript) {
        metadata.name = nameOfScript;
        scriptsMetadataUpdateName(document, metadata.name);
      }
    }
    // Validate element against XSD schema
    const elementDefinition = xsdReference.getElementDefinition(metadata.schema, element.name, element.hierarchy);
    if (elementDefinition === undefined) {
      const diagnostic = new vscode.Diagnostic(
        element.range,
        `Unknown element '${element.name}' in script type '${metadata.schema}'`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = 'unknown-element';
      diagnostic.source = 'X4CodeComplete';
      diagnostics.push(diagnostic);
    } else {
      // Get valid attributes for this element from schema
      const schemaAttributes = xsdReference.getElementAttributesWithTypes(metadata.schema, element.name, element.hierarchy);
      const attributes = element.attributes
        .map((attr) => attr.name)
        .filter((name) => !(name.startsWith('xmlns:') || name.startsWith('xsi:') || name === 'xmlns'));

      // Validate attribute names against schema
      const nameValidation = XsdReference.validateAttributeNames(schemaAttributes, attributes);

      // Report unknown attributes
      if (nameValidation.wrongAttributes.length > 0) {
        nameValidation.wrongAttributes.forEach((attr) => {
          const diagnostic = new vscode.Diagnostic(element.range, `Unknown attribute '${attr}' in element '${element.name}'`, vscode.DiagnosticSeverity.Error);
          diagnostic.code = 'unknown-attribute';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        });
      }

      // Process each attribute for validation and tracking
      element.attributes.forEach((attr) => {
        // Check for missing required attributes
        if (nameValidation.missingRequiredAttributes.includes(attr.name)) {
          const diagnostic = new vscode.Diagnostic(
            attr.nameRange,
            `Missing required attribute '${attr.name}' in element '${element.name}'`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'missing-required-attribute';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        } else {
          const attrDefinition = schemaAttributes.find((a) => a.name === attr.name);
          const attributeValue = attr.value || '';
          const attrType = attrDefinition ? attrDefinition.type : 'unknown';

          // Validate attribute values (skip XML namespace attributes)
          if (!(attr.name.startsWith('xmlns:') || attr.name.startsWith('xsi:') || attr.name === 'xmlns')) {
            const valueValidation = XsdReference.validateAttributeValueAgainstRules(schemaAttributes, attr.name, attributeValue);
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

          // Extract attribute value for further processing
          const attrValue = attr.value || '';

          // Check if this attribute contains label or action references
          const referencedItemAttributeDetected = checkReferencedItemAttributeType(metadata.schema, element, attr.name, attrType);
          if (referencedItemAttributeDetected) {
            if (scriptReferencedItemsRegistry.has(referencedItemAttributeDetected.type)) {
              const trackerInfo = scriptReferencedItemsRegistry.get(referencedItemAttributeDetected.type);
              if (trackerInfo) {
                logger.debug(`Tracking referenced item: ${referencedItemAttributeDetected.type} - ${attrValue} in ${document.uri.toString()}`);
                const value = attrValue.startsWith('@') ? attrValue.substring(1) : attrValue;
                if (!value.includes('$')) {
                  switch (referencedItemAttributeDetected.class) {
                    case 'definition':
                      trackerInfo.tracker.addItemDefinition(metadata, value, document, attr.valueRange);
                      break;
                    case 'reference':
                      trackerInfo.tracker.addItemReference(metadata, value, document, attr.valueRange);
                      break;
                  }
                }
              } else {
                logger.warn(`No tracker found for referenced item type: ${referencedItemAttributeDetected.type}`);
              }
            }
          }

          // Special handling for parameter definitions in AI scripts
          if (
            metadata.schema === aiScriptSchema &&
            element.name === 'param' &&
            attr.name === 'name' &&
            element.hierarchy.length > 0 &&
            element.hierarchy[0] === 'params'
          ) {
            variableTracker.addVariable(
              'normal',
              attrValue,
              metadata.schema,
              document,
              new vscode.Range(attr.valueRange.start, attr.valueRange.end),
              true, // isDefinition
              0
            );
          }

          // Process variables within attribute values
          const tableIsFound = tableKeyPattern.test(attrValue);
          let match: RegExpExecArray | null;
          let priority = -1;

          // Determine variable definition priority based on script section
          const isLValueAttribute: boolean = lValueTypes.includes(attrDefinition?.type || '');
          if (metadata.schema === aiScriptSchema && isLValueAttribute) {
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

          // Find and track all variables in the attribute value
          while ((match = variablePattern.exec(attrValue)) !== null) {
            const variableName = match[1];
            const variableStartOffset = document.offsetAt(attr.valueRange.start) + match.index;
            const variableEndOffset = variableStartOffset + match[0].length;

            const start = document.positionAt(variableStartOffset);
            const end = document.positionAt(variableEndOffset);

            // Determine variable type (normal or table key)
            let variableType = tableIsFound ? 'tableKey' : 'normal';
            if (!tableIsFound && match.index > 0 && attrValue[match.index - 1] === '.') {
              variableType = 'tableKey';
              // !TODO: handle real MD remote variables
            }
            const variableRange = new vscode.Range(start, end);

            if (end.isEqual(attr.valueRange.end) && priority >= 0) {
              // This is a variable definition
              variableTracker.addVariable(
                variableType,
                variableName,
                metadata.schema,
                document,
                variableRange,
                true, // isDefinition
                priority
              );
            } else {
              // This is a variable reference
              variableTracker.addVariable(variableType, variableName, metadata.schema, document, variableRange);
            }
          }
        }
      });
    }
  }

  public static clearTrackingData(document: vscode.TextDocument, metadata: ScriptMetadata): void {
    variableTracker.clearVariablesForDocument(document);
    scriptReferencedItemsRegistry.forEach((trackerInfo, itemType) => {
      if (trackerInfo.tracker.schema === metadata.schema) {
        trackerInfo.tracker.clearItemsForDocument(document);
      }
    });
  }

  /**
   * Main function to track and analyze script documents
   * Performs XML parsing, element validation, variable tracking, and diagnostic generation
   *
   * @param document - The text document to track
   * @param update - Whether this is an update to existing tracking data
   * @param position - Optional cursor position for context-aware analysis
   */
  public trackScriptDocument(document: vscode.TextDocument, update: boolean = false, position?: vscode.Position): void {
    // Get the script schema type (aiscript, mdscript, etc.)
    const metadata = getDocumentMetadata(document);
    if (!metadata || !metadata.schema) {
      return; // Skip processing if the document is not a valid script type
    }
    const diagnostics: vscode.Diagnostic[] = [];
    /**
     * Process each XML element for validation and tracking
     * This function handles:
     * - Element validation against XSD schema
     * - Attribute validation and processing
     * - Variable detection and tracking
     * - Label and action reference tracking
     */

    // Check if document is already parsed to avoid redundant work
    const isXMLParsed = xmlTracker.checkDocumentParsed(document);
    if (isXMLParsed) {
      logger.debug(`Document ${document.uri.toString()} is already parsed.`);
      return;
    }

    // Parse XML structure and handle any offset issues from unclosed tags
    xmlTracker.parseDocument(document, metadata, diagnostics);
    const offsets = xmlTracker.getOffsets(document);

    // Create diagnostics for unclosed XML tags
    for (const offset of offsets) {
      if (offset.type === 'element') {
        const documentLine = document.lineAt(document.positionAt(offset.index).line);
        const tagStart = documentLine.text.lastIndexOf('<', offset.index);
        if (tagStart !== -1) {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(documentLine.range.start.translate(0, tagStart), documentLine.range.end),
            'Unclosed XML tag',
            vscode.DiagnosticSeverity.Warning
          );
          diagnostics.push(diagnostic);
        }
      } else if (offset.type === 'attribute') {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(document.positionAt(offset.index), document.positionAt(offset.index)),
          'Error in attribute',
          vscode.DiagnosticSeverity.Warning
        );
        diagnostics.push(diagnostic);
      }
    }

    // Validate all references after processing is complete
    diagnostics.push(...this.validateReferences(document));

    // Update diagnostics for the document
    diagnosticCollection.set(document.uri, diagnostics);
    logger.debug(`Document ${document.uri.toString()} ${update === true ? 're-' : ''}tracked.`);
  }

  dispose(): void {}
}

export const scriptDocumentTracker: ScriptDocumentTracker = new ScriptDocumentTracker();
