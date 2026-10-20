import * as fs from 'fs';
import * as path from 'path';
import { AnalysisReport } from '../analysis/analyzer';
import { ApexRun } from './apex';
import { LwcRun } from './lwc';

export interface QualityState {
  analysis?: AnalysisReport;
  apex?: ApexRun;
  lwc?: LwcRun;
  /** Result of re-running only failed tests; informational, never satisfies the gate. */
  rerun?: ApexRun;
}

/** Persists the latest normalized quality results so the UI survives restarts. */
export class QualityStore {
  private state: QualityState = {};

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.state = parsed as QualityState;
      }
    } catch {
      this.state = {};
    }
  }

  get(): QualityState {
    return this.state;
  }

  update(patch: Partial<QualityState>): void {
    this.state = { ...this.state, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
