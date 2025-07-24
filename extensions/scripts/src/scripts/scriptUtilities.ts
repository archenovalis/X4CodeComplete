// This file contains utility functions for handling string breakouts in X4 scripting.
export const breakoutsForExpressions: string[] = [' ', "'", '"', '=', ':', ';', ',', '&', '|', '/', '!', '*', '+', '-', '?', '%', '^', '~', '`', '@'];
export const breakoutsForExpressionsBefore: string[] = ['[', '('];
export const breakoutsForExpressionsAfter: string[] = [']', ')'];

export const breakoutsForVariables: string[] = ['.'].concat(breakoutsForExpressions);
export const breakoutsForVariablesBefore: string[] = ['{'].concat(breakoutsForExpressionsBefore);
export const breakoutsForVariablesAfter: string[] = ['}'].concat(breakoutsForExpressionsAfter);

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

export function getNearestBreakSymbolIndexForVariables(text: string, before: boolean): number {
  const breakouts = before ? breakoutsForVariables.concat(breakoutsForVariablesBefore) : breakoutsForVariables.concat(breakoutsForVariablesAfter);
  return getNearestBreakSymbolIndex(text, breakouts, before);
}

export function getSubStringByBreakSymbolForVariables(text: string, before: boolean): string {
  const breakouts = before ? breakoutsForVariables.concat(breakoutsForVariablesBefore) : breakoutsForVariables.concat(breakoutsForVariablesAfter);
  return getSubStringByBreakSymbol(text, breakouts, before);
}

export function getNearestBreakSymbolIndexForExpressions(text: string, before: boolean): number {
  const breakouts = before ? breakoutsForExpressions.concat(breakoutsForExpressionsBefore) : breakoutsForExpressions.concat(breakoutsForExpressionsAfter);
  return getNearestBreakSymbolIndex(text, breakouts, before);
}

export function getSubStringByBreakSymbolForExpressions(text: string, before: boolean): string {
  const breakouts = before ? breakoutsForExpressions.concat(breakoutsForExpressionsBefore) : breakoutsForExpressions.concat(breakoutsForExpressionsAfter);
  return getSubStringByBreakSymbol(text, breakouts, before);
}
