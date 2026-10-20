export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Build number, or 'NEXT' / 'LATEST' placeholders. */
  build: number | 'NEXT' | 'LATEST';
}

export function parseVersion(text: string | undefined): ParsedVersion | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+|NEXT|LATEST))?$/.exec((text ?? '').trim());
  if (!m) {
    return undefined;
  }
  const b = m[4];
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    build: b === undefined || b === 'NEXT' ? 'NEXT' : b === 'LATEST' ? 'LATEST' : Number(b)
  };
}

/** Compares major.minor.patch only (build numbers are assigned by Salesforce). */
export function compareMmp(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export const mmp = (v: ParsedVersion): string => `${v.major}.${v.minor}.${v.patch}`;
