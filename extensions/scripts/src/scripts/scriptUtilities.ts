// This file contains utility functions for handling string breakouts in X4 scripting.
export const breakoutsSymbolsCommon: string[] = [' ', '"', '=', ':', ';', ',', '&', '|', '/', '!', '*', '+', '-', '?', '%', '^', '~', '`', '@'];
export const breakoutsSymbolsCommonBefore: string[] = ['[', '('];
export const breakoutsSymbolsCommonAfter: string[] = [']', ')'];

export const breakoutsForExpressions: string[] = ['.'].concat(breakoutsSymbolsCommon);
export const breakoutsForExpressionsBefore: string[] = ['{'].concat(breakoutsSymbolsCommonBefore);
export const breakoutsForExpressionsAfter: string[] = ['}'].concat(breakoutsSymbolsCommonAfter);

const singleQuoteExclusionSet: Set<string> = new Set(['create_order.id']);

export function getNearestBreakSymbolIndex(text: string, breakouts: string[], before: boolean): number {
  const searchRange = before ? text.length - 1 : 0;
  for (let i = searchRange; i >= 0 && i < text.length; i += before ? -1 : 1) {
    if (breakouts.includes(text[i])) {
      return i;
    }
  }
  return -1;
}

export function getSubStringByBreakSymbol(text: string, breakouts: string[], before: boolean): string {
  const index = getNearestBreakSymbolIndex(text, breakouts, before);
  if (index === -1) {
    return text;
  }
  return before ? text.substring(index + 1) : text.substring(0, index);
}

export function getNearestBreakSymbolIndexForExpressions(text: string, before: boolean): number {
  const breakouts = before ? breakoutsForExpressions.concat(breakoutsForExpressionsBefore) : breakoutsForExpressions.concat(breakoutsForExpressionsAfter);
  return getNearestBreakSymbolIndex(text, breakouts, before);
}

export function getSubStringByBreakSymbolForExpressions(text: string, before: boolean): string {
  const breakouts = before ? breakoutsForExpressions.concat(breakoutsForExpressionsBefore) : breakoutsForExpressions.concat(breakoutsForExpressionsAfter);
  return getSubStringByBreakSymbol(text, breakouts, before);
}

export function getNearestBreakCommonSymbolIndex(text: string, before: boolean): number {
  const breakouts = before ? breakoutsSymbolsCommon.concat(breakoutsSymbolsCommonBefore) : breakoutsSymbolsCommon.concat(breakoutsSymbolsCommonAfter);
  return getNearestBreakSymbolIndex(text, breakouts, before);
}

export function getSubStringByBreakCommonSymbol(text: string, before: boolean): string {
  const breakouts = before ? breakoutsSymbolsCommon.concat(breakoutsSymbolsCommonBefore) : breakoutsSymbolsCommon.concat(breakoutsSymbolsCommonAfter);
  return getSubStringByBreakSymbol(text, breakouts, before);
}

/**
 * Checks if the caret is currently inside a single-quoted string on the given line.
 * Double quotes toggle a separate state and block single-quote toggling while active.
 *
 * Example:
 *   line: foo="bar" baz='qux|'
 *   caret at | -> returns true
 */
export function isInsideSingleQuotedString(line: string, caret: number): boolean {
  const upto = line.slice(0, Math.max(0, caret));
  // Count raw single quotes before the caret. If odd -> inside, if even -> outside.
  // This skips scanning non-quote chars one-by-one and avoids regex allocations.
  let count = 0;
  let idx = -1;
  while ((idx = upto.indexOf("'", idx + 1)) !== -1) {
    count++;
  }
  return (count & 1) === 1;
}

/**
 * Returns the indices [openIndex, closeIndex] of the nearest enclosing bracket pair
 * around the caret for the specified open/close characters. If caret is not inside
 * such a pair, returns an empty array.
 *
 * Logic:
 * - Scan left from caret to find the first open bracket; if it is not found or "closed" - return []
 * - Then scan right from caret to find first closing bracket; if it is not found or previously "opened" - return []
 */
export function getEnclosingBracketPairIndexes(line: string, caret: number, openChar: string, closeChar: string): number[] {
  if (!line || caret <= 0 || caret >= line.length) return [];

  let openIndex = line.lastIndexOf(openChar, caret - 1);
  let closeIndex = line.lastIndexOf(closeChar, caret - 1);
  if (openIndex === -1 || (closeIndex > 0 && openIndex < closeIndex)) return [];
  const result = [openIndex];

  openIndex = line.indexOf(openChar, caret);
  closeIndex = line.indexOf(closeChar, caret);
  if (closeIndex === -1 || (openIndex > 0 && openIndex < closeIndex)) return [];
  result.push(closeIndex);

  return result;
}

export function getEnclosingParenthesesIndexes(line: string, caret: number): number[] {
  return getEnclosingBracketPairIndexes(line, caret, '(', ')');
}
export function getEnclosingCurlyBracesIndexes(line: string, caret: number): number[] {
  return getEnclosingBracketPairIndexes(line, caret, '{', '}');
}
export function getEnclosingSquareBracketsIndexes(line: string, caret: number): number[] {
  return getEnclosingBracketPairIndexes(line, caret, '[', ']');
}
export function getEnclosingAngleBracketsIndexes(line: string, caret: number): number[] {
  return getEnclosingBracketPairIndexes(line, caret, '<', '>');
}

export function isSingleQuoteExclusion(element: string, attribute: string): boolean {
  // Exclude single-quoted strings in attributes
  if (singleQuoteExclusionSet.has([element, attribute].join('.'))) {
    return true;
  }
  return false;
}
