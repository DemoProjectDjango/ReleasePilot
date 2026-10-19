import { randomUUID } from 'crypto';
import { Logger } from '../core/logger';
import {
  Evidence, Failure, RunSummary, StepDefinition, StepExecutor, StepId, StepResult, StepState, StepStatus, WorkflowState
} from '../core/models';
import { PIPELINE } from '../core/pipeline';
import { redact } from '../core/redact';
import { emptyState, newRun, StateStore } from './stateStore';

export interface EngineOptions {
  store: StateStore;
  logger: Logger;
  executors?: Partial<Record<StepId, StepExecutor>>;
  /** Return false to refuse execution (e.g. untrusted workspace). */
  canExecute?: () => { allowed: boolean; reason?: string };
  now?: () => Date;
  stepTimeoutMs?: number;
}

export interface RunOptions {
  /** Explicit human approval for irreversible steps. */
  approved?: boolean;
}

export type RunRefusal = { ok: false; code: string; message: string };
export type RunAccepted = { ok: true; status: StepStatus };

const RESETTABLE: StepStatus[] = ['failed', 'blocked', 'needs-review', 'stale', 'cancelled', 'pending', 'skipped'];

export class WorkflowEngine {
  private state: WorkflowState;
  private readonly defs = new Map<StepId, StepDefinition>(PIPELINE.map(d => [d.id, d]));
  private readonly executors: Partial<Record<StepId, StepExecutor>>;
  private readonly controllers = new Map<StepId, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
    this.executors = opts.executors ?? {};
    this.state = opts.store.load() ?? emptyState(randomUUID(), this.now());
    this.recoverInterrupted();
  }

  // ---- observation -------------------------------------------------------

  getState(): WorkflowState {
    return { ...this.state, logs: this.opts.logger.getEntries() };
  }

  getDefinitions(): readonly StepDefinition[] {
    return PIPELINE;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasExecutor(id: StepId): boolean {
    return !!this.executors[id];
  }

  /** Why a step cannot run right now, or undefined when it is runnable. */
  blockReason(id: StepId, runOpts: RunOptions = {}): { code: string; message: string } | undefined {
    const def = this.defs.get(id);
    const step = this.state.run.steps[id];
    if (!def || !step) {
      return { code: 'UNKNOWN_STEP', message: `Unknown step "${id}".` };
    }
    if (step.status === 'running') {
      return { code: 'ALREADY_RUNNING', message: `${def.title} is already running.` };
    }
    const guard = this.opts.canExecute?.();
    if (guard && !guard.allowed) {
      return { code: 'NOT_PERMITTED', message: guard.reason ?? 'Execution is not permitted.' };
    }
    if (!this.executors[id]) {
      return {
        code: 'NOT_IMPLEMENTED',
        message: `${def.title} is not available in this build; it is delivered in Slice ${def.plannedSlice}. No result has been recorded.`
      };
    }
    for (const dep of def.dependsOn) {
      const d = this.defs.get(dep)!;
      const ds = this.state.run.steps[dep].status;
      const satisfied = ds === 'passed' || (ds === 'skipped' && d.optional);
      if (!satisfied) {
        return { code: 'DEPENDENCY_NOT_MET', message: `${d.title} must pass first (currently ${ds}).` };
      }
    }
    if (def.requiresApproval && !runOpts.approved) {
      return { code: 'APPROVAL_REQUIRED', message: `${def.title} requires explicit user approval.` };
    }
    return undefined;
  }

  // ---- execution ---------------------------------------------------------

  async runStep(id: StepId, runOpts: RunOptions = {}): Promise<RunAccepted | RunRefusal> {
    const refusal = this.blockReason(id, runOpts);
    if (refusal) {
      this.opts.logger.log('warn', 'engine', `Refused to run ${id}: ${refusal.message}`, id);
      this.notify();
      return { ok: false, ...refusal };
    }
    const def = this.defs.get(id)!;
    const step = this.state.run.steps[id];
    const controller = new AbortController();
    this.controllers.set(id, controller);

    step.status = 'running';
    step.attempt += 1;
    step.startedAt = this.now().toISOString();
    step.endedAt = undefined;
    step.message = undefined;
    step.failure = undefined;
    step.evidence = [];
    this.opts.logger.log('info', 'engine', `Started ${def.title} (attempt ${step.attempt})`, id);
    this.persist();

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        if (this.opts.stepTimeoutMs) {
          timer = setTimeout(() => reject(new Error('STEP_TIMEOUT')), this.opts.stepTimeoutMs);
        }
      });
      const exec = this.executors[id]!({
        runId: this.state.run.id,
        signal: controller.signal,
        log: (level, message) => this.opts.logger.log(level, id, message, id)
      });
      const result = await Promise.race([exec, timeout]);
      this.applyResult(step, def, result, controller.signal.aborted);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        this.finish(step, 'cancelled', 'Cancelled locally. Any remote Salesforce job may still be running; verify before retrying.');
      } else if (message === 'STEP_TIMEOUT') {
        // A local timeout is not proof of failure: the remote job state is unknown.
        this.finish(step, 'needs-review', 'Local wait timed out. Remote state is unknown; reconcile with Salesforce before retrying.');
        step.failure = this.failure('STEP_TIMEOUT', 'The local wait timed out.', undefined, 'Query the remote job status before retrying.');
      } else {
        this.finish(step, 'failed', redact(message));
        step.failure = this.failure('EXECUTOR_ERROR', redact(message));
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      this.controllers.delete(id);
    }
    const final: StepStatus = this.state.run.steps[id].status;
    this.opts.logger.log(final === 'passed' ? 'info' : 'warn', 'engine', `${def.title} finished: ${final}`, id);
    this.persist();
    return { ok: true, status: final };
  }

  /** Runs each runnable step in order until one does not pass. Never skips required steps. */
  async resume(runOpts: RunOptions = {}): Promise<RunRefusal | { ok: true; stoppedAt?: StepId }> {
    for (const def of PIPELINE) {
      const step = this.state.run.steps[def.id];
      if (step.status === 'passed' || (step.status === 'skipped' && def.optional)) {
        continue;
      }
      if (def.requiresApproval && !runOpts.approved) {
        return { ok: true, stoppedAt: def.id };
      }
      const res = await this.runStep(def.id, runOpts);
      if (!res.ok) {
        return res;
      }
      if (res.status !== 'passed' && !(res.status === 'skipped' && def.optional)) {
        return { ok: true, stoppedAt: def.id };
      }
    }
    return { ok: true };
  }

  cancel(id: StepId): boolean {
    const controller = this.controllers.get(id);
    if (!controller) {
      return false;
    }
    this.opts.logger.log('warn', 'engine', 'Cancellation requested (local wait only; remote jobs are not cancelled).', id);
    controller.abort();
    return true;
  }

  // ---- freshness ---------------------------------------------------------

  /** Marks every step downstream of `id` (exclusive) that had a result as stale. */
  invalidateDownstream(id: StepId, reason: string): StepId[] {
    const affected: StepId[] = [];
    const visit = (from: StepId): void => {
      for (const def of PIPELINE) {
        if (def.dependsOn.includes(from) && !affected.includes(def.id)) {
          const s = this.state.run.steps[def.id];
          if (s.status === 'passed' || s.status === 'needs-review' || s.status === 'skipped') {
            s.status = 'stale';
            s.message = `Stale: ${reason}`;
            affected.push(def.id);
          }
          visit(def.id);
        }
      }
    };
    visit(id);
    if (affected.length) {
      this.opts.logger.log('warn', 'engine', `Invalidated ${affected.join(', ')}: ${reason}`);
      this.persist();
    }
    return affected;
  }

  /** Marks a step itself (if it holds a result) and everything downstream stale. */
  markStale(id: StepId, reason: string): void {
    const s = this.state.run.steps[id];
    if (s.status === 'passed' || s.status === 'needs-review' || s.status === 'skipped') {
      s.status = 'stale';
      s.message = `Stale: ${reason}`;
      this.opts.logger.log('warn', 'engine', `Invalidated ${id}: ${reason}`, id);
    }
    this.invalidateDownstream(id, reason);
    this.persist();
  }

  addArtifact(evidence: Evidence): void {
    this.state.artifacts = [evidence, ...(this.state.artifacts ?? [])].slice(0, 200);
    this.persist();
  }

  /** Resets a step and everything downstream to pending/stale so it can be re-executed. */
  reset(id: StepId): void {
    const step = this.state.run.steps[id];
    if (step.status === 'running') {
      return;
    }
    if (RESETTABLE.includes(step.status) || step.status === 'passed') {
      step.status = 'pending';
      step.message = undefined;
      step.failure = undefined;
      step.evidence = [];
      this.invalidateDownstream(id, `${this.defs.get(id)!.title} was reset`);
      this.persist();
    }
  }

  // ---- runs --------------------------------------------------------------

  startNewRun(): boolean {
    if (Object.values(this.state.run.steps).some(s => s.status === 'running')) {
      return false;
    }
    const ended = this.now();
    this.state.run.endedAt = ended.toISOString();
    this.state.history.unshift(this.summarize());
    this.state.history = this.state.history.slice(0, 200);
    this.state.run = newRun(randomUUID(), ended);
    this.opts.logger.log('info', 'engine', 'Started a new release run.');
    this.persist();
    return true;
  }

  // ---- internals ---------------------------------------------------------

  private summarize(): RunSummary {
    const outcome = {} as Record<StepStatus, number>;
    for (const s of ['pending', 'running', 'passed', 'failed', 'blocked', 'needs-review', 'stale', 'skipped', 'cancelled'] as StepStatus[]) {
      outcome[s] = 0;
    }
    const steps = Object.values(this.state.run.steps);
    steps.forEach(s => outcome[s.status]++);
    return {
      id: this.state.run.id,
      startedAt: this.state.run.startedAt,
      endedAt: this.state.run.endedAt ?? this.now().toISOString(),
      outcome,
      passedSteps: steps.filter(s => s.status === 'passed').map(s => s.id)
    };
  }

  private applyResult(step: StepState, def: StepDefinition, result: StepResult, aborted: boolean): void {
    if (aborted) {
      this.finish(step, 'cancelled', 'Cancelled locally. Any remote Salesforce job may still be running; verify before retrying.');
      return;
    }
    const evidence = result.evidence ?? [];
    if (result.status === 'passed' && evidence.length === 0) {
      this.finish(step, 'failed', 'Executor reported success without evidence; result rejected.');
      step.failure = this.failure('EVIDENCE_MISSING', `${def.title} reported success but supplied no verifiable evidence.`,
        undefined, 'Executors must attach at least one evidence item (report, ID or log) to pass.');
      return;
    }
    if (result.status === 'skipped' && !def.optional) {
      this.finish(step, 'blocked', 'A required step cannot be skipped; downstream steps remain blocked.');
      step.failure = this.failure('REQUIRED_STEP_SKIPPED', `${def.title} is required and cannot be skipped.`);
      return;
    }
    this.finish(step, result.status, result.message ? redact(result.message) : undefined);
    step.evidence = evidence;
    step.fingerprint = result.fingerprint;
    if (result.failure) {
      step.failure = this.failure(result.failure.code, redact(result.failure.message),
        result.failure.detail ? redact(result.failure.detail) : undefined, result.failure.remediation);
    }
  }

  private finish(step: StepState, status: StepStatus, message?: string): void {
    step.status = status;
    step.message = message;
    step.endedAt = this.now().toISOString();
  }

  private failure(code: string, message: string, detail?: string, remediation?: string): Failure {
    return { code, message, detail, remediation, at: this.now().toISOString() };
  }

  /** After a restart nothing can still be running locally; surface that honestly. */
  private recoverInterrupted(): void {
    let changed = false;
    for (const step of Object.values(this.state.run.steps)) {
      if (step.status === 'running') {
        step.status = 'needs-review';
        step.message = 'Interrupted by a VS Code restart. Remote job state is unknown; reconcile before retrying.';
        step.endedAt = this.now().toISOString();
        step.failure = this.failure('INTERRUPTED', 'The step was running when VS Code closed.',
          undefined, 'Check Salesforce for in-flight jobs before retrying so duplicates are not created.');
        changed = true;
      }
    }
    if (changed) {
      this.opts.logger.log('warn', 'engine', 'Recovered interrupted step(s) as needs-review.');
      this.persist();
    }
  }

  private persist(): void {
    this.opts.store.save({ ...this.state, logs: this.opts.logger.getEntries() });
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach(l => l());
  }
}
