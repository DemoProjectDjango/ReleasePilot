import { redact } from '../core/redact';

export interface CommandRecord {
  id: number;
  at: string;
  /** Redacted, copyable command line. */
  display: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  outcome: 'ok' | 'error' | 'timeout' | 'cancelled' | 'not-started';
  summary?: string;
}

/** Transparent record of every executed command (NFR-09). Never stores raw output. */
export class CommandHistory {
  private records: CommandRecord[] = [];
  private seq = 0;

  constructor(private readonly max = 100) {}

  add(rec: Omit<CommandRecord, 'id' | 'display'> & { command: string; args: string[] }): CommandRecord {
    const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    const { command, args, ...rest } = rec;
    const record: CommandRecord = {
      ...rest,
      id: ++this.seq,
      display: redact([command, ...args].map(quote).join(' ')),
      summary: rest.summary ? redact(rest.summary) : undefined
    };
    this.records.unshift(record);
    this.records.length = Math.min(this.records.length, this.max);
    return record;
  }

  list(): CommandRecord[] {
    return [...this.records];
  }
}
