import * as vscode from 'vscode';
import * as sax from 'sax';

export interface ElementRange {
  name: string;
  range: vscode.Range;
  isSelfClosing: boolean;
  parentId?: number;
  parentName?: string;
  children: number[];
  attributes: AttributeRange[];
}

export interface AttributeRange {
  name: string;
  elementName: string;
  nameRange: vscode.Range;
  valueRange: vscode.Range;
  quoteChar: string;
  elementId: number;
}

export class XmlStructureTracker {
  private documentMap: Map<string, ElementRange[]> = new Map();
  private lastParseTimestamps: Map<string, number> = new Map();

  // New method to ensure a document is parsed only when needed
  checkDocumentParsed(document: vscode.TextDocument): boolean {
    const documentUri = document.uri.toString();
    const lastModified = document.version;
    const lastParsed = this.lastParseTimestamps.get(documentUri);

    // Parse only if not parsed before or if the document has changed
    return lastParsed && lastParsed > lastModified ? true : false;
  }

  // Make this method return the parsed elements
  parseDocument(document: vscode.TextDocument): ElementRange[] {
    try {
      const text = document.getText();

      // Create a non-strict parser to be more tolerant of errors
      const parser = sax.parser(true);

      const elements: ElementRange[] = [];
      const openElementStack: number[] = [];

      // Track parse position
      parser.startTagPosition = 0;
      parser.position = 0;

      // Handle opening tags
      parser.onopentag = (node) => {
        try {
          const tagStartPos = parser.startTagPosition - 1;
          const startPos = document.positionAt(tagStartPos);

          const newElement: ElementRange = {
            name: node.name,
            range: new vscode.Range(startPos, document.positionAt(parser.position)), // Will update end position when tag is closed
            isSelfClosing: node.isSelfClosing,
            children: [],
            attributes: [],
          };

          const currentIndex = elements.length;

          // Set parent-child relationships
          if (openElementStack.length > 0) {
            const parentIndex = openElementStack[openElementStack.length - 1];
            newElement.parentId = parentIndex;
            newElement.parentName = elements[parentIndex].name;
            elements[parentIndex].children.push(currentIndex);
          }

          // Process attributes (with error handling)
          try {
            const attributesText = document.getText(newElement.range);
            for (const [attrName, attrValue] of Object.entries(node.attributes)) {
              try {
                // Find attribute name position in raw text
                const attrNameIndex = attributesText.indexOf(attrName);

                if (attrNameIndex > 0) {
                  // Find attribute value and its quotes
                  const equalsIndex = attributesText.indexOf('=', attrNameIndex + attrName.length);
                  if (equalsIndex > 0 && equalsIndex < attributesText.length - 1) {
                    const quoteChar = attributesText[equalsIndex + 1];
                    if (quoteChar === '"' || quoteChar === "'") {
                      const valueStartIndex = equalsIndex + 2; // Skip = and opening quote
                      const valueEndIndex = attributesText.indexOf(quoteChar, valueStartIndex);

                      if (valueEndIndex > 0) {
                        const attrNameStart = document.positionAt(tagStartPos + attrNameIndex);
                        const attrNameEnd = document.positionAt(tagStartPos + attrNameIndex + attrName.length);
                        const valueStart = document.positionAt(tagStartPos + valueStartIndex);
                        const valueEnd = document.positionAt(tagStartPos + valueEndIndex);

                        const attribute: AttributeRange = {
                          name: attrName,
                          elementName: newElement.name, // Store the element name for reference
                          nameRange: new vscode.Range(attrNameStart, attrNameEnd),
                          valueRange: new vscode.Range(valueStart, valueEnd),
                          quoteChar: quoteChar,
                          elementId: currentIndex,
                        };

                        newElement.attributes.push(attribute);
                      }
                    }
                  }
                }
              } catch (attrError) {
                // Skip this attribute but continue processing
                continue;
              }
            }
          } catch (attributesError) {
            // Continue even if attribute parsing fails
          }

          elements.push(newElement);

          if (!node.isSelfClosing) {
            openElementStack.push(currentIndex);
          } else {
            newElement.range = new vscode.Range(newElement.range.start, document.positionAt(parser.position));
          }
        } catch (tagError) {
          // Skip this tag but continue parsing
        }
      };

      parser.onclosetag = (tagName: string) => {
        if (openElementStack.length > 0) {
          const lastOpenIndex = openElementStack[openElementStack.length - 1];
          const lastOpenElement = elements[lastOpenIndex];
          if (lastOpenElement.name === tagName) {
            // lastOpenElement.range = new vscode.Range(lastOpenElement.range.start, document.positionAt(parser.position));
            openElementStack.pop();
          }
        }
      };

      // Handle parser errors - don't throw, just log and continue
      parser.onerror = (err) => {
        // console.error(`Ignoring XML parse error: ${err.message}`);
        parser.resume(); // Continue parsing despite errors
      };

      // Handle text nodes (for completeness)
      parser.ontext = (text) => {
        // Just continue parsing
      };

      // Ensure parser continues even when it encounters errors
      parser.write(text).close();

      // Store the parsed structure
      this.documentMap.set(document.uri.toString(), elements);
    } catch (error) {
      // Last-resort error handling - if anything fails, just continue
      // console.error(`Failed to parse document structure: ${error}`);

      // Ensure we don't leave the document without any structure
      if (!this.documentMap.has(document.uri.toString())) {
        this.documentMap.set(document.uri.toString(), []);
      }
    }
    this.lastParseTimestamps.set(document.uri.toString(), document.version);
    return this.documentMap.get(document.uri.toString()) || [];
  }

  isInAttributeValue(document: vscode.TextDocument, position: vscode.Position): AttributeRange | undefined {
    try {
      const rootElements = this.documentMap.get(document.uri.toString());
      if (!rootElements) return undefined;

      // Step 1: Find all elements containing the position
      const elementContainingPosition: ElementRange | undefined = this.isInElementRange(document, position);

      if (!elementContainingPosition) return undefined;

      // Step 2: Check attributes of element
      for (const attr of elementContainingPosition.attributes) {
        if (attr.valueRange.contains(position)) {
          return attr;
        }
      }
    } catch (error) {
      // If anything fails, return undefined
    }

    return undefined;
  }

  isInElementRange(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const rootElements = this.documentMap.get(document.uri.toString());
    if (!rootElements) return undefined;

    return rootElements.find((element) => element.range.contains(position));
  }

  clear(document: vscode.TextDocument): void {
    this.documentMap.delete(document.uri.toString());
  }

  getElements(document: vscode.TextDocument): ElementRange[] {
    return this.documentMap.get(document.uri.toString()) || [];
  }

  getParentElement(document: vscode.TextDocument, element: ElementRange): ElementRange | undefined {
    if (element.parentId === undefined) return undefined;

    const elements = this.getElements(document);
    if (element.parentId < 0 || element.parentId >= elements.length) {
      return undefined; // Parent index out of bounds
    }
    return elements[element.parentId];
  }

  isInElementByName(document: vscode.TextDocument, currentElement: ElementRange, name: string): boolean {
    if (currentElement.name === name) {
      return true;
    }

    // Check if the current element is nested within another element of the same name
    return this.getParentElement(document, currentElement) !== undefined;
  }
}
export const xmlTracker = new XmlStructureTracker();
