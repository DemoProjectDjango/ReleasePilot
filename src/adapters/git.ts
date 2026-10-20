import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { redact } from '../core/redact';
import { CommandHistory } from './commandHistory';
import { ProcessRunner } from './processRunner';

export interface GitFile {
  path: string;
  /** Two-letter porcelain status, e.g. " M", "??". */
  status: string;
}

export interface GitSnapshot {
  isRepo: boolean;
  version?: string;
  branch?: string;
  head?: string;
  files: GitFile[];
  /** Hash of HEAD + all uncommitted changes (tracked and untracked), excluding ReleasePilot's own config. */
  fingerprint?: string;
  error?: string;
}

const IGNORED = new Set(['.releasepilot.json']);

export class GitAdapter {
  constructor(private readonly runner: ProcessRunner, private readonly history: CommandHistory) {}

  private async git(cwd: string, args: string[]) {
    const res = await this.runner.run({ command: 'git', args, cwd, timeoutMs: 60_000 });
    this.history.add({
      command: 'git', args, cwd, at: new Date().toISOString(), exitCode: res.exitCode, durationMs: res.durationMs,
      outcome: res.spawnError ? 'not-started' : res.exitCode === 0 ? 'ok' : 'error',
      summary: res.exitCode === 0 ? undefined : (res.spawnError ?? res.stderr.trim().split(/\r?\n/)[0])
    });
    return res;
  }

  async snapshot(cwd: string): Promise<GitSnapshot> {
    const ver = await this.git(cwd, ['--version']);
    if (ver.spawnError || ver.exitCode !== 0) {
      return { isRepo: false, files: [], error: 'Git was not found on PATH.' };
    }
    const version = ver.stdout.trim();
    const top = await this.git(cwd, ['rev-parse', '--show-toplevel']);
    if (top.exitCode !== 0) {
      return { isRepo: false, version, files: [], error: 'The project folder is not inside a Git repository.' };
    }
    const root = path.normalize(top.stdout.trim());
    const [head, branch, status, diff] = await Promise.all([
      this.git(cwd, ['rev-parse', 'HEAD']),
      this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.git(cwd, ['status', '--porcelain=v1', '-z', '-uall']),
      this.git(cwd, ['diff', 'HEAD', '--binary'])
    ]);
    const files = parsePorcelainZ(status.stdout).filter(f => !IGNORED.has(path.basename(f.path)));
    const h = createHash('sha256');
    h.update(head.exitCode === 0 ? head.stdout.trim() : 'NO_HEAD');
    h.update(createHash('sha256').update(diff.stdout).digest('hex'));
    for (const f of files.filter(x => x.status === '??').sort((a, b) => a.path.localeCompare(b.path))) {
      h.update(`${f.path}:${hashFile(path.join(root, f.path))}`);
    }
    return {
      isRepo: true, version, files,
      head: head.exitCode === 0 ? head.stdout.trim() : undefined,
      branch: branch.exitCode === 0 ? branch.stdout.trim() : undefined,
      fingerprint: h.digest('hex'),
      error: status.exitCode !== 0 ? redact(status.stderr.trim()) : undefined
    };
  }
}

export function parsePorcelainZ(out: string): GitFile[] {
  const parts = out.split('\0').filter(Boolean);
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const status = entry.slice(0, 2);
    files.push({ status, path: entry.slice(3) });
    if (status[0] === 'R' || status[0] === 'C') {
      i++; // the original path follows as a separate NUL-delimited field
    }
  }
  return files;
}

function hashFile(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return 'not-file';
    }
    if (stat.size > 5 * 1024 * 1024) {
      return `big:${stat.size}:${stat.mtimeMs}`;
    }
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}
