import { createHash } from 'crypto';
import * as path from 'path';

export interface RecentProject {
  path: string;
  name: string;
  lastUsed: string;
}

export interface ProjectChoice {
  path: string;
  name: string;
  /** Unique, human-readable label (adds the parent folder when two projects share a name). */
  label: string;
  source: 'workspace' | 'recent';
}

/** Canonical form used to compare paths (case-insensitive on Windows, trailing separators ignored). */
export function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b);

/** Stable short id of a project folder, used to give every project its own state directory. */
export function projectKey(root: string): string {
  return createHash('sha1').update(normalizePath(root)).digest('hex').slice(0, 12);
}

/** Newest first, de-duplicated, capped. */
export function addRecent(list: readonly RecentProject[], projectPath: string, now: Date, max = 10): RecentProject[] {
  const entry: RecentProject = { path: path.resolve(projectPath), name: path.basename(path.resolve(projectPath)), lastUsed: now.toISOString() };
  return [entry, ...list.filter(r => !samePath(r.path, projectPath))].slice(0, max);
}

/** Workspace folders first, then recent projects that still exist and are not already listed. */
export function projectChoices(workspaceFolders: readonly string[], recents: readonly RecentProject[], exists: (p: string) => boolean): ProjectChoice[] {
  const out: ProjectChoice[] = [];
  const push = (p: string, source: ProjectChoice['source']) => {
    if (!out.some(c => samePath(c.path, p))) {
      out.push({ path: path.resolve(p), name: path.basename(path.resolve(p)), label: '', source });
    }
  };
  workspaceFolders.forEach(f => push(f, 'workspace'));
  recents.filter(r => exists(r.path)).forEach(r => push(r.path, 'recent'));
  for (const c of out) {
    const clash = out.filter(o => o.name.toLowerCase() === c.name.toLowerCase()).length > 1;
    c.label = clash ? `${c.name} (${path.basename(path.dirname(c.path)) || path.dirname(c.path)})` : c.name;
  }
  return out;
}
