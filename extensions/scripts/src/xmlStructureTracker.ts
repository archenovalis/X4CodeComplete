import * as vscode from 'vscode';
import * as sax from 'sax';
import { off } from 'process';

export interface ElementRange {
  name: string;
  range: vscode.Range;
  startTagRange: vscode.Range; // Range of the start tag, used for attribute parsing
  nameRange: vscode.Range; // Range of just the element name within the start tag
  isSelfClosing: boolean;
  parentId?: number;
  parentName?: string;
  hierarchy: string[]; // Array representing the full hierarchy of parent elements
  children: number[];
  attributes: AttributeRange[];
}

export interface AttributeRange {
  name: string;
  elementName: string;
  parentName: string;
  hierarchy: string[];
  nameRange: vscode.Range;
  valueRange: vscode.Range;
  quoteChar: string;
  elementId: number;
}

function patchUnclosedTags(text: string): {
  patchedText: string;
  offsetMap: { index: number; shift: number }[];
} {
  const offsetMap: { index: number; shift: number }[] = [];
  let patchedText = text;
  let delta = 0;

  // Find potential open tags that are never closed
  const regex = /<([a-zA-Z_][\w\-.:]*)([^<]*)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const tagStart = match.index;
    const tagContent = match[0];
    const afterTag = text.slice(tagStart + tagContent.length, tagStart + tagContent.length + 500);

    // Skip if it already has a proper closing bracket `>` before any new tag starts
    const closingBracket = tagContent.indexOf('>');
    if (closingBracket !== -1) continue;

    // Check if it's already self-closing
    if (tagContent.includes('/>')) continue;

    // Check if `>` comes before next `<`
    const nextAngle = afterTag.indexOf('<');
    const nextClose = afterTag.indexOf('>');

    if (nextClose === -1 || (nextAngle !== -1 && nextAngle < nextClose)) {
      // It's an unclosed tag. Patch with `/>` just before the next tag or end of match.
      const insertAt = tagStart + tagContent.length + delta;
      patchedText =
        patchedText.slice(0, insertAt) + '/>' + patchedText.slice(insertAt);
      offsetMap.push({ index: insertAt, shift: 2 });
      delta += 2;
    }
  }

  return { patchedText, offsetMap };
}


function revertOffset(patchedOffset: number, offsetMap: { index: number; shift: number }[]): number {
  let realOffset = patchedOffset;
  for (const { index, shift } of offsetMap) {
    if (patchedOffset >= index) {
      realOffset -= shift;
    }
  }
  return realOffset;
}

type OffsetItem = { index: number; shift: number };
type DocumentInfo = {
  elements: ElementRange[];
  lastParsed: number;
  offsets: OffsetItem[];
};

export class XmlStructureTracker {
  // private documentMap: WeakMap<vscode.TextDocument, ElementRange[]> = new WeakMap();
  // private offsetsMap: WeakMap<vscode.TextDocument, OffsetItem[]> = new WeakMap();
  // private lastParseTimestamps: WeakMap<vscode.TextDocument, number> = new WeakMap();
  private documentInfoMap: WeakMap<vscode.TextDocument, DocumentInfo> = new WeakMap();

  prepareDocumentInfo(document: vscode.TextDocument): DocumentInfo  {
    let documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) {
      // If no document info exists, create a new one
      documentInfo = {
        elements: [],
        lastParsed: 0,
        offsets: [],
      };
      this.documentInfoMap.set(document, documentInfo);
    }
    return documentInfo;
  }

  // New method to ensure a document is parsed only when needed
  checkDocumentParsed(document: vscode.TextDocument): boolean {
    const lastModified = document.version;
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) {
      // If no document info exists, we need to parse it
      return false;
    }
    const lastParsed = documentInfo.lastParsed;

    // Parse only if not parsed before or if the document has changed
    return lastParsed && lastParsed > lastModified ? true : false;
  }

  // Make this method return the parsed elements
  parseDocument(document: vscode.TextDocument): ElementRange[] {
    let documentInfo = this.prepareDocumentInfo(document);
    if (document.version === documentInfo.lastParsed) {
      // If the document has not changed since last parse, return cached elements
      return documentInfo.elements;
    }
    try {
      const text = document.getText();
      const { patchedText, offsetMap } = patchUnclosedTags(text);
      documentInfo.offsets = offsetMap;

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
          const tagStartPosPatched = parser.startTagPosition - 1;
          const tagStartPos = revertOffset(tagStartPosPatched, offsetMap);
          const tagEndPosPatched = parser.position;
          const tagEndPos = revertOffset(tagEndPosPatched, offsetMap);
          const startPos = document.positionAt(tagStartPos);

          // Calculate name range - element name starts right after '<'
          const nameStartPos = document.positionAt(tagStartPos + 1);
          const nameEndPos = document.positionAt(tagStartPos + 1 + node.name.length);

          const newElement: ElementRange = {
            name: node.name,
            range: new vscode.Range(startPos, document.positionAt(tagEndPos)), // Will update end position when tag is closed
            startTagRange: new vscode.Range(startPos, document.positionAt(tagEndPos)),
            nameRange: new vscode.Range(nameStartPos, nameEndPos),
            isSelfClosing: node.isSelfClosing,
            children: [],
            attributes: [],
            hierarchy: [], // Initialize hierarchy
          };

          const currentIndex = elements.length;

          // Set parent-child relationships
          if (openElementStack.length > 0) {
            const parentIndex = openElementStack[openElementStack.length - 1];
            newElement.parentId = parentIndex;
            newElement.parentName = elements[parentIndex].name;
            elements[parentIndex].children.push(currentIndex);

            // Update hierarchy
            newElement.hierarchy = [elements[parentIndex].name, ...elements[parentIndex].hierarchy];
          }

          // Process attributes (with error handling)
          try {
            const attributesText = document.getText(newElement.range);
            for (const [attrName, attrValue] of Object.entries(node.attributes)) {
              try {
                // Find attribute name position in raw text
                const attrNameIndex = attributesText.indexOf(`${attrName}="${attrValue}"`);
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
                          parentName: newElement.parentName || '', // Store the parent name for reference
                          hierarchy: newElement.hierarchy, // Use the hierarchy from the element
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
            const tagEndPos = revertOffset(tagEndPosPatched, offsetMap);
            newElement.range = new vscode.Range(newElement.range.start, document.positionAt(tagEndPos));
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
            lastOpenElement.range = new vscode.Range(lastOpenElement.range.start, document.positionAt(parser.position));
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
      parser.write(patchedText).close();

      // Store the parsed structure
      documentInfo.elements = elements;
      documentInfo.lastParsed = document.version;
    } catch (error) {
      // Last-resort error handling - if anything fails, just continue
      // console.error(`Failed to parse document structure: ${error}`);

      documentInfo = undefined;
    }
    if (documentInfo === undefined) {
      this.documentInfoMap.delete(document);
      return [];
    }
    else {
      return documentInfo.elements;
    }
  }

  isInAttributeName(document: vscode.TextDocument, position: vscode.Position): AttributeRange | undefined {
    try {

      // Step 1: Find all elements containing the position
      const elementContainingPosition: ElementRange | undefined = this.elementStartTagInPosition(document, position);

      if (!elementContainingPosition) return undefined;

      // Step 2: Check attributes of element
      for (const attr of elementContainingPosition.attributes) {
        if (attr.nameRange.contains(position)) {
          return attr;
        }
      }
    } catch (error) {
      // If anything fails, return undefined
    }

    return undefined;
  }

  isInAttributeValue(document: vscode.TextDocument, position: vscode.Position): AttributeRange | undefined {
    try {

      // Step 1: Find all elements containing the position
      const elementContainingPosition: ElementRange | undefined = this.elementStartTagInPosition(document, position);

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

  elementInPosition(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) return undefined;
    const rootElements = documentInfo.elements;
    if (!rootElements) return undefined;

    const elements = rootElements.filter((element) => element.range.contains(position)).sort((a, b) => a.range.contains(b.range) ? 1 : a.range.isEqual(b.range) ? 0 : -1);
    return elements.length > 0 ? elements[0] : undefined;
  }

  elementStartTagInPosition(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) return undefined;
    const rootElements = documentInfo.elements;
    if (!rootElements) return undefined;

    return rootElements.find((element) => element.startTagRange.contains(position));
  }

  elementNameInPosition(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) return undefined;
    const rootElements = documentInfo.elements;
    if (!rootElements) return undefined;

    return rootElements.find((element) => element.nameRange.contains(position));
  }

  getOffsets(document: vscode.TextDocument): { index: number; shift: number }[]  {
    return this.documentInfoMap.get(document)?.offsets || [];
  }

  getElements(document: vscode.TextDocument): ElementRange[] {
    return this.documentInfoMap.get(document)?.elements || [];
  }

  getParentElement(document: vscode.TextDocument, element: ElementRange): ElementRange | undefined {
    if (element.parentId === undefined) return undefined;

    const elements = this.getElements(document);
    if (element.parentId < 0 || element.parentId >= elements.length) {
      return undefined; // Parent index out of bounds
    }
    return elements[element.parentId];
  }
}
export const xmlTracker = new XmlStructureTracker();
