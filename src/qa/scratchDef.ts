import * as fs from 'fs';
import * as path from 'path';

export interface DefCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface ScratchDefinition {
  file: string;
  json?: Record<string, unknown>;
  checks: DefCheck[];
  ok: boolean;
}

const EDITIONS = ['developer', 'enterprise', 'group', 'professional', 'partner developer', 'partner enterprise', 'partner group', 'partner professional'];
const FEATURE_RE = /^[A-Za-z0-9_.:;-]{1,120}$/;

/** Resolves a project-relative path and refuses anything outside the project root. */
export function resolveInside(root: string, rel: string): string | undefined {
  if (!rel || /[\0\r\n]/.test(rel)) {
    return undefined;
  }
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : undefined;
}

export function validateScratchDefinition(root: string, rel: string): ScratchDefinition {
  const checks: DefCheck[] = [];
  const add = (name: string, status: DefCheck['status'], detail: string) => checks.push({ name, status, detail });
  const file = resolveInside(root, rel);
  if (!file) {
    add('Definition file', 'fail', `"${rel}" is not a valid path inside the project.`);
    return { file: rel, checks, ok: false };
  }
  if (!fs.existsSync(file)) {
    add('Definition file', 'fail', `${rel} does not exist.`);
    return { file, checks, ok: false };
  }
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be an object');
    }
    json = parsed as Record<string, unknown>;
  } catch (e) {
    add('Definition file', 'fail', `${rel} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return { file, checks, ok: false };
  }
  add('Definition file', 'pass', `${rel} parsed.`);

  const usesBase = typeof json.snapshot === 'string' || typeof json.sourceOrg === 'string';
  const edition = typeof json.edition === 'string' ? json.edition : undefined;
  if (usesBase) {
    add('Edition', 'pass', 'Org is created from a snapshot or source org.');
  } else if (!edition) {
    add('Edition', 'fail', 'No "edition" is defined.');
  } else if (!EDITIONS.includes(edition.trim().toLowerCase())) {
    add('Edition', 'fail', `Unknown edition "${edition}".`);
  } else {
    add('Edition', 'pass', edition);
  }

  if (json.features !== undefined) {
    if (!Array.isArray(json.features) || json.features.some(f => typeof f !== 'string' || !FEATURE_RE.test(f))) {
      add('Features', 'fail', '"features" must be an array of feature names.');
    } else {
      const dupes = json.features.filter((f, i, a) => a.indexOf(f) !== i);
      add('Features', dupes.length ? 'warn' : 'pass', dupes.length ? `Duplicate features: ${[...new Set(dupes)].join(', ')}` : `${json.features.length} feature(s) declared.`);
    }
  } else {
    add('Features', 'warn', 'No features declared. If the package needs org features (e.g. Communities, MultiCurrency), installation will fail.');
  }
  if (json.settings !== undefined && (typeof json.settings !== 'object' || Array.isArray(json.settings) || json.settings === null)) {
    add('Settings', 'fail', '"settings" must be an object.');
  }
  if ('namespace' in json) {
    add('Namespace', 'warn', 'A namespace in the definition is ignored: QA orgs are created with --no-namespace so the managed package can be installed.');
  }
  if (json.release === 'Preview') {
    add('Release', 'warn', 'Preview release orgs may behave differently from what subscribers run.');
  }
  return { file, json, checks, ok: !checks.some(c => c.status === 'fail') };
}
