import * as fs from 'fs';
import * as path from 'path';
import { redact } from '../core/redact';
import { CommandHistory } from './commandHistory';
import { ProcessRunner, RunResult } from './processRunner';

export interface Launcher {
  command: string;
  prefixArgs: string[];
}

/**
 * Resolves how to start `sf` without a shell. npm installs on Windows create sf.cmd/sf.ps1 shims which
 * cannot be spawned safely without a shell, so we start node directly on the CLI's run.js.
 */
export function resolveSfLauncher(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync
): Launcher | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  if (platform !== 'win32') {
    return dirs.some(d => exists(path.join(d, 'sf'))) ? { command: 'sf', prefixArgs: [] } : undefined;
  }
  for (const dir of dirs) {
    const runJs = path.join(dir, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
    if (exists(path.join(dir, 'sf.cmd')) && exists(runJs)) {
      const localNode = path.join(dir, 'node.exe');
      const node = exists(localNode) ? localNode : dirs.map(d => path.join(d, 'node.exe')).find(exists);
      if (node) {
        return { command: node, prefixArgs: ['--no-deprecation', runJs] };
      }
    }
    // Installer-based layout: sf.exe can be spawned directly.
    if (exists(path.join(dir, 'sf.exe'))) {
      return { command: path.join(dir, 'sf.exe'), prefixArgs: [] };
    }
  }
  return undefined;
}

export class SfError extends Error {
  constructor(readonly code: string, message: string, readonly remediation?: string, readonly detail?: string) {
    super(message);
  }
}

const ALIAS_RE = /^[A-Za-z0-9_.@+-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9]{15,18}$/;

export function assertAlias(value: string, what = 'org alias or username'): string {
  if (!ALIAS_RE.test(value) || value.startsWith('-')) {
    throw new SfError('INVALID_ARGUMENT', `Invalid ${what}.`);
  }
  return value;
}

export function assertSalesforceId(value: string, prefix?: string): string {
  if (!ID_RE.test(value) || (prefix && !value.startsWith(prefix))) {
    throw new SfError('INVALID_ARGUMENT', `Invalid Salesforce ID${prefix ? ` (expected ${prefix}...)` : ''}.`);
  }
  return value;
}

export interface SfJson {
  status: number;
  result?: unknown;
  name?: string;
  message?: string;
  warnings?: unknown[];
}

/**
 * Extracts the CLI's JSON envelope from output that may be preceded by warnings. Warning text can itself
 * contain braces, so every candidate start is tried and only a parse that yields an envelope is accepted.
 */
export function extractJson(text: string): SfJson | undefined {
  const end = text.lastIndexOf('}');
  let start = text.indexOf('{');
  while (start >= 0 && start < end) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && typeof (parsed as SfJson).status === 'number') {
        return parsed as SfJson;
      }
    } catch {
      // not a valid JSON document from this start; try the next brace
    }
    start = text.indexOf('{', start + 1);
  }
  return undefined;
}

/** Maps CLI error names/messages to actionable guidance (NFR-15). */
export function explainError(name: string | undefined, message: string): { code: string; remediation?: string } {
  const text = `${name ?? ''} ${message}`;
  if (/NamedOrgNotFound|No authorization information found/i.test(text)) {
    return { code: 'ORG_NOT_FOUND', remediation: 'Authenticate the org with "sf org login web --alias <alias>" and select it again.' };
  }
  if (/expired|invalid_grant|refresh token|INVALID_SESSION_ID|AuthDecryptError/i.test(text)) {
    return { code: 'AUTH_EXPIRED', remediation: 'The org authorization has expired. Re-authenticate with "sf org login web" and retry.' };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return { code: 'NETWORK', remediation: 'Check your network connection and Salesforce instance availability.' };
  }
  if (/not a valid command|command .* not found/i.test(text)) {
    return { code: 'COMMAND_UNAVAILABLE', remediation: 'This Salesforce CLI version does not support the command. Update with "sf update".' };
  }
  return { code: name || 'SF_ERROR' };
}

export interface SfRunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Disable JSON parsing for plain-text commands such as --version. */
  plain?: boolean;
}

export class SfCli {
  constructor(
    private readonly runner: ProcessRunner,
    readonly history: CommandHistory,
    private readonly launcher: Launcher | undefined
  ) {}

  get available(): boolean {
    return !!this.launcher;
  }

  /** Executes `sf <args>` and returns the parsed JSON `result`. Throws SfError with actionable text. */
  async json<T = unknown>(args: string[], opts: SfRunOptions): Promise<{ result: T; warnings: string[] }> {
    const res = await this.exec([...args, '--json'], opts);
    const env = extractJson(res.stdout) ?? extractJson(res.stderr);
    if (res.exitCode === 0 && env && env.status === 0) {
      return { result: env.result as T, warnings: (env.warnings ?? []).map(w => redact(String(typeof w === 'string' ? w : JSON.stringify(w)))) };
    }
    const message = redact(env?.message ?? (res.stderr.trim() || `Command exited with code ${res.exitCode}`));
    const info = explainError(env?.name, message);
    throw new SfError(info.code, message, info.remediation);
  }

  async text(args: string[], opts: SfRunOptions): Promise<string> {
    const res = await this.exec(args, { ...opts, plain: true });
    if (res.exitCode !== 0) {
      throw new SfError('SF_ERROR', redact(res.stderr.trim() || `Command exited with code ${res.exitCode}`));
    }
    return res.stdout.trim();
  }

  private async exec(args: string[], opts: SfRunOptions): Promise<RunResult> {
    if (!this.launcher) {
      throw new SfError('SF_NOT_FOUND', 'Salesforce CLI (sf) was not found on PATH.',
        'Install it from https://developer.salesforce.com/tools/salesforcecli and restart VS Code.');
    }
    const full = [...this.launcher.prefixArgs, ...args];
    const res = await this.runner.run({
      command: this.launcher.command, args: full, cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, onLine: opts.plain ? opts.onLine : undefined
    });
    // Record the user-facing command ("sf ..."), not the node bootstrap path.
    const outcome = res.spawnError ? 'not-started' : res.aborted ? 'cancelled' : res.timedOut ? 'timeout' : res.exitCode === 0 ? 'ok' : 'error';
    this.history.add({
      command: 'sf', args, cwd: opts.cwd, at: new Date().toISOString(), exitCode: res.exitCode,
      durationMs: res.durationMs, outcome, summary: res.spawnError ?? (outcome === 'error' ? firstLine(res.stderr || res.stdout) : undefined)
    });
    if (res.spawnError) {
      throw new SfError('SF_NOT_STARTED', `Could not start Salesforce CLI: ${redact(res.spawnError)}`);
    }
    if (res.aborted) {
      throw new SfError('CANCELLED', 'Command cancelled locally. Remote operations may still be running.');
    }
    if (res.timedOut) {
      throw new SfError('TIMEOUT', 'The command timed out locally. Remote state is unknown.', 'Check Salesforce before retrying.');
    }
    return res;
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? '';
}
