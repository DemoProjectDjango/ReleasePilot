import { spawn } from 'child_process';

export interface RunRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for each complete output line as it arrives (real-time output). */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started (e.g. ENOENT). */
  spawnError?: string;
  truncated: boolean;
}

export interface ProcessRunner {
  run(req: RunRequest): Promise<RunResult>;
}

const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

/** Rejects arguments that could be misinterpreted by any layer between us and the child. */
export function assertSafeArgs(command: string, args: string[]): void {
  if (!command || /[\0\r\n]/.test(command)) {
    throw new Error('Invalid command.');
  }
  for (const a of args) {
    if (typeof a !== 'string' || /[\0\r\n]/.test(a)) {
      throw new Error('Invalid command argument.');
    }
  }
}

/** spawn() with shell:false and an argument array. No string is ever interpreted by a shell. */
export class NodeProcessRunner implements ProcessRunner {
  run(req: RunRequest): Promise<RunResult> {
    assertSafeArgs(req.command, req.args);
    const started = Date.now();
    return new Promise(resolve => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const partial = { stdout: '', stderr: '' };

      const finish = (exitCode: number | null, spawnError?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        for (const s of ['stdout', 'stderr'] as const) {
          if (partial[s]) {
            req.onLine?.(s, partial[s]);
          }
        }
        resolve({
          exitCode, spawnError, timedOut, aborted, truncated,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          durationMs: Date.now() - started
        });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(req.command, req.args, {
          cwd: req.cwd,
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...req.env, NO_COLOR: '1', FORCE_COLOR: '0', SF_JSON_TO_STDOUT: 'true', SF_DISABLE_AUTOUPDATE: 'true' }
        });
      } catch (e) {
        resolve({ exitCode: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, aborted: false, truncated: false, spawnError: e instanceof Error ? e.message : String(e) });
        return;
      }

      const kill = () => { try { child.kill(); } catch { /* already gone */ } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, req.timeoutMs ?? 10 * 60_000);
      const onAbort = () => { aborted = true; kill(); };
      if (req.signal?.aborted) {
        onAbort();
      } else {
        req.signal?.addEventListener('abort', onAbort);
      }

      const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const sink = stream === 'stdout' ? out : err;
        const size = stream === 'stdout' ? outBytes : errBytes;
        if (size < MAX_CAPTURE_BYTES) {
          sink.push(chunk);
          if (stream === 'stdout') { outBytes += chunk.length; } else { errBytes += chunk.length; }
        } else {
          truncated = true;
        }
        if (req.onLine) {
          const text = partial[stream] + chunk.toString('utf8');
          const lines = text.split(/\r?\n/);
          partial[stream] = lines.pop() ?? '';
          lines.forEach(l => req.onLine!(stream, l));
        }
      };
      child.stdout?.on('data', (c: Buffer) => collect('stdout', c));
      child.stderr?.on('data', (c: Buffer) => collect('stderr', c));
      child.on('error', e => finish(null, e.message));
      child.on('close', code => finish(code));
    });
  }
}
