import * as fs from 'fs';
import * as path from 'path';
import { redact } from '../core/redact';
import { Triage } from './analyzer';

/**
 * Justified dismissals of analyzer findings (spec Stage 3). Every entry needs a reason, an owner and a
 * timestamp; nothing is suppressed silently, and entries are visible in the UI.
 */
export class TriageStore {
  private items: Triage[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        this.items = parsed.filter((t): t is Triage =>
          !!t && typeof t.key === 'string' && typeof t.reason === 'string' && typeof t.owner === 'string' && typeof t.at === 'string');
      }
    } catch {
      this.items = [];
    }
  }

  list(): Triage[] {
    return [...this.items];
  }

  keys(): ReadonlySet<string> {
    return new Set(this.items.map(i => i.key));
  }

  add(key: string, reason: string, owner: string): Triage {
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      throw new Error('A justification of at least 10 characters is required.');
    }
    if (!owner.trim()) {
      throw new Error('An owner is required.');
    }
    const entry: Triage = { key, reason: redact(trimmed), owner: owner.trim(), at: new Date().toISOString() };
    this.items = [...this.items.filter(i => i.key !== key), entry];
    this.save();
    return entry;
  }

  remove(key: string): void {
    this.items = this.items.filter(i => i.key !== key);
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
