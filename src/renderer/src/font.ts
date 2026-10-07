// Terminal font, chosen in the View menu and remembered per user (localStorage).

export interface TermFont {
  family: string
  size: number
}

export const DEFAULT_FONT: TermFont = { family: 'Menlo', size: 13 }
export const FONT_MIN = 9
export const FONT_MAX = 28
export const FONT_FAMILIES = ['Menlo', 'SF Mono', 'Monaco', 'Courier New', 'Andale Mono']
export const clampFontSize = (n: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))

/** CSS font-family with fallbacks, for a name the user typed. */
export const fontStack = (family: string): string => `"${family.replace(/"/g, '')}", Menlo, monospace`
