const UNICODE_REPLACEMENTS: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2013': '-',
  '\u2014': '--',
  '\u2026': '...',
  '\u2022': '*',
  '\u2023': '>',
  '\u2043': '-',
  '\u00A0': ' ',
  '\u200B': '',
  '\u200C': '',
  '\u200D': '',
  '\uFEFF': '',
  '\u00B7': '.',
  '\u2219': '.',
  '\u00AB': '<<',
  '\u00BB': '>>',
  '\u2039': '<',
  '\u203A': '>',
  '\u2190': '<-',
  '\u2192': '->',
  '\u2191': '^',
  '\u2193': 'v',
  '\u2194': '<->',
  '\u2122': '(TM)',
  '\u00A9': '(c)',
  '\u00AE': '(R)',
  '\u00B0': 'deg',
  '\u00D7': 'x',
  '\u00F7': '/',
  '\u2260': '!=',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2713': '[x]',
  '\u2714': '[x]',
  '\u2715': '[!]',
  '\u2716': '[!]',
  '\u2717': '[ ]',
  '\u2718': '[ ]',
  '\u2605': '*',
  '\u2606': '*',
  '\u25CF': '*',
  '\u25CB': 'o',
  '\u25A0': '#',
  '\u25A1': '[ ]',
  '\u25B2': '^',
  '\u25BC': 'v',
  '\u25BA': '>',
  '\u25C4': '<',
  '\u2588': '#',
  '\u00BD': '1/2',
  '\u00BC': '1/4',
  '\u00BE': '3/4',
  '\u2153': '1/3',
  '\u2154': '2/3',
};

export function sanitizeText(text: string): string {
  if (!text) return text;

  let result = text;

  for (const [from, to] of Object.entries(UNICODE_REPLACEMENTS)) {
    result = result.split(from).join(to);
  }

  result = result.replace(/[\uE000-\uF8FF]/g, '');

  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  result = result.replace(/  +/g, ' ');

  return result.trim();
}

export function sanitizeForTui(text: string): string {
  if (!text) return text;

  let result = sanitizeText(text);

  result = result.replace(/[^\x20-\x7E]/g, '');

  return result;
}
