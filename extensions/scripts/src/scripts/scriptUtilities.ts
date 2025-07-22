

export const breakoutsForVariables : string[] = [' ', '.', '[', ']', '{', '}', '(', ')', "'", '"', '=', ':', ';', ',', '&', '|', '/', '!', '*', '+', '-', '?', '%', '^', '~', '`'];

export const breakoutsForExpressions : string[] = [' ', '[', ']', '(', ')', "'", '"', '=', ':', ';', ',', '&', '|', '/', '!', '*', '+', '-', '?', '%', '^', '~', '`'];

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
  return before ? text.substring(0, index) : text.substring(index + 1);
}

export function getNearestBreakSymbolIndexForVariables(text: string, before: boolean): number {
  return getNearestBreakSymbolIndex(text, breakoutsForVariables, before);
}

export function getSubStringByBreakSymbolForVariables(text: string, before: boolean): string {
  return getSubStringByBreakSymbol(text, breakoutsForVariables, before);
}

export function getNearestBreakSymbolIndexForExpressions(text: string, before: boolean): number {
  return getNearestBreakSymbolIndex(text, breakoutsForExpressions, before);
}

export function getSubStringByBreakSymbolForExpressions(text: string, before: boolean): string {
  return getSubStringByBreakSymbol(text, breakoutsForExpressions, before);
}
