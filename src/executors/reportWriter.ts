import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Evidence } from '../core/models';
import { redact } from '../core/redact';

/** Writes redacted JSON reports under the extension's storage and returns evidence describing them. */
export class ReportWriter {
  constructor(private readonly dir: string) {}

  write(kind: string, label: string, body: unknown): Evidence {
    fs.mkdirSync(this.dir, { recursive: true });
    const at = new Date().toISOString();
    const file = path.join(this.dir, `${kind}-${at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, redact(JSON.stringify(body, null, 2)), 'utf8');
    return { id: randomUUID(), kind, label, ref: file, createdAt: at };
  }
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
