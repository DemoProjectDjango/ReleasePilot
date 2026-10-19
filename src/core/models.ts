export type StepStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'needs-review'
  | 'stale'
  | 'skipped'
  | 'cancelled';

export const STEP_STATUSES: readonly StepStatus[] = [
  'pending', 'running', 'passed', 'failed', 'blocked', 'needs-review', 'stale', 'skipped', 'cancelled'
];

export type StepId =
  | 'preflight'
  | 'source'
  | 'analysis'
  | 'tests'
  | 'package-readiness'
  | 'package-build'
  | 'clean-install-qa'
  | 'upgrade-qa'
  | 'release-review'
  | 'promotion';

export interface StepDefinition {
  id: StepId;
  title: string;
  description: string;
  dependsOn: StepId[];
  /** Optional steps may be skipped without blocking dependents. */
  optional: boolean;
  /** Irreversible steps require explicit approval to run. */
  requiresApproval: boolean;
  /** Slice in which the real executor is delivered. */
  plannedSlice: number;
  requirements: string[];
}

export interface Evidence {
  id: string;
  kind: string;
  label: string;
  /** Absolute path or stable identifier (e.g. 08c / 04t id). Never a secret. */
  ref: string;
  createdAt: string;
}

export interface Failure {
  code: string;
  message: string;
  detail?: string;
  remediation?: string;
  at: string;
}

export interface StepState {
  id: StepId;
  status: StepStatus;
  attempt: number;
  startedAt?: string;
  endedAt?: string;
  message?: string;
  fingerprint?: string;
  evidence: Evidence[];
  failure?: Failure;
}

export interface Run {
  id: string;
  startedAt: string;
  endedAt?: string;
  steps: Record<StepId, StepState>;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  outcome: Record<StepStatus, number>;
  passedSteps: StepId[];
}

export interface LogEntry {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  stepId?: StepId;
}

export interface WorkflowState {
  schemaVersion: 1;
  run: Run;
  history: RunSummary[];
  logs: LogEntry[];
  /** Reports produced outside a step run (e.g. retrieval previews). */
  artifacts?: Evidence[];
}

export interface StepResult {
  status: Extract<StepStatus, 'passed' | 'failed' | 'needs-review' | 'skipped' | 'blocked'>;
  message?: string;
  evidence?: Evidence[];
  failure?: Omit<Failure, 'at'>;
  fingerprint?: string;
}

export interface StepContext {
  runId: string;
  signal: AbortSignal;
  log: (level: LogEntry['level'], message: string) => void;
}

/** A step executor performs real work and returns evidence-backed results. */
export type StepExecutor = (ctx: StepContext) => Promise<StepResult>;
