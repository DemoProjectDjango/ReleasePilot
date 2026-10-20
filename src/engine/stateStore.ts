import * as fs from 'fs';
import * as path from 'path';
import { PIPELINE } from '../core/pipeline';
import { Run, StepId, StepState, STEP_STATUSES, WorkflowState } from '../core/models';

export interface StateStore {
  load(): WorkflowState | undefined;
  save(state: WorkflowState): void;
}

export function newRun(id: string, now: Date): Run {
  const steps = {} as Record<StepId, StepState>;
  for (const def of PIPELINE) {
    steps[def.id] = { id: def.id, status: 'pending', attempt: 0, evidence: [] };
  }
  return { id, startedAt: now.toISOString(), steps };
}

export function emptyState(runId: string, now: Date): WorkflowState {
  return { schemaVersion: 1, run: newRun(runId, now), history: [], logs: [] };
}

/** Structural validation so a corrupt or foreign file is never trusted. */
export function isWorkflowState(value: unknown): value is WorkflowState {
  const v = value as WorkflowState | undefined;
  if (!v || v.schemaVersion !== 1 || !v.run || typeof v.run.id !== 'string' || !Array.isArray(v.history) || !Array.isArray(v.logs)) {
    return false;
  }
  return PIPELINE.every(def => {
    const s = v.run.steps?.[def.id];
    return !!s && STEP_STATUSES.includes(s.status) && Array.isArray(s.evidence);
  });
}

/** JSON file store with atomic replace; a corrupt file is preserved as .corrupt and ignored. */
export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}

  load(): WorkflowState | undefined {
    if (!fs.existsSync(this.file)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (isWorkflowState(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to quarantine
    }
    try {
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    } catch {
      // best effort
    }
    return undefined;
  }

  save(state: WorkflowState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
