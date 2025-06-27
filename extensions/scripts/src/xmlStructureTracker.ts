import * as vscode from 'vscode';
import * as sax from 'sax';

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


export class XmlStructureTracker {
  private documentMap: Map<string, ElementRange[]> = new Map();
  private offsetsMap: Map<string, { index: number; shift: number }[]> = new Map();
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

      const documentUri = document.uri.toString();
      const { patchedText, offsetMap } = patchUnclosedTags(text);
      this.offsetsMap.set(documentUri, offsetMap);

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


  // parseDocument(document: vscode.TextDocument): ElementRange[] {
  //   const documentUri = document.uri.toString();
  //   const text = document.getText();
  //   const elements: ElementRange[] = [];
  //   const openElementStack: number[] = [];
  //   const { patchedText, offsetMap } = patchUnclosedTags(text);
  //   this.offsetsMap.set(documentUri, offsetMap);

  //   const parser = new Parser(
  //     {
  //       onopentag(name, attributes) {
  //         const tagStartOffsetPatched = parser.startIndex ?? 0;
  //         const tagStartOffset = revertOffset(tagStartOffsetPatched, offsetMap);
  //         const tagEndOffsetPatched = parser.endIndex ?? tagStartOffset + name.length;
  //         const tagEndOffset = revertOffset(tagEndOffsetPatched, offsetMap);

  //         const tagRawText = patchedText.slice(tagStartOffsetPatched, tagEndOffsetPatched + 1);
  //         const isSelfClosing = tagRawText.includes('/>');

  //         const startPos = document.positionAt(tagStartOffset);
  //         const endPos = document.positionAt(tagEndOffset + 1);

  //         const nameStartOffset = tagStartOffset + 1;
  //         const nameStart = document.positionAt(nameStartOffset);
  //         const nameEnd = document.positionAt(nameStartOffset + name.length);

  //         const newElement: ElementRange = {
  //           name,
  //           range: new vscode.Range(startPos, endPos),
  //           startTagRange: new vscode.Range(startPos, endPos),
  //           nameRange: new vscode.Range(nameStart, nameEnd),
  //           isSelfClosing,
  //           children: [],
  //           attributes: [],
  //           hierarchy: [],
  //         };

  //         const currentIndex = elements.length;

  //         if (openElementStack.length > 0) {
  //           const parentIndex = openElementStack[openElementStack.length - 1];
  //           newElement.parentId = parentIndex;
  //           newElement.parentName = elements[parentIndex].name;
  //           newElement.hierarchy = [elements[parentIndex].name, ...elements[parentIndex].hierarchy];
  //           elements[parentIndex].children.push(currentIndex);
  //         }

  //         // Parse attributes using raw tag text
  //         for (const [attrName, attrValue] of Object.entries(attributes)) {
  //           const attrPattern = new RegExp(`${attrName}\\s*=\\s*(['"])(.*?)\\1`);
  //           const match = attrPattern.exec(tagRawText);

  //           if (match) {
  //             const attrStartInTag = match.index;
  //             const valueStartInTag = tagRawText.indexOf(match[2], attrStartInTag);
  //             const valueEndInTag = valueStartInTag + match[2].length;

  //             const attrNameStart = document.positionAt(tagStartOffset + attrStartInTag);
  //             const attrNameEnd = document.positionAt(tagStartOffset + attrStartInTag + attrName.length);
  //             const valueStart = document.positionAt(tagStartOffset + valueStartInTag);
  //             const valueEnd = document.positionAt(tagStartOffset + valueEndInTag);

  //             newElement.attributes.push({
  //               name: attrName,
  //               elementName: name,
  //               parentName: newElement.parentName || '',
  //               hierarchy: newElement.hierarchy,
  //               nameRange: new vscode.Range(attrNameStart, attrNameEnd),
  //               valueRange: new vscode.Range(valueStart, valueEnd),
  //               quoteChar: match[1],
  //               elementId: currentIndex,
  //             });
  //           }
  //         }

  //         elements.push(newElement);

  //         if (!isSelfClosing) {
  //           openElementStack.push(currentIndex);
  //         }
  //       },

  //       onclosetag(name) {
  //         // Find the last matching open tag
  //         for (let i = openElementStack.length - 1; i >= 0; i--) {
  //           const elIndex = openElementStack[i];
  //           const el = elements[elIndex];
  //           if (el.name === name) {
  //             const tagEndOffset = revertOffset(parser.endIndex ?? 0, offsetMap);
  //             el.range = new vscode.Range(el.range.start, document.positionAt(tagEndOffset + 1));
  //             // el.startTagRange = new vscode.Range(el.range.start, document.positionAt(tagEndOffset + 1));

  //             // Remove this and anything after it from the stack
  //             openElementStack.splice(i);
  //             return;
  //           }
  //         }

  //         // If no matching open tag found, ignore (invalid close)
  //       }
  //       ,

  //       onerror(err) {
  //         console.warn('HTMLParser2 error:', err.message);
  //       },

  //       ontext(_text) {
  //         // Ignored here but could be used for content ranges
  //       }
  //     },
  //     {
  //       xmlMode: true,
  //       recognizeSelfClosing: true
  //     }
  //   );

  //   try {
  //     parser.write(patchedText);
  //   } catch (e) {
  //     console.warn("Failed to parse XML:", e);
  //   }

  //   this.documentMap.set(documentUri, elements);
  //   this.lastParseTimestamps.set(documentUri, document.version);
  //   return elements;
  // }


  isInAttributeName(document: vscode.TextDocument, position: vscode.Position): AttributeRange | undefined {
    try {
      const rootElements = this.documentMap.get(document.uri.toString());
      if (!rootElements) return undefined;

      // Step 1: Find all elements containing the position
      const elementContainingPosition: ElementRange | undefined = this.isInElementStartTag(document, position);

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
      const rootElements = this.documentMap.get(document.uri.toString());
      if (!rootElements) return undefined;

      // Step 1: Find all elements containing the position
      const elementContainingPosition: ElementRange | undefined = this.isInElementStartTag(document, position);

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

  isInElement(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const rootElements = this.documentMap.get(document.uri.toString());
    if (!rootElements) return undefined;

    const elements = rootElements.filter((element) => element.range.contains(position)).sort((a, b) => a.range.contains(b.range) ? 1 : a.range.isEqual(b.range) ? 0 : -1);
    return elements.length > 0 ? elements[0] : undefined;
  }

  isInElementStartTag(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const rootElements = this.documentMap.get(document.uri.toString());
    if (!rootElements) return undefined;

    return rootElements.find((element) => element.startTagRange.contains(position));
  }

  isInElementName(document: vscode.TextDocument, position: vscode.Position): ElementRange | undefined {
    const rootElements = this.documentMap.get(document.uri.toString());
    if (!rootElements) return undefined;

    return rootElements.find((element) => element.nameRange.contains(position));
  }

  clear(document: vscode.TextDocument): void {
    this.documentMap.delete(document.uri.toString());
  }

  getOffsets(document: vscode.TextDocument): { index: number; shift: number }[]  {
    return this.offsetsMap.get(document.uri.toString()) || [];
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
