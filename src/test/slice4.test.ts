import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { ProcessRunner, RunRequest, RunResult } from '../adapters/processRunner';
import { SfCli } from '../adapters/sfCli';
import { StepContext, StepId, StepStatus } from '../core/models';
import { DiscoveryService, DiscoverySnapshot } from '../discovery/discoveryService';
import { parseProject } from '../discovery/project';
import { PackagingDeps, PackagingSettings, createPackagingExecutors } from '../executors/packaging';
import { ReportWriter } from '../executors/reportWriter';
import { buildCreateArgs, pollRequest, startBuild } from '../packaging/build';
import { parseCoverage, parseCreateRequest, parseCreateRequestList, parseVersionList, parseVersionReport } from '../packaging/parsers';
import { ReadinessInput, evaluateReadiness } from '../packaging/readiness';
import { PackagingStore } from '../packaging/store';
import { compareMmp, parseVersion } from '../packaging/versions';
import { QualityStore } from '../testing/qualityStore';
import { parseMessage } from '../ui/messages';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp4-'));
const done = (stdout = '', exitCode: number | null = 0): RunResult =>
  ({ exitCode, stdout, stderr: '', durationMs: 1, timedOut: false, aborted: false, truncated: false });
const env = (result: unknown) => done(JSON.stringify({ status: 0, result }));

class FakeRunner implements ProcessRunner {
  calls: RunRequest[] = [];
  constructor(public handler: (req: RunRequest) => RunResult) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    return this.handler(req);
  }
}

const PKG = '0Ho000000000001AAA';
const V_REL = '04t000000000001AAA';

// ---------------------------------------------------------------- versions & parsers
describe('version numbers', () => {
  it('parses and compares major.minor.patch', () => {
    expect(parseVersion('1.4.0.NEXT')).toEqual({ major: 1, minor: 4, patch: 0, build: 'NEXT' });
    expect(parseVersion('1.4.0')?.build).toBe('NEXT');
    expect(parseVersion('1.4')).toBeUndefined();
    expect(parseVersion('1.x.0.NEXT')).toBeUndefined();
    expect(compareMmp(parseVersion('1.10.0')!, parseVersion('1.9.5')!)).toBeGreaterThan(0);
  });
});

describe('packaging parsers (shapes taken from a real Dev Hub)', () => {
  it('reads create requests, errors and coverage forms', () => {
    const r = parseCreateRequest({ Id: '08c000000000001AAA', Status: 'Error', Package2Id: PKG, Error: ['Missing ancestor', { message: 'Second' }], CodeCoverage: { apexCodeCoveragePercentage: 80 }, HasPassedCodeCoverageCheck: true });
    expect(r).toMatchObject({ requestId: '08c000000000001AAA', status: 'Error', errors: ['Missing ancestor', 'Second'], codeCoverage: 80, hasPassedCodeCoverageCheck: true });
    expect(parseCreateRequest({ nothing: 1 })).toBeUndefined();
    expect(parseCreateRequestList([{ Id: '08c1' }, { bogus: 1 }])).toHaveLength(1);
    expect(parseCoverage(82)).toBe(82);
    expect(parseCoverage('77%')).toBe(77);
    expect(parseCoverage(null)).toBeUndefined();
  });
  it('reads version reports given as object or single-element array', () => {
    const raw = { SubscriberPackageVersionId: V_REL, Package2Id: PKG, Version: '1.2.0.5', CodeCoverage: { apexCodeCoveragePercentage: 80 }, HasPassedCodeCoverageCheck: true, ValidationSkipped: false, IsReleased: false, AncestorId: '' };
    expect(parseVersionReport(raw)).toMatchObject({ version: '1.2.0.5', codeCoverage: 80, isReleased: false, validationSkipped: false });
    expect(parseVersionReport([raw])?.subscriberPackageVersionId).toBe(V_REL);
    expect(parseVersionReport({})).toBeUndefined();
    expect(parseVersionList([{ Version: '1.0.0.1', IsReleased: true, SubscriberPackageVersionId: V_REL }, {}])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- command construction
describe('buildCreateArgs', () => {
  const base = { packageId: PKG, devHub: 'hub' };
  it('always validates with coverage and never skips ancestry, validation or waits', () => {
    const a = buildCreateArgs({ ...base, installationKey: 'k3y', branch: 'main', tag: 'abc123' });
    expect(a.slice(0, 3)).toEqual(['package', 'version', 'create']);
    expect(a).toEqual(expect.arrayContaining(['--package', PKG, '--target-dev-hub', 'hub', '--code-coverage', '--branch', 'main', '--tag', 'abc123', '--installation-key=k3y']));
    for (const forbidden of ['--skip-validation', '--skip-ancestor-check', '--async-validation', '--wait', '-w', '--installation-key-bypass']) {
      expect(a).not.toContain(forbidden);
    }
    expect(buildCreateArgs({ ...base, bypassKey: true })).toContain('--installation-key-bypass');
  });
  it('requires exactly one key decision and validates every value', () => {
    expect(() => buildCreateArgs(base)).toThrow(/either an installation key/);
    expect(() => buildCreateArgs({ ...base, installationKey: 'a', bypassKey: true })).toThrow();
    expect(() => buildCreateArgs({ ...base, installationKey: 'has space' })).toThrow(/installation key/);
    expect(() => buildCreateArgs({ ...base, bypassKey: true, branch: 'bad branch; rm' })).toThrow(/branch/);
    expect(() => buildCreateArgs({ packageId: 'notanid', devHub: 'hub', bypassKey: true })).toThrow();
    expect(() => buildCreateArgs({ packageId: PKG, devHub: '--evil', bypassKey: true })).toThrow();
    expect(buildCreateArgs({ ...base, installationKey: '-leadingdash' })).toContain('--installation-key=-leadingdash');
  });
  it('keeps the installation key out of recorded commands', async () => {
    const history = new CommandHistory();
    const sf = new SfCli(new FakeRunner(() => env({ Id: '08c000000000001AAA', Status: 'Queued' })), history, { command: 'sf', prefixArgs: [] });
    await startBuild(sf, { ...base, installationKey: 'SuperSecretKey1' }, { root: '.' });
    expect(history.list()[0].display).not.toContain('SuperSecretKey1');
    expect(history.list()[0].display).toContain('--installation-key=[REDACTED]');
  });
});

// ---------------------------------------------------------------- readiness rules
describe('evaluateReadiness', () => {
  const project = (dirExtra: object = {}, aliases: Record<string, string> = { P: PKG }) =>
    parseProject('/p', JSON.stringify({ packageDirectories: [{ path: 'force-app', package: 'P', versionNumber: '1.3.0.NEXT', ...dirExtra }], packageAliases: aliases }), () => true);
  const input = (over: Partial<ReadinessInput> & { dirExtra?: object; aliases?: Record<string, string> } = {}): ReadinessInput => {
    const proj = project(over.dirExtra, over.aliases);
    return {
      project: proj, dir: proj.packageDirectories[0], pkg: { id: PKG, name: 'P', containerOptions: 'Managed' },
      versions: [{ version: '1.2.0.4', isReleased: true, subscriberPackageVersionId: V_REL }], requests: [],
      git: { isRepo: true, files: [], fingerprint: 'fp', head: 'abcdef123456', branch: 'main' }, allowDirty: false,
      analysisFingerprint: 'fp', testsFingerprint: 'fp', analysisPassed: true, testsPassed: true, dependencyLookup: {},
      ...over
    };
  };
  const fails = (i: ReadinessInput) => evaluateReadiness(i).filter(c => c.status === 'fail').map(c => c.name);

  it('passes a healthy release with HIGHEST ancestor', () => {
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST' } }))).toEqual([]);
  });
  it('requires an ancestor once a version is released, and validates the named one', () => {
    expect(fails(input())).toContain('Ancestry');
    expect(fails(input({ dirExtra: { ancestorId: 'NONE' } }))).toContain('Ancestry');
    expect(fails(input({ dirExtra: { ancestorId: V_REL } }))).toEqual([]);
    expect(fails(input({ dirExtra: { ancestorId: '04t000000000099AAA' } }))).toContain('Ancestry');
    expect(fails(input({ dirExtra: { ancestorVersion: '1.2.0.0' } }))).toEqual([]);
    expect(fails(input({ dirExtra: { ancestorVersion: '9.9.9.0' } }))).toContain('Ancestry');
    expect(fails(input({ versions: [] }))).toEqual([]);
  });
  it('rejects re-using a released or lower version number', () => {
    expect(fails(input({ dirExtra: { versionNumber: '1.2.0.NEXT', ancestorId: 'HIGHEST' } }))).toContain('Version number');
    expect(fails(input({ dirExtra: { versionNumber: '1.1.0.NEXT', ancestorId: 'HIGHEST' } }))).toContain('Version number');
    expect(fails(input({ dirExtra: { versionNumber: 'banana', ancestorId: 'HIGHEST' } }))).toContain('Version number');
  });
  it('rejects non-managed packages', () => {
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST' }, pkg: { id: PKG, name: 'P', containerOptions: 'Unlocked' } }))).toContain('Package type');
  });
  it('validates dependencies', () => {
    const ok = input({ dirExtra: { ancestorId: 'HIGHEST', dependencies: [{ package: 'Dep', versionNumber: '1.0.0.LATEST' }] }, aliases: { P: PKG, Dep: '0Ho000000000002AAA' } });
    expect(fails(ok)).toEqual([]);
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST', dependencies: [{ package: 'Ghost', versionNumber: '1.0.0.LATEST' }] } }))).toContain('Dependency Ghost');
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST', dependencies: [{ package: 'Dep' }] }, aliases: { P: PKG, Dep: '0Ho000000000002AAA' } }))).toContain('Dependency Dep');
    const d04t = { ancestorId: 'HIGHEST', dependencies: [{ package: 'Dep', subscriberPackageVersionId: '04t000000000077AAA' }] };
    expect(fails(input({ dirExtra: d04t, dependencyLookup: { '04t000000000077AAA': 'missing' } }))).toContain('Dependency Dep');
    expect(fails(input({ dirExtra: d04t, dependencyLookup: { '04t000000000077AAA': 'found' } }))).toEqual([]);
  });
  it('blocks when a build is already queued or in progress', () => {
    const r = input({ dirExtra: { ancestorId: 'HIGHEST' }, requests: [{ requestId: '08c000000000009AAA', status: 'InProgress', packageId: PKG, errors: [] }] });
    expect(fails(r)).toContain('Build in progress');
    const other = input({ dirExtra: { ancestorId: 'HIGHEST' }, requests: [{ requestId: '08c1', status: 'InProgress', packageId: '0Ho000000000099AAA', errors: [] }] });
    expect(fails(other)).toEqual([]);
  });
  it('requires committed source unless allowed, and non-git is fatal', () => {
    const dirty = { isRepo: true, files: [{ path: 'a', status: ' M' }], fingerprint: 'fp' };
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST' }, git: dirty }))).toContain('Source snapshot');
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST' }, git: dirty, allowDirty: true }))).toEqual([]);
    expect(fails(input({ dirExtra: { ancestorId: 'HIGHEST' }, git: { isRepo: false, files: [] } }))).toContain('Source snapshot');
  });
  it('ties the package to the validated source', () => {
    const base = { dirExtra: { ancestorId: 'HIGHEST' } };
    expect(fails(input({ ...base, analysisFingerprint: 'old' }))).toContain('Static analysis validation');
    expect(fails(input({ ...base, testsFingerprint: 'old' }))).toContain('Pre-package tests validation');
    expect(fails(input({ ...base, testsPassed: false }))).toContain('Pre-package tests validation');
  });
});

// ---------------------------------------------------------------- store
describe('PackagingStore', () => {
  const cand = (over = {}) => ({ requestId: '08c1', packageId: PKG, packageName: 'P', devHubOrgId: '00D1', devHubAlias: 'hub', versionNumber: '1.3.0.NEXT', status: 'Queued', errors: [], sourceFingerprint: 'fp', keyMode: 'key' as const, createdAt: 'now', ...over });
  it('persists requests immediately and finds in-flight and successful builds', () => {
    const file = path.join(tmp(), 'p.json');
    const s = new PackagingStore(file);
    s.upsert(cand());
    expect(new PackagingStore(file).inFlight(PKG, '00D1')?.requestId).toBe('08c1');
    expect(new PackagingStore(file).inFlight(PKG, 'other-hub')).toBeUndefined();
    s.upsert(cand({ status: 'Success', subscriberPackageVersionId: V_REL }));
    expect(s.inFlight(PKG, '00D1')).toBeUndefined();
    expect(s.successFor(PKG, '00D1', 'fp', '1.3.0.NEXT')?.subscriberPackageVersionId).toBe(V_REL);
    expect(s.successFor(PKG, '00D1', 'different', '1.3.0.NEXT')).toBeUndefined();
    expect(s.candidates()).toHaveLength(1);
  });
  it('survives a corrupt file', () => {
    const file = path.join(tmp(), 'p.json');
    fs.writeFileSync(file, '{broken');
    expect(new PackagingStore(file).candidates()).toEqual([]);
  });
});

// ---------------------------------------------------------------- polling & start (mocked CLI)
describe('pollRequest / startBuild', () => {
  const sfFrom = (h: (r: RunRequest) => RunResult) => new SfCli(new FakeRunner(h), new CommandHistory(), { command: 'sf', prefixArgs: [] });
  it('polls to a terminal status with an injectable sleep', async () => {
    const seq = ['Queued', 'InProgress', 'Success'];
    const sf = sfFrom(() => env({ Id: '08c000000000001AAA', Status: seq.shift() ?? 'Success', SubscriberPackageVersionId: V_REL }));
    const slept: number[] = [];
    const out = await pollRequest(sf, 'hub', '08c000000000001AAA', { root: '.' }, { intervalMs: 5000, timeoutMs: 60_000, sleep: async ms => { slept.push(ms); } });
    expect(out.request.status).toBe('Success');
    expect(out.timedOut).toBe(false);
    expect(slept).toEqual([5000, 5000]);
  });
  it('reports a local timeout without treating it as failure', async () => {
    const sf = sfFrom(() => env({ Id: '08c000000000001AAA', Status: 'InProgress' }));
    const out = await pollRequest(sf, 'hub', '08c000000000001AAA', { root: '.' }, { intervalMs: 10, timeoutMs: 15, sleep: async () => { await new Promise(r => setTimeout(r, 20)); } });
    expect(out.timedOut).toBe(true);
    expect(out.request.status).toBe('InProgress');
  });
  it('recovers the 08c from an error payload so a duplicate is never created', async () => {
    const sf = sfFrom(() => done(JSON.stringify({ status: 69, name: 'PackageVersionCreateInProgress', message: 'in progress', result: { Id: '08c000000000002AAA', Status: 'InProgress' } }), 69));
    expect((await startBuild(sf, { packageId: PKG, devHub: 'hub', bypassKey: true }, { root: '.' })).requestId).toBe('08c000000000002AAA');
    const bad = sfFrom(() => done(JSON.stringify({ status: 1, name: 'Err', message: 'rejected' }), 1));
    await expect(startBuild(bad, { packageId: PKG, devHub: 'hub', bypassKey: true }, { root: '.' })).rejects.toThrow(/rejected/);
  });
});

// ---------------------------------------------------------------- executors (mocked CLI)
const hubOrg = { orgId: '00D000000000001', username: 'hub@x.com', alias: 'hub', isDevHub: true, isScratch: false, isSandbox: false, tracksSource: false, isDefaultDevHub: true, isDefaultOrg: false, expired: false };

interface Sim {
  versions: unknown[];
  requests: unknown[];
  /** Status sequence returned by `create report`; the last one repeats. */
  statuses: string[];
  report: Record<string, unknown>;
  createResult: unknown;
  createError?: RunResult;
}

function setup(over: { sim?: Partial<Sim>; settings?: Partial<PackagingSettings>; key?: { key?: string; bypass?: boolean } | undefined; confirm?: boolean; dirExtra?: object; git?: object; steps?: Partial<Record<StepId, StepStatus>> } = {}) {
  const dir = tmp();
  const sim: Sim = {
    versions: [{ Version: '1.2.0.4', IsReleased: true, SubscriberPackageVersionId: V_REL }],
    requests: [], statuses: ['Queued', 'InProgress', 'Success'],
    report: { SubscriberPackageVersionId: '04t000000000009AAA', Package2Id: PKG, Version: '1.3.0.1', CodeCoverage: { apexCodeCoveragePercentage: 82 }, HasPassedCodeCoverageCheck: true, ValidationSkipped: false, IsReleased: false },
    createResult: { Id: '08c000000000005AAA', Status: 'Queued', Package2Id: PKG },
    ...over.sim
  };
  const runner = new FakeRunner(req => {
    const a = req.args;
    if (a[0] === 'package' && a[2] === 'list') { return env(sim.versions); }
    if (a[0] === 'package' && a[2] === 'create' && a[3] === 'list') { return env(sim.requests); }
    if (a[0] === 'package' && a[2] === 'create' && a[3] === 'report') {
      const status = sim.statuses.length > 1 ? sim.statuses.shift()! : sim.statuses[0];
      return env({ Id: '08c000000000005AAA', Status: status, Package2Id: PKG, SubscriberPackageVersionId: status === 'Success' ? '04t000000000009AAA' : undefined, Error: status === 'Error' ? ['Compile failed in Foo.cls'] : [] });
    }
    if (a[0] === 'package' && a[2] === 'create') { return sim.createError ?? env(sim.createResult); }
    if (a[0] === 'package' && a[2] === 'report') { return env(sim.report); }
    return done();
  });
  const sf = new SfCli(runner, new CommandHistory(), { command: 'sf', prefixArgs: [] });
  const proj = parseProject(dir, JSON.stringify({ namespace: 'ns', packageDirectories: [{ path: 'force-app', package: 'P', versionNumber: '1.3.0.NEXT', ancestorId: 'HIGHEST', ...over.dirExtra }], packageAliases: { P: PKG } }), () => true);
  const snapshot = { devHub: hubOrg, selectedPackage: { id: PKG, name: 'P', namespacePrefix: 'ns', containerOptions: 'Managed' }, project: proj } as unknown as DiscoverySnapshot;
  const store = new PackagingStore(path.join(dir, 'p.json'));
  const quality = new QualityStore(path.join(dir, 'q.json'));
  quality.update({ analysis: { sourceFingerprint: 'fp' } as never, apex: { sourceFingerprint: 'fp' } as never });
  const gitSnap = { isRepo: true, files: [], fingerprint: 'fp', head: 'abcdef1234567890', branch: 'main', ...over.git };
  const steps: Partial<Record<StepId, StepStatus>> = { analysis: 'passed', tests: 'passed', ...over.steps };
  let asked = 0;
  let confirmed = 0;
  const deps: PackagingDeps = {
    sf, discovery: { snapshot } as unknown as DiscoveryService, reports: new ReportWriter(path.join(dir, 'r')), store, quality,
    getRoot: () => dir, git: async () => gitSnap, allowDirty: () => false, stepStatus: id => steps[id] ?? 'pending',
    confirm: async () => { confirmed++; return over.confirm ?? true; },
    askInstallationKey: async () => { asked++; return 'key' in over ? over.key : { key: 'Sup3rSecretKey' }; },
    settings: () => ({ pollSeconds: 1, buildWaitMinutes: 5, installationKeyPolicy: 'require', ...over.settings }),
    sleep: async () => undefined
  };
  const ex = createPackagingExecutors(deps);
  const ctx: StepContext = { runId: 'r', signal: new AbortController().signal, log: () => undefined };
  const count = (pred: (a: string[]) => boolean) => runner.calls.filter(c => pred(c.args)).length;
  return { ...ex, ctx, store, runner, dir, sim, count, gitSnap, asked: () => asked, confirmed: () => confirmed };
}
const isCreate = (a: string[]) => a[0] === 'package' && a[1] === 'version' && a[2] === 'create' && a[3] !== 'report' && a[3] !== 'list';

describe('package readiness executor', () => {
  it('passes and records evidence plus the evaluated source', async () => {
    const t = setup();
    const r = await t['package-readiness'](t.ctx);
    expect(r.status).toBe('passed');
    expect(r.evidence?.[0].kind).toBe('package-readiness');
    expect(t.store.readiness()?.sourceFingerprint).toBe('fp');
    expect(t.count(isCreate)).toBe(0);
  });
  it('fails with actionable details when the ancestor is missing', async () => {
    const t = setup({ dirExtra: { ancestorId: undefined } });
    const r = await t['package-readiness'](t.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('READINESS_FAILED');
    expect(r.failure?.detail).toMatch(/Ancestry/);
  });
  it('fails when a build is already running on the Dev Hub', async () => {
    const t = setup({ sim: { requests: [{ Id: '08c000000000007AAA', Status: 'InProgress', Package2Id: PKG }] } });
    expect((await t['package-readiness'](t.ctx)).failure?.detail).toMatch(/Build in progress/);
  });
});

describe('package build executor', () => {
  const ready = async (t: ReturnType<typeof setup>) => { expect((await t['package-readiness'](t.ctx)).status).toBe('passed'); };

  it('requires current readiness', async () => {
    const t = setup();
    expect((await t['package-build'](t.ctx)).failure?.code).toBe('READINESS_STALE');
    await ready(t);
    t.gitSnap.fingerprint = 'source-changed-after-readiness';
    const r = await t['package-build'](t.ctx);
    expect(r.failure?.code).toBe('READINESS_STALE');
    expect(t.count(isCreate)).toBe(0);
  });

  it('creates, tracks, verifies the 04t and passes; secrets never reach evidence', async () => {
    const t = setup();
    await ready(t);
    const r = await t['package-build'](t.ctx);
    expect(r.status).toBe('passed');
    expect(r.message).toMatch(/04t000000000009AAA/);
    expect(t.count(isCreate)).toBe(1);
    const args = t.runner.calls.find(c => isCreate(c.args))!.args;
    for (const f of ['--skip-validation', '--skip-ancestor-check', '--async-validation']) { expect(args).not.toContain(f); }
    expect(args).toContain('--code-coverage');
    expect(args).toEqual(expect.arrayContaining(['--tag', 'abcdef123456', '--branch', 'main']));
    const c = t.store.candidates()[0];
    expect(c).toMatchObject({ requestId: '08c000000000005AAA', subscriberPackageVersionId: '04t000000000009AAA', status: 'Success', coveragePercent: 82, sourceFingerprint: 'fp', keyMode: 'key' });
    for (const e of r.evidence ?? []) { expect(fs.readFileSync(e.ref, 'utf8')).not.toContain('Sup3rSecretKey'); }
    expect(fs.readFileSync(path.join(t.dir, 'p.json'), 'utf8')).not.toContain('Sup3rSecretKey');
  });

  it('does nothing when the key prompt or confirmation is declined', async () => {
    const noKey = setup({ key: undefined });
    await ready(noKey);
    expect((await noKey['package-build'](noKey.ctx)).status).toBe('blocked');
    expect(noKey.count(isCreate)).toBe(0);
    const declined = setup({ confirm: false });
    await ready(declined);
    expect((await declined['package-build'](declined.ctx)).status).toBe('blocked');
    expect(declined.count(isCreate)).toBe(0);
  });

  it('supports an explicit key bypass', async () => {
    const t = setup({ key: { bypass: true } });
    await ready(t);
    expect((await t['package-build'](t.ctx)).status).toBe('passed');
    expect(t.runner.calls.find(c => isCreate(c.args))!.args).toContain('--installation-key-bypass');
    expect(t.store.candidates()[0].keyMode).toBe('bypass');
  });

  it('reports build failures with the Salesforce errors', async () => {
    const t = setup({ sim: { statuses: ['Queued', 'Error'] } });
    await ready(t);
    const r = await t['package-build'](t.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('BUILD_FAILED');
    expect(r.failure?.detail).toMatch(/Compile failed in Foo.cls/);
    expect(t.store.candidates()[0].status).toBe('Error');
  });

  it('fails a build whose package coverage is below 75% or whose check did not pass', async () => {
    const low = setup({ sim: { report: { SubscriberPackageVersionId: '04t000000000009AAA', Package2Id: PKG, Version: '1.3.0.1', CodeCoverage: { apexCodeCoveragePercentage: 60 }, HasPassedCodeCoverageCheck: false, ValidationSkipped: false, IsReleased: false } } });
    await ready(low);
    const r = await low['package-build'](low.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('PACKAGE_NOT_PROMOTABLE');
    expect(r.failure?.detail).toMatch(/60%/);
    const skipped = setup({ sim: { report: { SubscriberPackageVersionId: '04t000000000009AAA', Package2Id: PKG, CodeCoverage: { apexCodeCoveragePercentage: 90 }, HasPassedCodeCoverageCheck: true, ValidationSkipped: true } } });
    await ready(skipped);
    expect((await skipped['package-build'](skipped.ctx)).failure?.detail).toMatch(/Validation was skipped/);
    const wrongPkg = setup({ sim: { report: { SubscriberPackageVersionId: '04t000000000009AAA', Package2Id: '0Ho000000000099AAA', CodeCoverage: 90, HasPassedCodeCoverageCheck: true } } });
    await ready(wrongPkg);
    expect((await wrongPkg['package-build'](wrongPkg.ctx)).failure?.detail).toMatch(/belongs to package/);
  });

  it('on a local timeout keeps the request and a retry continues it without creating a second build', async () => {
    const t = setup({ sim: { statuses: ['InProgress'] }, settings: { buildWaitMinutes: 0 } });
    await ready(t);
    const first = await t['package-build'](t.ctx);
    expect(first.status).toBe('needs-review');
    expect(first.failure?.code).toBe('BUILD_STILL_RUNNING');
    expect(t.count(isCreate)).toBe(1);
    expect(t.store.inFlight(PKG, hubOrg.orgId)?.requestId).toBe('08c000000000005AAA');
    t.sim.statuses.splice(0, t.sim.statuses.length, 'Success');
    const second = await t['package-build']({ ...t.ctx });
    // buildWaitMinutes is 0, but the request is already terminal on the first check.
    expect(second.status).toBe('passed');
    expect(t.count(isCreate)).toBe(1);
    expect(t.asked()).toBe(1);
  });

  it('does not rebuild identical source that already produced a 04t', async () => {
    const t = setup();
    await ready(t);
    expect((await t['package-build'](t.ctx)).status).toBe('passed');
    const again = await t['package-build'](t.ctx);
    expect(again.status).toBe('passed');
    expect(t.count(isCreate)).toBe(1);
  });

  it('refuses to start while the Dev Hub already has a running build, and when creation is rejected', async () => {
    const t = setup();
    await ready(t);
    t.sim.requests = [{ Id: '08c000000000008AAA', Status: 'Queued', Package2Id: PKG }];
    const r = await t['package-build'](t.ctx);
    expect(r.failure?.code).toBe('BUILD_ALREADY_RUNNING');
    expect(t.count(isCreate)).toBe(0);
    const rejected = setup({ sim: { createError: done(JSON.stringify({ status: 1, name: 'InvalidAncestor', message: 'Ancestor required' }), 1) } });
    await ready(rejected);
    const rr = await rejected['package-build'](rejected.ctx);
    expect(rr.status).toBe('failed');
    expect(rr.message).toMatch(/Ancestor required/);
    expect(rejected.store.candidates()).toHaveLength(0);
  });
});

describe('slice 4 message validation', () => {
  it('validates packaging settings and refresh', () => {
    expect(parseMessage({ type: 'refreshBuild' })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'installationKeyPolicy', value: 'require' })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'installationKeyPolicy', value: 'never' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'buildPollSeconds', value: 2 })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'buildWaitMinutes', value: 90 })).toBeDefined();
  });
});
