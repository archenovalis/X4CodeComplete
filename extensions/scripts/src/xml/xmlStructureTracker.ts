import * as vscode from 'vscode';
import { ScriptMetadata } from '../scripts/scriptsMetadata';
import { ScriptDocumentTracker } from '../scripts/scriptDocumentTracker';
import * as sax from 'sax';

export interface XmlElement {
  name: string;
  range: vscode.Range;
  startTagRange: vscode.Range; // Range of the start tag, used for attribute parsing
  nameRange: vscode.Range; // Range of just the element name within the start tag
  isSelfClosing: boolean;
  parent?: XmlElement; // Optional parent element for easier hierarchy traversal
  previous?: XmlElement; // Optional previous sibling element
  hierarchy: string[]; // Array representing the full hierarchy of parent elements
  children: XmlElement[];
  attributes: XmlElementAttribute[];
}

export interface XmlElementAttribute {
  name: string;
  value: string;
  element: XmlElement; // Reference to the element this attribute belongs to
  range: vscode.Range; // Full range of the attribute including name and value
  nameRange: vscode.Range;
  valueRange: vscode.Range;
  quoteChar: string;
  elementId: number;
}

type OffsetItem = { index: number; shift: number; type?: 'element' | 'attribute' };

function patchUnclosedTags(text: string): {
  patchedText: string;
  offsetMap: OffsetItem[];
} {
  const offsetMap: OffsetItem[] = [];
  let patchedText = text;
  let delta = 0;

  // First, patch unclosed attributes (missing closing quotes)
  const attributePatches = patchUnclosedAttributes(patchedText);
  patchedText = attributePatches.patchedText;
  offsetMap.push(...attributePatches.offsetMap);
  delta += attributePatches.offsetMap.reduce((sum, offset) => sum + offset.shift, 0);

  // Then, patch unclosed tags
  const regex = /<([a-zA-Z_][\w\-.:]*)([^<]*)/g;
  let match;

  while ((match = regex.exec(patchedText)) !== null) {
    const tagStart = match.index;
    const tagContent = match[0];
    const afterTag = patchedText.slice(tagStart + tagContent.length, tagStart + tagContent.length + 500);

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
      const insertAt = tagStart + tagContent.length;
      patchedText = patchedText.slice(0, insertAt) + '/>' + patchedText.slice(insertAt);
      const attributeDelta = revertOffset(insertAt, attributePatches.offsetMap) - insertAt;
      offsetMap.push({ index: insertAt - delta + attributeDelta, shift: 2, type: 'element' });
      delta += 2;
    }
  }

  return { patchedText, offsetMap };
}

function patchUnclosedAttributes(text: string): {
  patchedText: string;
  offsetMap: OffsetItem[];
} {
  const offsetMap: OffsetItem[] = [];
  let patchedText = text;
  let delta = 0;

  // Regex to find attribute patterns: attribute="value or attribute='value
  // This matches: word="anything or word='anything (without closing quote)
  const attributeRegex = /([A-Za-z_][A-Za-z0-9_.-]+)\s*=\s*(["])([^"]*?)(?=\s+[A-Za-z_][A-Za-z0-9_.-]+\s*=\s*["]|\/>|>|<|$)/g;
  let match;

  // Keep track of processed positions to avoid infinite loops
  const processedPositions = new Set<number>();

  while ((match = attributeRegex.exec(patchedText)) !== null) {
    const matchStart = match.index;

    // Skip if we've already processed this position
    if (processedPositions.has(matchStart)) {
      continue;
    }
    processedPositions.add(matchStart);

    const attributeName = match[1];
    const openQuote = match[2]; // " or '
    const attributeValue = match[3];
    const fullMatch = match[0];

    // Check if this attribute value is properly closed
    const expectedCloseQuote = openQuote;
    const valueStartIdx = matchStart + fullMatch.indexOf(openQuote) + 1;
    const restOfText = patchedText.slice(valueStartIdx);

    // Look for the closing quote, considering multiline values
    let closeQuoteIdx = -1;
    const searchIdx = 0;
    const inQuotes = false;

    for (let i = 0; i < restOfText.length; i++) {
      const char = restOfText[i];
      const twoChars = restOfText.slice(i, i + 2);

      if (char === expectedCloseQuote && !inQuotes) {
        closeQuoteIdx = i;
        break;
      }

      // Handle nested quotes or escaped characters
      if (char === '\\') {
        i++; // Skip next character (escaped)
        continue;
      }

      // Stop searching if we hit a new tag or attribute
      if (char === '<' || ((char === '>' || twoChars === '/>') && !inQuotes)) {
        break;
      }

      // Stop if we find what looks like a new attribute (word=)
      if (i > 0 && /\s+[A-Za-z_][A-Za-z0-9_.-]+\s*=/.test(restOfText.slice(i))) {
        break;
      }
    }

    // If no closing quote found, we need to patch it
    if (closeQuoteIdx === -1) {
      // Find where to insert the closing quote
      let insertPosition = valueStartIdx + attributeValue.length;

      // Look ahead to find a good insertion point
      const remainingText = patchedText.slice(insertPosition);

      // Try to find the end of this attribute value by looking for:
      // 1. Start of next attribute (whitespace + word + =)
      // 2. End of tag (> or />)
      // 3. Start of new tag (<)
      const nextAttrMatch = remainingText.match(/\s+[A-Za-z_][A-Za-z0-9_.-]+\s*=\s*["]/);
      const nextTagEnd = remainingText.search(/\s*\/?>/);
      const nextTagStart = remainingText.indexOf('<');

      let endPosition = remainingText.length;

      if (nextAttrMatch && nextAttrMatch.index !== undefined) {
        endPosition = Math.min(endPosition, nextAttrMatch.index);
      }
      if (nextTagEnd !== -1) {
        endPosition = Math.min(endPosition, nextTagEnd);
      }
      if (nextTagStart !== -1) {
        endPosition = Math.min(endPosition, nextTagStart);
      }

      // Trim whitespace from the end
      const valueToClose = remainingText.slice(0, endPosition);
      const trimmedLength = valueToClose.length - valueToClose.trimEnd().length;
      endPosition -= trimmedLength;

      insertPosition += endPosition;

      // Insert the missing closing quote
      patchedText = patchedText.slice(0, insertPosition) + expectedCloseQuote + patchedText.slice(insertPosition);

      offsetMap.push({
        index: insertPosition - delta,
        shift: 1,
        type: 'attribute',
      });
      delta += 1;

      // Update regex lastIndex to account for the insertion
      attributeRegex.lastIndex = insertPosition + 1;
    }
  }

  return { patchedText, offsetMap };
}

function revertOffset(patchedOffset: number, offsetMap: OffsetItem[]): number {
  let realOffset = patchedOffset;
  for (const { index, shift } of offsetMap) {
    if (patchedOffset >= index) {
      realOffset -= shift;
    }
  }
  return realOffset;
}

type Offsets = OffsetItem[];

type DocumentInfo = {
  elements: XmlElement[];
  lastParsed: number;
  offsets: Offsets;
};

export class XmlStructureTracker {
  // private documentMap: WeakMap<vscode.TextDocument, ElementRange[]> = new WeakMap();
  // private offsetsMap: WeakMap<vscode.TextDocument, OffsetItem[]> = new WeakMap();
  // private lastParseTimestamps: WeakMap<vscode.TextDocument, number> = new WeakMap();
  private documentInfoMap: WeakMap<vscode.TextDocument, DocumentInfo> = new WeakMap();

  private prepareDocumentInfo(document: vscode.TextDocument): DocumentInfo {
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
  public checkDocumentParsed(document: vscode.TextDocument, documentInfo?: DocumentInfo): boolean {
    const lastModified = document.version;
    documentInfo = documentInfo || this.documentInfoMap.get(document);
    if (!documentInfo) {
      // If no document info exists, we need to parse it
      return false;
    }
    const lastParsed = documentInfo.lastParsed;

    // Parse only if not parsed before or if the document has changed
    return !lastParsed || lastParsed !== lastModified ? false : true;
  }

  // Make this method return the parsed elements
  public parseDocument(document: vscode.TextDocument, metadata: ScriptMetadata, diagnostics: vscode.Diagnostic[]): XmlElement[] {
    let documentInfo = this.prepareDocumentInfo(document);
    if (this.checkDocumentParsed(document, documentInfo)) {
      // If the document has not changed since last parse, return cached elements
      return documentInfo.elements;
    }
    ScriptDocumentTracker.clearTrackingData(document, metadata);
    try {
      const text = document.getText();
      const { patchedText, offsetMap } = patchUnclosedTags(text);
      documentInfo.offsets = offsetMap;

      // Create a non-strict parser to be more tolerant of errors
      const parser = sax.parser(false, { lowercase: true });

      const elements: XmlElement[] = [];
      const openElementStack: XmlElement[] = [];
      let parserPositionOnOpenTag = 0;

      // Track parse position
      parser.startTagPosition = 0;
      parser.position = 0;

      // Handle opening tags
      parser.onopentag = (node) => {
        try {
          parserPositionOnOpenTag = parser.position;
          const tagStartPosPatched = parser.startTagPosition - 1;
          const tagStartPos = revertOffset(tagStartPosPatched, offsetMap);
          const tagEndPosPatched = parser.position;
          const tagEndPos = revertOffset(tagEndPosPatched, offsetMap);
          const startPos = document.positionAt(tagStartPos);

          // Calculate name range - element name starts right after '<'
          const nameStartPos = document.positionAt(tagStartPos + 1);
          const nameEndPos = document.positionAt(tagStartPos + 1 + node.name.length);

          const newElement: XmlElement = {
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
            const parent = openElementStack[openElementStack.length - 1];
            newElement.parent = parent;
            if (parent.children.length > 0) {
              newElement.previous = parent.children[parent.children.length - 1]; // Set previous sibling if exists
            }
            parent.children.push(newElement);

            // Update hierarchy
            newElement.hierarchy = [parent.name, ...parent.hierarchy];
          }

          // Process attributes (with error handling)
          try {
            const attributesText = document.getText(newElement.range);
            for (const [attrName, attrValue] of Object.entries(node.attributes)) {
              try {
                // Find attribute name position in raw text
                let attrNameIndex = attributesText.indexOf(`${attrName}="${attrValue}"`);
                let attributeText = `${attrName}="${attrValue}"`;
                if (attrNameIndex === -1 && attrValue === '') {
                  // Try to find without quotes
                  attrNameIndex = attributesText.indexOf(`${attrName}="${attrValue}`);
                  attributeText = `${attrName}="${attrValue}`;
                }
                if (attrNameIndex > 0) {
                  // Find attribute value and its quotes
                  const equalsIndex = attributeText.indexOf('=', attrName.length);
                  if (equalsIndex > 0 && equalsIndex < attributeText.length - 1) {
                    const quoteChar = attributeText[equalsIndex + 1];
                    const valueStartIndex = equalsIndex + 2; // Skip = and opening quote
                    let valueEndIndex = attributeText.indexOf(quoteChar, valueStartIndex);
                    if (valueEndIndex === -1) {
                      valueEndIndex = valueStartIndex + attrValue.length; // Fallback to end of value
                    }

                    if (valueEndIndex > 0) {
                      const attrNameStart = document.positionAt(tagStartPos + attrNameIndex);
                      const attrNameEnd = document.positionAt(tagStartPos + attrNameIndex + attrName.length);
                      const valueStart = document.positionAt(tagStartPos + attrNameIndex + valueStartIndex);
                      const valueEnd = document.positionAt(tagStartPos + attrNameIndex + valueEndIndex);
                      const attrEnd = document.positionAt(tagStartPos + attrNameIndex + attributeText.length);

                      const attribute: XmlElementAttribute = {
                        name: attrName,
                        value: attrValue,
                        element: newElement, // Reference to the element this attribute belongs to
                        range: new vscode.Range(attrNameStart, attrEnd), // Include the closing quote in the range
                        nameRange: new vscode.Range(attrNameStart, attrNameEnd),
                        valueRange: new vscode.Range(valueStart, valueEnd),
                        quoteChar: quoteChar,
                        elementId: currentIndex,
                      };

                      newElement.attributes.push(attribute);
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
          // processElement(newElement);
          ScriptDocumentTracker.processElement(newElement, document, metadata, diagnostics);
          if (!node.isSelfClosing) {
            openElementStack.push(newElement);
          }
        } catch (tagError) {
          // Skip this tag but continue parsing
        }
      };

      parser.onclosetag = (tagName: string) => {
        if (parser.position > parserPositionOnOpenTag) {
          if (openElementStack.length > 0) {
            const lastOpenElement = openElementStack[openElementStack.length - 1];
            if (lastOpenElement.name === tagName) {
              // && parser.position === document.offsetAt(lastOpenElement.range.start)
              const tagEndPosPatched = parser.position;
              const tagEndPos = revertOffset(tagEndPosPatched, offsetMap);
              lastOpenElement.range = new vscode.Range(lastOpenElement.range.start, document.positionAt(tagEndPos));
              openElementStack.pop();
            }
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
    } else {
      return documentInfo.elements;
    }
  }

  public attributeWithPosInName(document: vscode.TextDocument, position: vscode.Position, element?: XmlElement): XmlElementAttribute | undefined {
    try {
      // Step 1: Find all elements containing the position
      const elementContainingPosition: XmlElement | undefined = element || this.elementWithPosInStartTag(document, position);

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

  public attributeWithPosInValue(document: vscode.TextDocument, position: vscode.Position, element?: XmlElement): XmlElementAttribute | undefined {
    try {
      // Step 1: Find all elements containing the position
      const elementContainingPosition: XmlElement | undefined = element || this.elementWithPosInStartTag(document, position);

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

  public elementWithPosIn(document: vscode.TextDocument, position: vscode.Position): XmlElement | undefined {
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) return undefined;
    const rootElements = documentInfo.elements;
    if (!rootElements) return undefined;

    const elements = rootElements
      .filter((element) => element.range.contains(position))
      .sort((a, b) => (a.range.contains(b.range) ? 1 : a.range.isEqual(b.range) ? 0 : -1));
    return elements.length > 0 ? elements[0] : undefined;
  }

  public elementWithPosInStartTag(document: vscode.TextDocument, position: vscode.Position, element?: XmlElement): XmlElement | undefined {
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) return undefined;
    const rootElements = documentInfo.elements;
    if (!rootElements) return undefined;

    if (element) {
      // If an element is provided, check its start tag range
      if (element.startTagRange.contains(position)) {
        return element;
      }
    } else {
      return rootElements.find((element) => element.startTagRange.contains(position));
    }
  }

  public elementWithPosInName(document: vscode.TextDocument, position: vscode.Position, element?: XmlElement): XmlElement | undefined {
    const documentInfo = this.documentInfoMap.get(document);
    if (!documentInfo) return undefined;
    const rootElements = documentInfo.elements;
    if (!rootElements) return undefined;
    if (element) {
      // If an element is provided, check its name range
      if (element.nameRange.contains(position)) {
        return element;
      }
    } else {
      return rootElements.find((element) => element.nameRange.contains(position));
    }
  }

  public getOffsets(document: vscode.TextDocument): Offsets | undefined {
    return this.documentInfoMap.get(document)?.offsets;
  }

  /**
   * Clear all tracking data for all documents
   * This should be called during extension deactivation to free memory
   */
  dispose(): void {
    // WeakMaps don't have a clear method, but we can recreate them
    this.documentInfoMap = new WeakMap();
  }
}
export const xmlTracker = new XmlStructureTracker();
