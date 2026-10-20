import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../core/logger';
import { StepExecutor, StepId, WorkflowState } from '../core/models';
import { redact } from '../core/redact';
import { FileStateStore, StateStore } from '../engine/stateStore';
import { WorkflowEngine } from '../engine/workflowEngine';
import { parseMessage } from '../ui/messages';

class MemStore implements StateStore {
  saved?: WorkflowState;
  load() { return this.saved ? JSON.parse(JSON.stringify(this.saved)) as WorkflowState : undefined; }
  save(s: WorkflowState) { this.saved = JSON.parse(JSON.stringify(s)) as WorkflowState; }
}

const ev = (id: string) => ({ id, kind: 'test', label: id, ref: id, createdAt: new Date().toISOString() });
const pass: StepExecutor = async () => ({ status: 'passed', evidence: [ev('e')] });

function make(executors: Partial<Record<StepId, StepExecutor>>, store: StateStore = new MemStore(), extra = {}) {
  return new WorkflowEngine({ store, logger: new Logger(), executors, ...extra });
}
const status = (e: WorkflowEngine, id: StepId) => e.getState().run.steps[id].status;

describe('WorkflowEngine', () => {
  it('refuses unimplemented steps and records no result', async () => {
    const e = make({});
    const res = await e.runStep('preflight');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('NOT_IMPLEMENTED');
    expect(status(e, 'preflight')).toBe('pending');
  });

  it('blocks a step until dependencies pass', async () => {
    const e = make({ source: pass });
    const res = await e.runStep('source');
    expect(res.ok === false && res.code).toBe('DEPENDENCY_NOT_MET');
  });

  it('passes with evidence and enables the next step', async () => {
    const e = make({ preflight: pass, source: pass });
    expect((await e.runStep('preflight')).ok).toBe(true);
    expect(status(e, 'preflight')).toBe('passed');
    expect(e.blockReason('source')).toBeUndefined();
  });

  it('rejects success without evidence', async () => {
    const e = make({ preflight: async () => ({ status: 'passed' }) });
    await e.runStep('preflight');
    const s = e.getState().run.steps.preflight;
    expect(s.status).toBe('failed');
    expect(s.failure?.code).toBe('EVIDENCE_MISSING');
  });

  it('records executor exceptions as failed with redacted message', async () => {
    const e = make({ preflight: async () => { throw new Error('boom access_token=abc123secret'); } });
    await e.runStep('preflight');
    const s = e.getState().run.steps.preflight;
    expect(s.status).toBe('failed');
    expect(s.message).not.toContain('abc123secret');
  });

  it('does not allow a required step to be skipped', async () => {
    const e = make({ preflight: async () => ({ status: 'skipped' }) });
    await e.runStep('preflight');
    expect(status(e, 'preflight')).toBe('blocked');
  });

  it('invalidates downstream results as stale', async () => {
    const e = make({ preflight: pass, source: pass, analysis: pass });
    await e.runStep('preflight');
    await e.runStep('source');
    await e.runStep('analysis');
    const affected = e.invalidateDownstream('preflight', 'dev hub changed');
    expect(affected).toEqual(['source', 'analysis']);
    expect(status(e, 'analysis')).toBe('stale');
    expect(e.blockReason('analysis')?.code).toBe('DEPENDENCY_NOT_MET');
  });

  it('requires approval for irreversible steps', () => {
    const e = make({ promotion: pass });
    expect(e.blockReason('promotion', {})?.code).toBe('DEPENDENCY_NOT_MET');
    const all = make({ promotion: pass });
    // satisfy dependencies by direct state edit through real runs
    expect(all.getDefinitions().find(d => d.id === 'promotion')?.requiresApproval).toBe(true);
  });

  it('enforces approval even when dependencies are met', async () => {
    const execs: Partial<Record<StepId, StepExecutor>> = {};
    for (const id of ['preflight', 'source', 'analysis', 'tests', 'package-readiness', 'package-build',
      'clean-install-qa', 'release-review', 'promotion'] as StepId[]) { execs[id] = pass; }
    execs['upgrade-qa'] = async () => ({ status: 'skipped' });
    const e = make(execs);
    for (const id of ['preflight', 'source', 'analysis', 'tests', 'package-readiness', 'package-build',
      'clean-install-qa', 'upgrade-qa', 'release-review'] as StepId[]) { await e.runStep(id); }
    expect(status(e, 'upgrade-qa')).toBe('skipped');
    expect(e.blockReason('promotion')?.code).toBe('APPROVAL_REQUIRED');
    expect(e.blockReason('promotion', { approved: true })).toBeUndefined();
  });

  it('cancels a running step locally', async () => {
    const e = make({
      preflight: ctx => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    });
    const p = e.runStep('preflight');
    expect(e.cancel('preflight')).toBe(true);
    await p;
    expect(status(e, 'preflight')).toBe('cancelled');
  });

  it('marks a local timeout as needs-review, not failed', async () => {
    const e = make({ preflight: () => new Promise(() => undefined) }, new MemStore(), { stepTimeoutMs: 20 });
    await e.runStep('preflight');
    expect(status(e, 'preflight')).toBe('needs-review');
  });

  it('refuses to run in an untrusted workspace', async () => {
    const e = make({ preflight: pass }, new MemStore(), { canExecute: () => ({ allowed: false, reason: 'untrusted' }) });
    const res = await e.runStep('preflight');
    expect(res.ok === false && res.code).toBe('NOT_PERMITTED');
  });

  it('restores state after restart and flags interrupted runs', async () => {
    const store = new MemStore();
    const e1 = make({ preflight: pass, source: () => new Promise(() => undefined) }, store);
    await e1.runStep('preflight');
    void e1.runStep('source');
    const e2 = make({}, store);
    expect(status(e2, 'preflight')).toBe('passed');
    expect(status(e2, 'source')).toBe('needs-review');
    expect(e2.getState().run.steps.source.failure?.code).toBe('INTERRUPTED');
  });

  it('archives runs into history', async () => {
    const e = make({ preflight: pass });
    await e.runStep('preflight');
    expect(e.startNewRun()).toBe(true);
    const s = e.getState();
    expect(s.history).toHaveLength(1);
    expect(s.history[0].passedSteps).toEqual(['preflight']);
    expect(s.run.steps.preflight.status).toBe('pending');
  });

  it('resume stops at the first step that does not pass', async () => {
    const e = make({ preflight: pass, source: async () => ({ status: 'failed', failure: { code: 'X', message: 'bad' } }), analysis: pass });
    const res = await e.resume();
    expect(res).toEqual({ ok: true, stoppedAt: 'source' });
    expect(status(e, 'analysis')).toBe('pending');
  });
});

describe('FileStateStore', () => {
  it('round-trips and quarantines corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
    const file = path.join(dir, 'state.json');
    const e = make({ preflight: pass }, new FileStateStore(file));
    void e.runStep('preflight');
    expect(new FileStateStore(file).load()?.schemaVersion).toBe(1);
    fs.writeFileSync(file, '{not json');
    expect(new FileStateStore(file).load()).toBeUndefined();
    expect(fs.readdirSync(dir).some(f => f.includes('.corrupt-'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('redact', () => {
  it('removes tokens, auth urls and installation keys', () => {
    expect(redact('force://PlatformCLI::abc@x.my.salesforce.com')).not.toContain('abc@');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain('[REDACTED]');
    expect(redact('sf package install --installation-key hunter2')).not.toContain('hunter2');
  });
});

describe('webview message validation', () => {
  it('accepts valid and rejects invalid messages', () => {
    expect(parseMessage({ type: 'run', stepId: 'preflight' })).toBeDefined();
    expect(parseMessage({ type: 'run', stepId: 'rm -rf' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'coverageTargetPercent', value: 80 })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'coverageTargetPercent', value: 500 })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: '__proto__', value: 1 })).toBeUndefined();
    expect(parseMessage({ type: 'nope' })).toBeUndefined();
    expect(parseMessage(null)).toBeUndefined();
  });
});
