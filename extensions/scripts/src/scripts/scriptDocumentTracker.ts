import * as vscode from 'vscode';
import { XsdReference } from 'xsd-lookup';
import { XmlStructureTracker, XmlElement } from '../xml/xmlStructureTracker';
import { VariableTracker, variablePattern, tableKeyPattern } from './scriptVariables';
import { checkReferencedItemAttributeType, scriptReferencedItemsRegistry } from './scriptReferencedItems';
import { getDocumentScriptType, scriptsMetadata, aiScriptId, mdScriptId } from './scriptsMetadata';

export class ScriptDocumentTracker {
  private xmlTracker: XmlStructureTracker;
  private xsdReference: XsdReference;
  private variableTracker: VariableTracker;
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor(
    xmlTracker: XmlStructureTracker,
    xsdReference: XsdReference,
    variableTracker: VariableTracker,
    diagnosticCollection: vscode.DiagnosticCollection
  ) {
    this.xmlTracker = xmlTracker;
    this.xsdReference = xsdReference;
    this.variableTracker = variableTracker;
    this.diagnosticCollection = diagnosticCollection;
  }

  /**
   * Validates script references (labels and actions) in a document
   * @param document - The text document to validate
   * @returns Array of diagnostic issues found
   */
  private validateReferences(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];

    scriptReferencedItemsRegistry.forEach((trackerInfo, itemType) => {
      diagnostics.push(...trackerInfo.tracker.validateItems(document));
    });

    return diagnostics;
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
    const schema = getDocumentScriptType(document);
    if (schema === '') {
      return; // Skip processing if the document is not a valid script type
    }

    const diagnostics: vscode.Diagnostic[] = [];

    // Check if document is already parsed to avoid redundant work
    const isXMLParsed = this.xmlTracker.checkDocumentParsed(document);
    if (isXMLParsed && !update) {
      logger.warn(`Document ${document.uri.toString()} is already parsed.`);
      return;
    }

    // Get types that represent lvalue expressions for variable priority detection
    const lValueTypes = ['lvalueexpression', ...this.xsdReference.getSimpleTypesWithBaseType(schema, 'lvalueexpression')];

    // Parse XML structure and handle any offset issues from unclosed tags
    const xmlElements: XmlElement[] = this.xmlTracker.parseDocument(document);
    const offsets = this.xmlTracker.getOffsets(document);

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

    // Clear existing tracking data for this document before reprocessing
    this.variableTracker.clearVariablesForDocument(document);
    scriptReferencedItemsRegistry.forEach((trackerInfo, itemType) => {
      trackerInfo.tracker.clearItemsForDocument(document);
    });

    const text = document.getText();

    /**
     * Process each XML element for validation and tracking
     * This function handles:
     * - Element validation against XSD schema
     * - Attribute validation and processing
     * - Variable detection and tracking
     * - Label and action reference tracking
     */
    const processElement = (element: XmlElement) => {
      if (element.parent) {
        const parentName = element.parent?.name || '';
        const parentHierarchy = element.parent.hierarchy || [];
        const previousName = element.previous?.name || '';
        const isValidElement = this.xsdReference.isValidChild(schema, element.name, parentName, parentHierarchy, previousName);
        if (!isValidElement) {
          const diagnostic = new vscode.Diagnostic(
            element.startTagRange,
            `Invalid child element '${element.name}' in parent '${parentName}' after '${previousName}'`,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = 'invalid-child-element';
          diagnostic.source = 'X4CodeComplete';
          diagnostics.push(diagnostic);
        }
        return;
      }
      // Validate element against XSD schema
      const elementDefinition = this.xsdReference.getElementDefinition(schema, element.name, element.hierarchy);
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
        // Get valid attributes for this element from schema
        const schemaAttributes = this.xsdReference.getElementAttributesWithTypes(schema, element.name, element.hierarchy);
        const attributes = element.attributes
          .map((attr) => attr.name)
          .filter((name) => !(name.startsWith('xmlns:') || name.startsWith('xsi:') || name === 'xmlns'));

        // Validate attribute names against schema
        const nameValidation = XsdReference.validateAttributeNames(schemaAttributes, attributes);

        // Report unknown attributes
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
            const attributeValue = text.substring(document.offsetAt(attr.valueRange.start), document.offsetAt(attr.valueRange.end));

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
            const attrValue = text.substring(document.offsetAt(attr.valueRange.start), document.offsetAt(attr.valueRange.end));

            // Check if this attribute contains label or action references
            const referencedItemAttributeDetected = checkReferencedItemAttributeType(element.name, attr.name);
            if (referencedItemAttributeDetected) {
              if (scriptReferencedItemsRegistry.has(referencedItemAttributeDetected.type)) {
                const trackerInfo = scriptReferencedItemsRegistry.get(referencedItemAttributeDetected.type);
                if (trackerInfo) {
                  logger.debug(`Tracking referenced item: ${referencedItemAttributeDetected.type} - ${attrValue} in ${document.uri.toString()}`);
                  switch (referencedItemAttributeDetected.attrType) {
                    case 'definition':
                      trackerInfo.tracker.addItemDefinition(attrValue, document, attr.valueRange);
                      break;
                    case 'reference':
                      trackerInfo.tracker.addItemReference(attrValue, document, attr.valueRange);
                      break;
                  }
                } else {
                  logger.warn(`No tracker found for referenced item type: ${referencedItemAttributeDetected.type}`);
                }
              }
            }

            // Special handling for parameter definitions in AI scripts
            if (
              schema === aiScriptId &&
              element.name === 'param' &&
              attr.name === 'name' &&
              element.hierarchy.length > 0 &&
              element.hierarchy[0] === 'params'
            ) {
              this.variableTracker.addVariable(
                'normal',
                attrValue,
                schema,
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
                this.variableTracker.addVariable(
                  variableType,
                  variableName,
                  schema,
                  document,
                  variableRange,
                  true, // isDefinition
                  priority
                );
              } else {
                // This is a variable reference
                this.variableTracker.addVariable(variableType, variableName, schema, document, variableRange);
              }
            }
          }
        });
      }
    };

    // Process all XML elements in the document
    xmlElements.forEach(processElement);

    // Validate all references after processing is complete
    diagnostics.push(...this.validateReferences(document));

    // Update diagnostics for the document
    this.diagnosticCollection.set(document.uri, diagnostics);
    logger.debug(`Document ${document.uri.toString()} ${update === true ? 're-' : ''}tracked.`);
  }

  dispose(): void {}
}
