import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { ProcessRunner, RunRequest, RunResult } from '../adapters/processRunner';
import { SfCli } from '../adapters/sfCli';
import { Logger } from '../core/logger';
import { StepContext, StepExecutor, WorkflowState } from '../core/models';
import { redact } from '../core/redact';
import { DiscoveryService, DiscoverySnapshot } from '../discovery/discoveryService';
import { parseProject } from '../discovery/project';
import { QaDeps, QaSettings, createQaExecutors } from '../executors/qa';
import { ReportWriter } from '../executors/reportWriter';
import { StateStore } from '../engine/stateStore';
import { WorkflowEngine } from '../engine/workflowEngine';
import { ExistingVersion } from '../packaging/parsers';
import { PackagingStore } from '../packaging/store';
import { buildCreateScratchArgs, buildInstallArgs, installPackage, pollInstall, runApexFile, assignPermsets } from '../qa/ops';
import { parseInstallResult, parseInstalledList, parseScratchCreate, parseScratchOrgs } from '../qa/parsers';
import { validateScratchDefinition } from '../qa/scratchDef';
import { QaEnvironment, QaStore, checklistStatus, makeChecklist } from '../qa/store';
import { requiredPhases, signOffBlockers } from '../qa/signoff';
import { assertBaselineReleased, evaluateUpgradePath } from '../qa/upgradePath';
import { parseMessage } from '../ui/messages';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp5-'));
const done = (stdout = '', exitCode: number | null = 0): RunResult =>
  ({ exitCode, stdout, stderr: '', durationMs: 1, timedOut: false, aborted: false, truncated: false });
const env = (result: unknown) => done(JSON.stringify({ status: 0, result }));
const err = (name: string, message: string, result?: unknown) => done(JSON.stringify({ status: 1, name, message, result }), 1);

class FakeRunner implements ProcessRunner {
  calls: RunRequest[] = [];
  constructor(public handler: (req: RunRequest) => RunResult) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    return this.handler(req);
  }
}

const PKG = '0Ho000000000001AAA';
const REL = '04t000000000001AAA';   // released ancestor
const CAND = '04t000000000009AAA';  // candidate beta

// ---------------------------------------------------------------- scratch definition
describe('validateScratchDefinition', () => {
  const root = tmp();
  const write = (name: string, body: unknown) => {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', name), typeof body === 'string' ? body : JSON.stringify(body));
    return `config/${name}`;
  };
  it('accepts a normal definition', () => {
    expect(validateScratchDefinition(root, write('ok.json', { orgName: 'x', edition: 'Developer', features: ['Communities'], settings: {} })).ok).toBe(true);
  });
  it('rejects missing, malformed, unknown-edition and bad-feature definitions', () => {
    expect(validateScratchDefinition(root, 'config/none.json').ok).toBe(false);
    expect(validateScratchDefinition(root, write('bad.json', '{nope')).ok).toBe(false);
    expect(validateScratchDefinition(root, write('ed.json', { edition: 'Galaxy' })).ok).toBe(false);
    expect(validateScratchDefinition(root, write('noed.json', {})).ok).toBe(false);
    expect(validateScratchDefinition(root, write('feat.json', { edition: 'Developer', features: ['ok', 'bad feature!'] })).ok).toBe(false);
    expect(validateScratchDefinition(root, write('arr.json', [1])).ok).toBe(false);
  });
  it('accepts snapshot-based orgs, warns on namespace/duplicates/no features, and refuses escaping paths', () => {
    expect(validateScratchDefinition(root, write('snap.json', { snapshot: 'MySnap' })).ok).toBe(true);
    const w = validateScratchDefinition(root, write('warn.json', { edition: 'Enterprise', namespace: 'ns', features: ['A', 'A'] }));
    expect(w.ok).toBe(true);
    expect(w.checks.filter(c => c.status === 'warn').map(c => c.name)).toEqual(expect.arrayContaining(['Namespace', 'Features']));
    expect(validateScratchDefinition(root, write('nofeat.json', { edition: 'Developer' })).checks.some(c => c.name === 'Features' && c.status === 'warn')).toBe(true);
    expect(validateScratchDefinition(root, '../outside.json').ok).toBe(false);
    expect(validateScratchDefinition(root, path.resolve(os.tmpdir(), 'x.json')).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- parsers (shapes from a real org where possible)
describe('QA parsers', () => {
  it('reads scratch create results without tokens', () => {
    const r = parseScratchCreate({ orgId: '00D000000000009', username: 'test@x.com', accessToken: 'SECRET', instanceUrl: 'https://x', scratchOrgInfo: { ExpirationDate: '2026-11-01' } });
    expect(r).toEqual({ orgId: '00D000000000009', username: 'test@x.com', expirationDate: '2026-11-01' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(parseScratchCreate({})).toBeUndefined();
  });
  it('reads install results in the shapes the CLI produces', () => {
    expect(parseInstallResult({ Id: '0Hf000000000001AAA', Status: 'SUCCESS', SubscriberPackageVersionKey: CAND })).toMatchObject({ requestId: '0Hf000000000001AAA', status: 'SUCCESS' });
    expect(parseInstallResult({ Id: '0Hf1', Status: 'ERROR', Errors: { errors: [{ message: 'Missing feature X' }] } }).errors).toEqual(['Missing feature X']);
    expect(parseInstallResult([{ Id: '0Hf1', status: 'in_progress' }]).status).toBe('IN_PROGRESS');
    expect(parseInstallResult({}).status).toBe('UNKNOWN');
  });
  it('reads the real `package installed list` shape and `org list` scratch entries', () => {
    const real = [{ Id: '0A3', SubscriberPackageId: '033', SubscriberPackageName: 'P', SubscriberPackageNamespace: 'ns', SubscriberPackageVersionId: CAND, SubscriberPackageVersionName: 'v', SubscriberPackageVersionNumber: '1.7.0.1', VersionSettings: [] }];
    expect(parseInstalledList(real)[0]).toMatchObject({ versionId: CAND, versionNumber: '1.7.0.1', namespace: 'ns' });
    const orgs = parseScratchOrgs({ scratchOrgs: [{ alias: 'a', username: 'u@x.com', orgId: '00D1', accessToken: 'SECRET', devHubOrgId: '00D0' }, { bogus: 1 }] });
    expect(orgs).toHaveLength(1);
    expect(JSON.stringify(orgs)).not.toContain('SECRET');
  });
  it('redacts session URLs', () => {
    expect(redact('https://x.my.salesforce.com/secur/frontdoor.jsp?sid=00Dxx!ABCDEF&retURL=/home')).not.toContain('ABCDEF');
  });
});

// ---------------------------------------------------------------- command construction
describe('scratch / install command construction', () => {
  const base = { hub: 'hub', alias: 'rp-qa-1', definitionFile: '/p/config/def.json', durationDays: 7, waitMinutes: 30 };
  it('always creates a namespace-free, non-default, untracked org', () => {
    const a = buildCreateScratchArgs(base);
    expect(a.slice(0, 3)).toEqual(['org', 'create', 'scratch']);
    expect(a).toEqual(expect.arrayContaining(['--no-namespace', '--no-track-source', '--target-dev-hub', 'hub', '--alias', 'rp-qa-1', '--duration-days', '7']));
    expect(a).not.toContain('--set-default');
    expect(() => buildCreateScratchArgs({ ...base, alias: '--evil' })).toThrow();
    expect(() => buildCreateScratchArgs({ ...base, definitionFile: '--x' })).toThrow();
    expect(buildCreateScratchArgs({ ...base, durationDays: 99 })).toContain('30');
  });
  it('builds a non-interactive install, validates the key, keeps it out of history', async () => {
    const a = buildInstallArgs({ org: 'qa', versionId: CAND, waitMinutes: 20, securityType: 'AdminsOnly' });
    expect(a).toEqual(expect.arrayContaining(['--package', CAND, '--target-org', 'qa', '--no-prompt', '--security-type', 'AdminsOnly']));
    expect(() => buildInstallArgs({ org: 'qa', versionId: 'bad', waitMinutes: 1, securityType: 'AdminsOnly' })).toThrow();
    expect(() => buildInstallArgs({ org: 'qa', versionId: CAND, key: 'has space', waitMinutes: 1, securityType: 'AdminsOnly' })).toThrow();
    const history = new CommandHistory();
    const sf = new SfCli(new FakeRunner(() => env({ Id: '0Hf000000000001AAA', Status: 'SUCCESS' })), history, { command: 'sf', prefixArgs: [] });
    await installPackage(sf, { org: 'qa', versionId: CAND, key: 'TopSecret99', waitMinutes: 5, securityType: 'AllUsers' }, { root: '.' });
    expect(history.list()[0].display).not.toContain('TopSecret99');
  });
  it('recovers a running install from the error payload and polls it', async () => {
    const sf = new SfCli(new FakeRunner(() => err('PackageInstallTimeout', 'still running', { Id: '0Hf000000000002AAA', Status: 'IN_PROGRESS' })), new CommandHistory(), { command: 'sf', prefixArgs: [] });
    expect((await installPackage(sf, { org: 'qa', versionId: CAND, waitMinutes: 1, securityType: 'AdminsOnly' }, { root: '.' })).requestId).toBe('0Hf000000000002AAA');
    const seq = ['IN_PROGRESS', 'SUCCESS'];
    const poller = new SfCli(new FakeRunner(() => env({ Id: '0Hf000000000002AAA', Status: seq.shift() ?? 'SUCCESS' })), new CommandHistory(), { command: 'sf', prefixArgs: [] });
    const out = await pollInstall(poller, 'qa', '0Hf000000000002AAA', { root: '.' }, { intervalMs: 1, timeoutMs: 1000, sleep: async () => undefined });
    expect(out.result.status).toBe('SUCCESS');
  });
  it('validates permission sets and treats a thrown script as a failure', async () => {
    const sf = new SfCli(new FakeRunner(() => env({ success: false, compiled: true, exceptionMessage: 'System.NullPointerException' })), new CommandHistory(), { command: 'sf', prefixArgs: [] });
    await expect(assignPermsets(sf, 'qa', ['Good_Name', 'bad name; rm'], { root: '.' })).rejects.toThrow(/Invalid permission set/);
    await expect(runApexFile(sf, 'qa', 'scripts/seed.apex', { root: '.' })).rejects.toThrow(/NullPointer/);
    await expect(runApexFile(sf, 'qa', '--evil', { root: '.' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- upgrade path rules
describe('evaluateUpgradePath', () => {
  const v = (over: Partial<ExistingVersion> & { version: string }): ExistingVersion => ({ isReleased: false, ...over });
  const released = v({ version: '1.2.0.4', isReleased: true, subscriberPackageVersionId: REL, packageVersionId: '05i000000000001' });
  const beta = (extra: Partial<ExistingVersion> = {}) => v({ version: '1.3.0.1', subscriberPackageVersionId: CAND, packageVersionId: '05i000000000009', ancestorId: '05i000000000001', ...extra });
  it('supports released -> beta when the candidate descends from the released version', () => {
    const p = evaluateUpgradePath([released, beta()], CAND);
    expect(p.state).toBe('supported');
    expect(p.baseline?.subscriberPackageVersionId).toBe(REL);
  });
  it('is not applicable for a new product', () => {
    expect(evaluateUpgradePath([beta({ ancestorId: undefined })], CAND).state).toBe('not-applicable');
  });
  it('blocks when there is no ancestor, an unresolvable ancestor, or a beta ancestor', () => {
    const noAnc = evaluateUpgradePath([released, beta({ ancestorId: undefined })], CAND);
    expect(noAnc.state).toBe('unsupported');
    expect(noAnc.alternative).toMatch(/ancestorId/);
    expect(evaluateUpgradePath([released, beta({ ancestorId: '05i999' })], CAND).state).toBe('unsupported');
    const betaAnc = v({ version: '1.2.5.1', subscriberPackageVersionId: '04t000000000005AAA', packageVersionId: '05i000000000005' });
    const p = evaluateUpgradePath([released, betaAnc, beta({ ancestorId: '05i000000000005' })], CAND);
    expect(p.state).toBe('unsupported');
    expect(p.reason).toMatch(/beta/i);
  });
  it('blocks an unknown or already-released target and refuses beta baselines outright', () => {
    expect(evaluateUpgradePath([released], '04t000000000099AAA').state).toBe('unsupported');
    expect(evaluateUpgradePath([released, v({ version: '1.3.0.1', isReleased: true, subscriberPackageVersionId: CAND })], CAND).state).toBe('unsupported');
    expect(() => assertBaselineReleased(v({ version: '1.0.0.1' }))).toThrow(/cannot be upgraded/);
  });
});

// ---------------------------------------------------------------- checklist, store, engine manual results
describe('manual QA primitives', () => {
  it('passes only when every item is explicitly pass', () => {
    const items = makeChecklist(['a', 'b']);
    expect(checklistStatus(items)).toBe('pending');
    items[0].state = 'pass';
    expect(checklistStatus(items)).toBe('pending');
    items[1].state = 'pass';
    expect(checklistStatus(items)).toBe('pass');
    items[1].state = 'fail';
    expect(checklistStatus(items)).toBe('fail');
    expect(checklistStatus([])).toBe('pending');
  });
  it('QaStore persists and only resumes open environments', () => {
    const file = path.join(tmp(), 'qa.json');
    const s = new QaStore(file);
    const base = { id: 'e1', kind: 'fresh-install' as const, alias: 'a', devHubOrgId: '00D1', devHubAlias: 'h', packageId: PKG, packageName: 'P', targetVersionId: CAND, sourceFingerprint: 'fp', status: 'ready' as const, createdAt: 'now', durationDays: 7, definitionFile: 'x', permsets: [], phases: {}, smoke: [], logRefs: [], checklist: [] };
    s.save(base);
    expect(new QaStore(file).resumable('fresh-install', CAND, '00D1')?.id).toBe('e1');
    expect(s.resumable('upgrade', CAND, '00D1')).toBeUndefined();
    s.save({ ...base, status: 'failed' });
    expect(s.resumable('fresh-install', CAND, '00D1')).toBeUndefined();
    s.save({ ...base, signoff: { approver: 'x', at: 'now' } });
    expect(s.resumable('fresh-install', CAND, '00D1')).toBeUndefined();
  });
});

describe('signOffBlockers', () => {
  const readyEnv = (over: Partial<QaEnvironment> = {}): QaEnvironment => {
    const phases: QaEnvironment['phases'] = {};
    for (const p of requiredPhases('fresh-install')) { phases[p] = { status: 'done' }; }
    const checklist = makeChecklist(['a', 'b']);
    checklist.forEach(c => { c.state = 'pass'; });
    return { id: 'e', kind: 'fresh-install', alias: 'a', devHubOrgId: 'h', devHubAlias: 'h', packageId: PKG, packageName: 'P', targetVersionId: CAND, sourceFingerprint: 'fp', status: 'ready', createdAt: 'now', durationDays: 7, definitionFile: 'x', permsets: [], phases, smoke: [], logRefs: [], checklist, verifiedInstalledVersion: '1.3.0.1', ...over };
  };
  it('allows a fully verified, unchanged environment', () => {
    expect(signOffBlockers(readyEnv(), 'fp')).toEqual([]);
  });
  it('refuses on each missing condition', () => {
    expect(signOffBlockers(readyEnv(), 'changed').join()).toMatch(/source changed/);
    expect(signOffBlockers(readyEnv(), undefined).join()).toMatch(/source changed/);
    expect(signOffBlockers(readyEnv({ status: 'failed' }), 'fp').join()).toMatch(/failed/);
    expect(signOffBlockers(readyEnv({ signoff: { approver: 'x', at: 'now' } }), 'fp').join()).toMatch(/already/);
    expect(signOffBlockers(readyEnv({ phases: { create: { status: 'done' } } }), 'fp').join()).toMatch(/incomplete/);
    expect(signOffBlockers(readyEnv({ smoke: [{ name: 's', status: 'fail', detail: 'x' }] }), 'fp').join()).toMatch(/automated check/);
    expect(signOffBlockers(readyEnv({ verifiedInstalledVersion: undefined }), 'fp').join()).toMatch(/not been verified/);
    const pending = readyEnv();
    pending.checklist[1].state = 'pending';
    expect(signOffBlockers(pending, 'fp').join()).toMatch(/explicitly marked Pass/);
    const failedItem = readyEnv();
    failedItem.checklist[0].state = 'fail';
    expect(signOffBlockers(failedItem, 'fp').join()).toMatch(/marked Fail/);
    expect(signOffBlockers(readyEnv({ checklist: [] }), 'fp').length).toBeGreaterThan(0);
  });
  it('requires the baseline and seed phases for upgrade tests', () => {
    expect(requiredPhases('upgrade')).toEqual(expect.arrayContaining(['baseline', 'seed']));
    expect(requiredPhases('fresh-install')).not.toContain('baseline');
    expect(signOffBlockers(readyEnv({ kind: 'upgrade' }), 'fp').join()).toMatch(/baseline/);
  });
});

describe('engine.applyManualResult', () => {
  class Mem implements StateStore { saved?: WorkflowState; load() { return this.saved; } save(s: WorkflowState) { this.saved = JSON.parse(JSON.stringify(s)) as WorkflowState; } }
  const ev = [{ id: 'e', kind: 'qa-signoff', label: 'signed', ref: 'x.json', createdAt: 'now' }];
  const prepared = async () => {
    const needsReview: StepExecutor = async () => ({ status: 'needs-review', evidence: ev });
    const ok: StepExecutor = async () => ({ status: 'passed', evidence: ev });
    const e = new WorkflowEngine({ store: new Mem(), logger: new Logger(), executors: { preflight: ok, source: ok, analysis: ok, tests: ok, 'package-readiness': ok, 'package-build': ok, 'clean-install-qa': needsReview } });
    for (const id of ['preflight', 'source', 'analysis', 'tests', 'package-readiness', 'package-build', 'clean-install-qa'] as const) { await e.runStep(id); }
    return e;
  };
  it('resolves a needs-review step with signed evidence, and rejects everything else', async () => {
    const e = await prepared();
    expect(e.getState().run.steps['clean-install-qa'].status).toBe('needs-review');
    expect(e.applyManualResult('clean-install-qa', { status: 'passed' })).toMatchObject({ ok: false, code: 'EVIDENCE_MISSING' });
    expect(e.applyManualResult('clean-install-qa', { status: 'needs-review' as never, evidence: ev })).toMatchObject({ ok: false, code: 'INVALID_RESULT' });
    expect(e.applyManualResult('package-build', { status: 'passed', evidence: ev })).toMatchObject({ ok: false, code: 'NOT_AWAITING_REVIEW' });
    expect(e.applyManualResult('clean-install-qa', { status: 'passed', evidence: ev, message: 'signed' })).toEqual({ ok: true });
    expect(e.getState().run.steps['clean-install-qa'].status).toBe('passed');
    expect(e.applyManualResult('clean-install-qa', { status: 'passed', evidence: ev })).toMatchObject({ ok: false });
  });
  it('records a manual failure with its reason', async () => {
    const e = await prepared();
    e.applyManualResult('clean-install-qa', { status: 'failed', failure: { code: 'QA_FAILED', message: 'Button broken' } });
    const s = e.getState().run.steps['clean-install-qa'];
    expect(s.status).toBe('failed');
    expect(s.failure?.message).toBe('Button broken');
  });
});

// ---------------------------------------------------------------- executors against a stateful mocked CLI
const hubOrg = { orgId: '00D000000000001', username: 'hub@x.com', alias: 'hub', isDevHub: true, isScratch: false, isSandbox: false, tracksSource: false, isDefaultDevHub: true, isDefaultOrg: false, expired: false };

interface Sim {
  versions: unknown[];
  scratchOrgs: unknown[];
  installed: Array<{ SubscriberPackageVersionId: string; SubscriberPackageVersionNumber: string }>;
  createResponse: () => RunResult;
  installResponse: (versionId: string, n: number) => RunResult;
  reportStatuses: string[];
  assigned: string[];
  apexFail: Set<string>;
}

function setup(over: { kind?: 'fresh' | 'upgrade'; settings?: Partial<QaSettings>; candidateKeyMode?: 'key' | 'bypass'; confirm?: boolean; sim?: Partial<Sim>; dirDeps?: object[]; fp?: string; noDef?: boolean; askKey?: { key?: string } | undefined } = {}) {
  const dir = tmp();
  if (!over.noDef) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'project-scratch-def.json'), JSON.stringify({ edition: 'Developer', features: [] }));
  }
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of ['init.apex', 'smoke.apex', 'seed.apex', 'regress.apex']) { fs.writeFileSync(path.join(dir, 'scripts', f), 'System.debug(1);'); }
  let installCount = 0;
  const sim: Sim = {
    versions: [
      { Version: '1.2.0.4', IsReleased: true, SubscriberPackageVersionId: REL, Id: '05i000000000001', IsPasswordProtected: false },
      { Version: '1.3.0.1', IsReleased: false, SubscriberPackageVersionId: CAND, Id: '05i000000000009', AncestorId: '05i000000000001' }
    ],
    scratchOrgs: [], installed: [], reportStatuses: ['SUCCESS'], assigned: ['QAPerm'], apexFail: new Set(),
    createResponse: () => env({ orgId: '00D000000000AAA', username: 'qa@scratch.x', accessToken: 'SHOULD-NOT-LEAK', scratchOrgInfo: { ExpirationDate: '2026-11-01' } }),
    installResponse: () => env({ Id: '0Hf000000000001AAA', Status: 'SUCCESS' }),
    ...over.sim
  };
  const runner = new FakeRunner(req => {
    const a = req.args;
    if (a[0] === 'org' && a[1] === 'list') { return env({ scratchOrgs: sim.scratchOrgs }); }
    if (a[0] === 'org' && a[1] === 'create') { return sim.createResponse(); }
    if (a[0] === 'package' && a[1] === 'version' && a[2] === 'list') { return env(sim.versions); }
    if (a[0] === 'package' && a[1] === 'installed') { return env(sim.installed); }
    if (a[0] === 'package' && a[1] === 'install' && a[2] === 'report') { return env({ Id: '0Hf000000000001AAA', Status: sim.reportStatuses.length > 1 ? sim.reportStatuses.shift() : sim.reportStatuses[0] }); }
    if (a[0] === 'package' && a[1] === 'install') {
      const versionId = a[a.indexOf('--package') + 1];
      const res = sim.installResponse(versionId, ++installCount);
      const body = JSON.parse(res.stdout) as { status: number; result?: { Status?: string } };
      if (body.status === 0 && body.result?.Status === 'SUCCESS') { sim.installed.push({ SubscriberPackageVersionId: versionId, SubscriberPackageVersionNumber: versionId === CAND ? '1.3.0.1' : '1.2.0.4' }); }
      return res;
    }
    if (a[0] === 'org' && a[1] === 'assign') { return env({ successes: [] }); }
    if (a[0] === 'data' && a[1] === 'query') { return env({ records: sim.assigned.map(n => ({ PermissionSet: { Name: n } })) }); }
    if (a[0] === 'apex') { return env({ success: !sim.apexFail.has(a[a.indexOf('--file') + 1].split(/[\\/]/).pop() ?? ''), compiled: true, exceptionMessage: 'boom' }); }
    if (a[0] === 'org' && a[1] === 'open') { return done('Opening org'); }
    return done();
  });
  const sf = new SfCli(runner, new CommandHistory(), { command: 'sf', prefixArgs: [] });
  const dependencies = over.dirDeps ?? [];
  const proj = parseProject(dir, JSON.stringify({ packageDirectories: [{ path: 'force-app', package: 'P', versionNumber: '1.3.0.NEXT', ancestorId: 'HIGHEST', dependencies }], packageAliases: { P: PKG, DepA: REL.replace('001', '0A1') } }), () => true);
  const snapshot = { devHub: hubOrg, selectedPackage: { id: PKG, name: 'P', containerOptions: 'Managed' }, project: proj } as unknown as DiscoverySnapshot;
  const packaging = new PackagingStore(path.join(dir, 'pk.json'));
  packaging.upsert({ requestId: '08c1', packageId: PKG, packageName: 'P', devHubOrgId: hubOrg.orgId, devHubAlias: 'hub', versionNumber: '1.3.0.NEXT', status: 'Success', subscriberPackageVersionId: CAND, errors: [], sourceFingerprint: 'fp', keyMode: over.candidateKeyMode ?? 'bypass', createdAt: 'now', hasPassedCodeCoverageCheck: true, coveragePercent: 82 });
  const qa = new QaStore(path.join(dir, 'qa.json'));
  let confirms = 0;
  let keyAsks = 0;
  const deps: QaDeps = {
    sf, discovery: { snapshot } as unknown as DiscoveryService, reports: new ReportWriter(path.join(dir, 'r')), qa, packaging, getRoot: () => dir,
    git: async () => ({ isRepo: true, files: [], fingerprint: over.fp ?? 'fp' }),
    settings: () => ({ definitionFile: 'config/project-scratch-def.json', durationDays: 7, waitMinutes: 5, pollSeconds: 1, securityType: 'AdminsOnly', permissionSets: ['QAPerm'], initScripts: ['scripts/init.apex'], smokeScripts: ['scripts/smoke.apex'], seedScripts: ['scripts/seed.apex'], regressionScripts: ['scripts/regress.apex'], openOrgAfterInstall: true, checklist: [], upgradeChecklist: [], aliasPrefix: 'rp', ...over.settings }),
    confirm: async () => { confirms++; return over.confirm ?? true; },
    askKey: async () => { keyAsks++; return 'askKey' in over ? over.askKey : { key: 'InstallKey123' }; },
    sleep: async () => undefined
  };
  const ex = createQaExecutors(deps);
  const ctx: StepContext = { runId: 'r', signal: new AbortController().signal, log: () => undefined };
  const sub = (a: string[]) => runner.calls.filter(c => a.every((x, i) => c.args[i] === x));
  return { ...ex, ctx, sim, qa, runner, dir, sub, confirms: () => confirms, keyAsks: () => keyAsks, packaging };
}

describe('clean-install QA executor', () => {
  it('prepares the environment but ends Needs Review, never Passed', async () => {
    const t = setup();
    const r = await t['clean-install-qa'](t.ctx);
    expect(r.status).toBe('needs-review');
    expect(r.message).toMatch(/Manual QA checklist and sign-off are still required/);
    const envs = t.qa.list();
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({ kind: 'fresh-install', status: 'ready', verifiedInstalledVersion: '1.3.0.1', username: 'qa@scratch.x' });
    for (const p of ['create', 'install', 'verify', 'permsets', 'scripts', 'smoke', 'open'] as const) { expect(envs[0].phases[p]?.status).toBe('done'); }
    expect(envs[0].checklist.length).toBeGreaterThan(3);
    expect(envs[0].checklist.every(i => i.state === 'pending')).toBe(true);
    const create = t.sub(['org', 'create'])[0].args;
    expect(create).toContain('--no-namespace');
    expect(create).not.toContain('--set-default');
    expect(envs[0].alias).toMatch(/^rp-p-qa-\d{12}-[0-9a-f]{4}$/);
    expect(t.sub(['package', 'install']).filter(c => c.args[2] !== 'report').map(c => c.args[c.args.indexOf('--package') + 1])).toEqual([CAND]);
    expect(t.sub(['org', 'open'])).toHaveLength(1);
    expect(t.sub(['apex'])).toHaveLength(2);
  });

  it('never persists or exports org tokens', async () => {
    const t = setup();
    const r = await t['clean-install-qa'](t.ctx);
    const files = [path.join(t.dir, 'qa.json'), ...(r.evidence ?? []).map(e => e.ref)];
    for (const f of files) { expect(fs.readFileSync(f, 'utf8')).not.toContain('SHOULD-NOT-LEAK'); }
  });

  it('does nothing remote when declined, when no current candidate exists, or when inputs are invalid', async () => {
    const declined = setup({ confirm: false });
    expect((await declined['clean-install-qa'](declined.ctx)).status).toBe('blocked');
    expect(declined.sub(['org', 'create'])).toHaveLength(0);
    const stale = setup({ fp: 'source-changed' });
    expect((await stale['clean-install-qa'](stale.ctx)).failure?.code).toBe('NO_CURRENT_CANDIDATE');
    const noDef = setup({ noDef: true });
    expect((await noDef['clean-install-qa'](noDef.ctx)).failure?.code).toBe('DEFINITION_INVALID');
    expect(noDef.sub(['org', 'create'])).toHaveLength(0);
    const badScript = setup({ settings: { initScripts: ['scripts/missing.apex'] } });
    expect((await badScript['clean-install-qa'](badScript.ctx)).failure?.code).toBe('SCRIPT_INVALID');
    const escape = setup({ settings: { initScripts: ['../evil.apex'] } });
    expect((await escape['clean-install-qa'](escape.ctx)).failure?.code).toBe('SCRIPT_INVALID');
    const badPerm = setup({ settings: { permissionSets: ['bad name'] } });
    expect((await badPerm['clean-install-qa'](badPerm.ctx)).failure?.code).toBe('PERMSET_INVALID');
    for (const t of [stale, noDef, badScript, escape, badPerm]) { expect(t.sub(['org', 'create'])).toHaveLength(0); }
  });

  it('asks for the installation key only when the build used one and never stores it', async () => {
    const t = setup({ candidateKeyMode: 'key' });
    const r = await t['clean-install-qa'](t.ctx);
    expect(r.status).toBe('needs-review');
    expect(t.keyAsks()).toBe(1);
    expect(t.sub(['package', 'install']).find(c => c.args.some(a => a.startsWith('--installation-key=')))).toBeDefined();
    for (const f of [path.join(t.dir, 'qa.json'), ...(r.evidence ?? []).map(e => e.ref)]) { expect(fs.readFileSync(f, 'utf8')).not.toContain('InstallKey123'); }
    const cancelled = setup({ candidateKeyMode: 'key', askKey: undefined });
    expect((await cancelled['clean-install-qa'](cancelled.ctx)).status).toBe('blocked');
    expect(cancelled.sub(['org', 'create'])).toHaveLength(0);
  });

  it('preserves the install log on failure and uses a NEW org on retry', async () => {
    const t = setup({ sim: { installResponse: () => env({ Id: '0Hf000000000001AAA', Status: 'ERROR', Errors: { errors: [{ message: 'Required feature Communities is missing' }] } }) } });
    const r = await t['clean-install-qa'](t.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('INSTALL_FAILED');
    expect(r.failure?.detail).toMatch(/Communities/);
    const logs = (r.evidence ?? []).filter(e => e.kind === 'package-install-log');
    expect(logs).toHaveLength(1);
    expect(fs.readFileSync(logs[0].ref, 'utf8')).toMatch(/Communities/);
    expect(t.qa.list()[0]).toMatchObject({ status: 'failed', failedPhase: 'install' });
    t.sim.installResponse = () => env({ Id: '0Hf000000000002AAA', Status: 'SUCCESS' });
    const retry = await t['clean-install-qa'](t.ctx);
    expect(retry.status).toBe('needs-review');
    expect(t.sub(['org', 'create'])).toHaveLength(2);
    expect(new Set(t.qa.list().map(e => e.alias)).size).toBe(2);
    expect(t.sub(['org', 'delete'])).toHaveLength(0);
  });

  it('fails verification when the 04t is not actually installed, and when automated checks fail', async () => {
    const t = setup({ sim: { installResponse: () => env({ Id: '0Hf000000000001AAA', Status: 'SUCCESS' }) } });
    t.runner.handler = (orig => (req: RunRequest) => (req.args[1] === 'installed' ? env([]) : orig(req)))(t.runner.handler);
    expect((await t['clean-install-qa'](t.ctx)).failure?.code).toBe('VERIFY_FAILED');
    const perm = setup({ sim: { assigned: [] } });
    const r = await perm['clean-install-qa'](perm.ctx);
    expect(r.failure?.code).toBe('SMOKE_FAILED');
    expect(r.failure?.detail).toMatch(/Not assigned: QAPerm/);
    const script = setup({ sim: { apexFail: new Set(['smoke.apex']) } });
    expect((await script['clean-install-qa'](script.ctx)).failure?.code).toBe('SMOKE_FAILED');
  });

  it('resumes after an install timeout without a second org or second install', async () => {
    const t = setup({ sim: { installResponse: () => err('Timeout', 'in progress', { Id: '0Hf000000000007AAA', Status: 'IN_PROGRESS' }), reportStatuses: ['IN_PROGRESS'] }, settings: { waitMinutes: 0 } });
    const first = await t['clean-install-qa'](t.ctx);
    expect(first.status).toBe('needs-review');
    expect(first.failure?.code).toBe('INSTALL_STILL_RUNNING');
    expect(t.qa.list()[0].status).toBe('ready');
    t.sim.reportStatuses.splice(0, 1, 'SUCCESS');
    t.sim.installed.push({ SubscriberPackageVersionId: CAND, SubscriberPackageVersionNumber: '1.3.0.1' });
    const second = await t['clean-install-qa'](t.ctx);
    expect(second.status).toBe('needs-review');
    expect(second.failure).toBeUndefined();
    expect(t.sub(['org', 'create'])).toHaveLength(1);
    expect(t.sub(['package', 'install']).filter(c => c.args[2] !== 'report')).toHaveLength(1);
    expect(t.confirms()).toBe(1);
  });

  it('adopts an org found by alias after an interrupted creation instead of creating another', async () => {
    const t = setup();
    t.qa.save({ id: 'old', kind: 'fresh-install', alias: 'rp-p-qa-interrupted', devHubOrgId: hubOrg.orgId, devHubAlias: 'hub', packageId: PKG, packageName: 'P', targetVersionId: CAND, sourceFingerprint: 'fp', status: 'creating', createdAt: 'now', durationDays: 7, definitionFile: 'x', permsets: [], phases: { definition: { status: 'done' } }, smoke: [], logRefs: [], checklist: makeChecklist(['a']) });
    t.sim.scratchOrgs.push({ alias: 'rp-p-qa-interrupted', username: 'late@scratch.x', orgId: '00D000000000BBB', devHubOrgId: hubOrg.orgId });
    const r = await t['clean-install-qa'](t.ctx);
    expect(r.status).toBe('needs-review');
    expect(t.sub(['org', 'create'])).toHaveLength(0);
    expect(t.qa.get('old')).toMatchObject({ username: 'late@scratch.x', status: 'ready' });
    const lost = setup();
    lost.qa.save({ ...t.qa.get('old')!, id: 'lost', alias: 'rp-p-qa-never-created', username: undefined, orgId: undefined, status: 'creating', phases: { definition: { status: 'done' } } });
    await lost['clean-install-qa'](lost.ctx);
    expect(lost.qa.get('lost')?.status).toBe('failed');
    expect(lost.sub(['org', 'create'])).toHaveLength(1);
  });

  it('surfaces scratch org creation failures such as an exhausted allocation', async () => {
    const t = setup({ sim: { createResponse: () => err('LimitError', 'ScratchOrgInfo limit exceeded: you have reached the active scratch org limit') } });
    const r = await t['clean-install-qa'](t.ctx);
    expect(r.failure?.code).toBe('CREATE_FAILED');
    expect(r.failure?.remediation).toMatch(/never deletes orgs without your confirmation/);
  });

  it('installs declared dependencies first, skipping ones already present', async () => {
    const depA = '04t000000000A01AAA';
    const t = setup({ dirDeps: [{ package: 'DepA', subscriberPackageVersionId: depA }] });
    await t['clean-install-qa'](t.ctx);
    const order = t.sub(['package', 'install']).filter(c => c.args[2] !== 'report').map(c => c.args[c.args.indexOf('--package') + 1]);
    expect(order).toEqual([depA, CAND]);
    const pre = setup({ dirDeps: [{ package: 'DepA', subscriberPackageVersionId: depA }] });
    pre.sim.installed.push({ SubscriberPackageVersionId: depA, SubscriberPackageVersionNumber: '1.0.0.1' });
    await pre['clean-install-qa'](pre.ctx);
    expect(pre.sub(['package', 'install']).filter(c => c.args[2] !== 'report').map(c => c.args[c.args.indexOf('--package') + 1])).toEqual([CAND]);
    const unresolved = setup({ dirDeps: [{ package: 'Ghost' }] });
    expect((await unresolved['clean-install-qa'](unresolved.ctx)).failure?.code).toBe('DEPENDENCY_UNRESOLVED');
  });
});

describe('upgrade QA executor', () => {
  it('installs the released baseline, seeds data, upgrades to the candidate, then waits for manual QA', async () => {
    const t = setup();
    const r = await t['upgrade-qa'](t.ctx);
    expect(r.status).toBe('needs-review');
    const installs = t.sub(['package', 'install']).filter(c => c.args[2] !== 'report').map(c => c.args[c.args.indexOf('--package') + 1]);
    expect(installs).toEqual([REL, CAND]);
    const e = t.qa.list()[0];
    expect(e).toMatchObject({ kind: 'upgrade', baselineVersion: '1.2.0.4', verifiedInstalledVersion: '1.3.0.1' });
    expect(e.checklist[0].text).toMatch(/before the upgrade/);
    const order = t.runner.calls.map(c => c.args[0] === 'apex' ? `apex:${c.args[c.args.indexOf('--file') + 1].split(/[\\/]/).pop()}` : c.args[0] === 'package' && c.args[1] === 'install' && c.args[2] !== 'report' ? `install:${c.args[c.args.indexOf('--package') + 1]}` : '').filter(Boolean);
    expect(order.slice(0, 4)).toEqual([`install:${REL}`, 'apex:seed.apex', `install:${CAND}`, 'apex:regress.apex']);
  });

  it('asks for the released version\'s key when it is protected', async () => {
    const t = setup({ sim: { versions: [
      { Version: '1.2.0.4', IsReleased: true, SubscriberPackageVersionId: REL, Id: '05i000000000001', IsPasswordProtected: true },
      { Version: '1.3.0.1', IsReleased: false, SubscriberPackageVersionId: CAND, Id: '05i000000000009', AncestorId: '05i000000000001' }] } });
    await t['upgrade-qa'](t.ctx);
    expect(t.keyAsks()).toBe(1);
    expect(t.sub(['package', 'install']).find(c => c.args.includes(REL))!.args.some(a => a.startsWith('--installation-key='))).toBe(true);
  });

  it('blocks unsupported paths with an explanation and creates nothing; skips new products', async () => {
    const noAnc = setup({ sim: { versions: [{ Version: '1.2.0.4', IsReleased: true, SubscriberPackageVersionId: REL, Id: '05i000000000001' }, { Version: '1.3.0.1', IsReleased: false, SubscriberPackageVersionId: CAND, Id: '05i000000000009' }] } });
    const r = await noAnc['upgrade-qa'](noAnc.ctx);
    expect(r.status).toBe('blocked');
    expect(r.failure?.code).toBe('UPGRADE_PATH_UNSUPPORTED');
    expect(r.failure?.remediation).toMatch(/ancestorId/);
    expect(noAnc.sub(['org', 'create'])).toHaveLength(0);
    const brandNew = setup({ sim: { versions: [{ Version: '1.0.0.1', IsReleased: false, SubscriberPackageVersionId: CAND, Id: '05i000000000009' }] } });
    expect((await brandNew['upgrade-qa'](brandNew.ctx)).status).toBe('skipped');
    expect(brandNew.sub(['org', 'create'])).toHaveLength(0);
  });
});

describe('slice 5 message validation', () => {
  it('validates QA actions and settings', () => {
    expect(parseMessage({ type: 'qaMark', envId: 'abc-123', itemId: 'c2', state: 'pass' })).toBeDefined();
    expect(parseMessage({ type: 'qaMark', envId: 'abc-123', itemId: 'c2', state: 'maybe' })).toBeUndefined();
    expect(parseMessage({ type: 'qaMark', envId: 'abc 123', itemId: 'c2', state: 'pass' })).toBeUndefined();
    expect(parseMessage({ type: 'qaMark', envId: 'abc', itemId: '../x', state: 'pass' })).toBeUndefined();
    expect(parseMessage({ type: 'qaSignOff', envId: 'abc-123' })).toBeDefined();
    expect(parseMessage({ type: 'qaDelete', envId: 'a;b' })).toBeUndefined();
    expect(parseMessage({ type: 'qaOpen', envId: 'abc' })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'qaOrgDurationDays', value: 31 })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'qaOrgDurationDays', value: 7 })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'qaSecurityType', value: 'Everyone' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'openOrgAfterInstall', value: false })).toBeDefined();
  });
});
