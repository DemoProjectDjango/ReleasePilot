import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { ProcessRunner, RunRequest, RunResult } from '../adapters/processRunner';
import { SfCli } from '../adapters/sfCli';
import { AnalysisReport } from '../analysis/analyzer';
import { TriageStore } from '../analysis/triage';
import { StepContext, StepId, StepState } from '../core/models';
import { PIPELINE } from '../core/pipeline';
import { DiscoveryService, DiscoverySnapshot } from '../discovery/discoveryService';
import { ApprovalToken, ReleaseDeps, createReleaseExecutors } from '../executors/release';
import { ReportWriter } from '../executors/reportWriter';
import { PackagingStore } from '../packaging/store';
import { QaEnvironment, QaStore, makeChecklist } from '../qa/store';
import { ReleaseInput, evaluateRelease, renderHtml, renderMarkdown } from '../release/gates';
import { buildPromoteArgs, installLinks, nextSteps, promoteVersion } from '../release/promote';
import { ReleaseStore } from '../release/store';
import { ApexRun } from '../testing/apex';
import { QualityStore } from '../testing/qualityStore';
import { parseMessage } from '../ui/messages';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp6-'));
const done = (stdout = '', exitCode: number | null = 0): RunResult =>
  ({ exitCode, stdout, stderr: '', durationMs: 1, timedOut: false, aborted: false, truncated: false });
const env = (result: unknown) => done(JSON.stringify({ status: 0, result }));
const err = (name: string, message: string) => done(JSON.stringify({ status: 1, name, message }), 1);

class FakeRunner implements ProcessRunner {
  calls: RunRequest[] = [];
  constructor(public handler: (req: RunRequest) => RunResult) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    return this.handler(req);
  }
}

const PKG = '0Ho000000000001AAA';
const REL = '04t000000000001AAA';
const CAND = '04t000000000009AAA';
const HUB = { alias: 'hub', orgId: '00D000000000001' };

// ---------------------------------------------------------------- pure gate evaluation
const step = (id: StepId, status: StepState['status'] = 'passed'): StepState => ({ id, status, attempt: 1, evidence: [] });
const allSteps = (over: Partial<Record<StepId, StepState['status']>> = {}) =>
  Object.fromEntries(PIPELINE.map(p => [p.id, step(p.id, over[p.id] ?? 'passed')])) as Record<StepId, StepState>;

const analysis = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({ at: 'now', workspace: 'w', selectors: ['Recommended'], versions: {}, sourceFingerprint: 'fp', findings: [], counts: { total: 0, Critical: 0, High: 0, Moderate: 0, Low: 0, Info: 0 }, jsonPath: 'a.json', warnings: [], ...over });
const apex = (over: Partial<ApexRun> = {}): ApexRun => ({ at: 'now', orgLabel: 'val (00D2)', testLevel: 'RunLocalTests', outcome: 'Passed', total: 10, passed: 10, failed: 0, skipped: 0, tests: [], classes: [], orgWideCoverage: 85, deployedLocalSource: true, partial: false, sourceFingerprint: 'fp', ...over });
const signedEnv = (kind: 'fresh-install' | 'upgrade', over: Partial<QaEnvironment> = {}): QaEnvironment => {
  const checklist = makeChecklist(['a']);
  checklist[0].state = 'pass';
  return { id: `e-${kind}`, kind, alias: `rp-${kind}`, devHubOrgId: HUB.orgId, devHubAlias: 'hub', packageId: PKG, packageName: 'P', targetVersionId: CAND, sourceFingerprint: 'fp', status: 'ready', createdAt: 'now', durationDays: 7, definitionFile: 'x', permsets: [], phases: {}, smoke: [], logRefs: [], checklist, signoff: { approver: 'Ada', at: '2026-10-19T10:00:00Z' }, ...over };
};

function green(over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    now: '2026-10-19T12:00:00Z', project: '/p', devHub: HUB, pkg: { id: PKG, name: 'P' },
    candidate: { requestId: '08c1', packageId: PKG, packageName: 'P', devHubOrgId: HUB.orgId, devHubAlias: 'hub', versionNumber: '1.3.0.NEXT', status: 'Success', subscriberPackageVersionId: CAND, errors: [], sourceFingerprint: 'fp', keyMode: 'key', createdAt: 'then', hasPassedCodeCoverageCheck: true, coveragePercent: 82 },
    live: { subscriberPackageVersionId: CAND, packageId: PKG, version: '1.3.0.1', isReleased: false, validationSkipped: false, validatedAsync: false, codeCoverage: 82, hasPassedCodeCoverageCheck: true },
    versions: [{ version: '1.2.0.4', isReleased: true, subscriberPackageVersionId: REL, packageVersionId: '05i1' }, { version: '1.3.0.1', isReleased: false, subscriberPackageVersionId: CAND, packageVersionId: '05i9', ancestorId: '05i1' }],
    git: { fingerprint: 'fp', dirtyCount: 0 }, allowDirty: false, steps: allSteps(), analysis: analysis(), analysisGate: 'high', triaged: new Set(), apex: apex(), coverageTarget: 80,
    freshQa: signedEnv('fresh-install'), upgradeQa: signedEnv('upgrade'),
    upgradePath: { state: 'supported', baseline: { version: '1.2.0.4', isReleased: true, subscriberPackageVersionId: REL }, reason: 'ok' },
    overrides: [], evidenceFileHashes: { 'a.json': 'h1' },
    ...over
  };
}
const gate = (r: ReturnType<typeof evaluateRelease>, id: string) => r.gates.find(g => g.id === id)!;

describe('evaluateRelease', () => {
  it('is ready when every gate holds, and still lists the advisory/pass details', () => {
    const r = evaluateRelease(green());
    expect(r.ready).toBe(true);
    expect(r.hardBlockers).toEqual([]);
    expect(r.gates.filter(g => g.status === 'fail')).toEqual([]);
    expect(r.candidate).toMatchObject({ versionId: CAND, version: '1.3.0.1', coverage: 82 });
    expect(r.summary.packageCoverage).toMatch(/82%.*passed/);
  });

  const hardCases: Array<[string, string, Partial<ReleaseInput>]> = [
    ['no candidate', 'candidate', { candidate: undefined, live: undefined }],
    ['package coverage below 75', 'package-coverage', { live: { ...green().live!, codeCoverage: 70 } }],
    ['coverage check not passed', 'package-coverage', { live: { ...green().live!, hasPassedCodeCoverageCheck: false } }],
    ['no coverage reported', 'package-coverage', { live: { ...green().live!, codeCoverage: undefined } }],
    ['validation skipped', 'build-validation', { live: { ...green().live!, validationSkipped: true } }],
    ['already released', 'package-state', { live: { ...green().live!, isReleased: true } }],
    ['wrong package', 'package-state', { live: { ...green().live!, packageId: '0Ho000000000099AAA' } }],
    ['live state unreadable', 'package-state', { live: undefined, liveError: 'auth expired' }],
    ['source changed after build', 'source', { git: { fingerprint: 'other', dirtyCount: 0 } }],
    ['source step not passed', 'source', { steps: allSteps({ source: 'stale' }) }],
    ['analysis step stale', 'analysis', { steps: allSteps({ analysis: 'stale' }) }],
    ['analysis for other source', 'analysis', { analysis: analysis({ sourceFingerprint: 'old' }) }],
    ['analysis warnings (incomplete scan)', 'analysis', { analysis: analysis({ warnings: ['Error: Engine pmd'] }) }],
    ['tests step failed', 'tests', { steps: allSteps({ tests: 'failed' }) }],
    ['tests for other source', 'tests', { apex: apex({ sourceFingerprint: 'old' }) }],
    ['tests failing', 'tests', { apex: apex({ failed: 1, passed: 9, outcome: 'Failed' }) }],
    ['tests without deploy', 'tests', { apex: apex({ deployedLocalSource: false }) }],
    ['fresh QA unsigned', 'fresh-qa', { freshQa: signedEnv('fresh-install', { signoff: undefined }) }],
    ['fresh QA for another version', 'fresh-qa', { freshQa: signedEnv('fresh-install', { targetVersionId: '04t000000000099AAA' }) }],
    ['fresh QA for other source', 'fresh-qa', { freshQa: signedEnv('fresh-install', { sourceFingerprint: 'old' }) }],
    ['fresh QA step not passed', 'fresh-qa', { steps: allSteps({ 'clean-install-qa': 'needs-review' }) }],
    ['upgrade QA unsigned', 'upgrade-qa', { upgradeQa: signedEnv('upgrade', { signoff: undefined }) }],
    ['upgrade QA step not run', 'upgrade-qa', { steps: allSteps({ 'upgrade-qa': 'pending' }) }],
    ['upgrade path unsupported', 'upgrade-qa', { upgradePath: { state: 'unsupported', reason: 'No ancestor', alternative: 'Set ancestorId' } }],
    ['released version number reused', 'version-uniqueness', { versions: [{ version: '1.3.0.7', isReleased: true, subscriberPackageVersionId: '04t000000000077AAA' }] }],
    ['preflight not passed', 'identity', { steps: allSteps({ preflight: 'stale' }) }]
  ];
  it.each(hardCases)('blocks (and cannot be overridden) on: %s', (_name, id, over) => {
    const r = evaluateRelease(green(over));
    expect(gate(r, id).status).toBe('fail');
    expect(gate(r, id).kind).toBe('hard');
    expect(r.ready).toBe(false);
    expect(r.hardBlockers.length).toBeGreaterThan(0);
    // an override for a hard gate is ignored
    const withOverride = evaluateRelease(green({ ...over, overrides: [{ gateId: id, versionId: CAND, sourceFingerprint: 'fp', reason: 'we really want this', owner: 'x', at: 'now' }] }));
    expect(gate(withOverride, id).status).toBe('fail');
    expect(withOverride.ready).toBe(false);
  });

  it('treats an unreachable authorship of upgrade QA as not applicable only for new products', () => {
    const r = evaluateRelease(green({ upgradePath: { state: 'not-applicable', reason: 'New product' }, upgradeQa: undefined, steps: allSteps({ 'upgrade-qa': 'skipped' }) }));
    expect(gate(r, 'upgrade-qa').status).toBe('na');
    expect(r.ready).toBe(true);
  });

  it('separates local policy checks, which need a decision but can be overridden with a justification', () => {
    const policyCases: Array<[string, Partial<ReleaseInput>]> = [
      ['source-clean', { git: { fingerprint: 'fp', dirtyCount: 2 } }],
      ['org-coverage', { apex: apex({ orgWideCoverage: 60 }) }],
      ['lwc', { lwc: { at: 'now', configured: true, total: 4, passed: 3, failed: 1, failures: [] } }]
    ];
    for (const [id, over] of policyCases) {
      const r = evaluateRelease(green(over));
      expect(gate(r, id).kind).toBe('policy');
      expect(gate(r, id).status).toBe('fail');
      expect(r.hardBlockers).toEqual([]);
      expect(r.policyBlockers.length).toBe(1);
      expect(r.ready).toBe(false);
      const ok = evaluateRelease(green({ ...over, overrides: [{ gateId: id, versionId: CAND, sourceFingerprint: 'fp', reason: 'Accepted by the release owner', owner: 'Ada', at: 'now' }] }));
      expect(gate(ok, id).status).toBe('overridden');
      expect(ok.ready).toBe(true);
      expect(ok.overrides).toHaveLength(1);
      expect(ok.warnings.join()).toMatch(/OVERRIDDEN by Ada/);
    }
  });

  it('applies an override only to the same version and source', () => {
    const base = { gateId: 'org-coverage', reason: 'Accepted by the release owner', owner: 'Ada', at: 'now' };
    const low = { apex: apex({ orgWideCoverage: 60 }) };
    expect(gate(evaluateRelease(green({ ...low, overrides: [{ ...base, versionId: '04t000000000099AAA', sourceFingerprint: 'fp' }] })), 'org-coverage').status).toBe('fail');
    expect(gate(evaluateRelease(green({ ...low, overrides: [{ ...base, versionId: CAND, sourceFingerprint: 'old' }] })), 'org-coverage').status).toBe('fail');
  });

  it('allowing dirty source downgrades it to a warning; the key bypass is advisory only', () => {
    const r = evaluateRelease(green({ git: { fingerprint: 'fp', dirtyCount: 1 }, allowDirty: true, candidate: { ...green().candidate!, keyMode: 'bypass' } }));
    expect(gate(r, 'source-clean').status).toBe('warn');
    expect(gate(r, 'install-key')).toMatchObject({ kind: 'advisory', status: 'warn' });
    expect(r.ready).toBe(true);
    expect(r.warnings.length).toBe(2);
  });

  it('uses no ambient state: the evidence hash binds version, hub, package, source and file contents', () => {
    const base = evaluateRelease(green());
    expect(evaluateRelease(green({ now: 'a different time' })).evidenceHash).toBe(base.evidenceHash);
    expect(evaluateRelease(green({ evidenceFileHashes: { 'a.json': 'changed' } })).evidenceHash).not.toBe(base.evidenceHash);
    expect(evaluateRelease(green({ git: { fingerprint: 'other', dirtyCount: 0 } })).evidenceHash).not.toBe(base.evidenceHash);
    expect(evaluateRelease(green({ devHub: { alias: 'hub', orgId: '00D000000000777' } })).evidenceHash).not.toBe(base.evidenceHash);
    expect(evaluateRelease(green({ apex: apex({ orgWideCoverage: 60 }) })).evidenceHash).not.toBe(base.evidenceHash);
  });
});

describe('report rendering', () => {
  const report = evaluateRelease(green({ live: { ...green().live!, codeCoverage: 60 } }));
  it('renders Markdown with the verdict, blockers and promotion impact', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('NOT READY');
    expect(md).toContain('Blockers that cannot be overridden');
    expect(md).toContain(CAND);
    expect(md).toContain('Promotion is permanent');
    expect(renderMarkdown(evaluateRelease(green()))).toContain('READY for promotion approval');
  });
  it('escapes HTML and redacts secrets', () => {
    const r = evaluateRelease(green({ liveError: '<script>alert(1)</script> access_token=SECRET123', live: undefined }));
    const html = renderHtml(r);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('SECRET123');
    expect(renderMarkdown(r)).not.toContain('SECRET123');
  });
});

// ---------------------------------------------------------------- store & promote helpers
describe('ReleaseStore', () => {
  it('requires a real justification and owner, persists, and removes overrides', () => {
    const file = path.join(tmp(), 'r.json');
    const s = new ReleaseStore(file);
    const o = { gateId: 'lwc', versionId: CAND, sourceFingerprint: 'fp', reason: 'Known flaky snapshot test', owner: 'Ada', at: 'now' };
    expect(() => s.addOverride({ ...o, reason: 'too short' })).toThrow(/at least 15/);
    expect(() => s.addOverride({ ...o, owner: ' ' })).toThrow(/owner/);
    s.addOverride(o);
    expect(new ReleaseStore(file).overrides()).toHaveLength(1);
    s.removeOverride('lwc', CAND);
    expect(new ReleaseStore(file).overrides()).toHaveLength(0);
  });
  it('keeps promotion records and release history', () => {
    const file = path.join(tmp(), 'r.json');
    const s = new ReleaseStore(file);
    s.setPromotion({ versionId: CAND, packageId: PKG, devHubOrgId: HUB.orgId, devHubAlias: 'hub', status: 'attempting', approver: 'Ada', evidenceHash: 'h', startedAt: 'now' });
    expect(new ReleaseStore(file).promotion(CAND)?.status).toBe('attempting');
    s.addHistory({ at: 'now', packageName: 'P', packageId: PKG, devHubAlias: 'hub', devHubOrgId: HUB.orgId, versionId: CAND, approver: 'Ada', evidenceHash: 'h', sourceFingerprint: 'fp', overrides: [], receiptRef: 'r.json', verifiedOnly: false });
    expect(new ReleaseStore(file).history()).toHaveLength(1);
    fs.writeFileSync(file, '{broken');
    expect(new ReleaseStore(file).history()).toEqual([]);
  });
});

describe('promote command', () => {
  it('builds exactly one promote of one 04t on one Dev Hub with no extra flags', () => {
    expect(buildPromoteArgs(CAND, 'hub')).toEqual(['package', 'version', 'promote', '--package', CAND, '--target-dev-hub', 'hub', '--no-prompt']);
    expect(() => buildPromoteArgs('0Ho000000000001AAA', 'hub')).toThrow();
    expect(() => buildPromoteArgs(CAND, '--evil')).toThrow();
    expect(() => buildPromoteArgs('04t; rm', 'hub')).toThrow();
  });
  it('returns CLI errors instead of throwing so Salesforce can be re-queried', async () => {
    const sf = new SfCli(new FakeRunner(() => err('PackagePromoteError', 'Cannot promote')), new CommandHistory(), { command: 'sf', prefixArgs: [] });
    expect(await promoteVersion(sf, CAND, 'hub', { root: '.' })).toMatchObject({ cliSuccess: false });
    const ok = new SfCli(new FakeRunner(() => env({ id: CAND, success: true })), new CommandHistory(), { command: 'sf', prefixArgs: [] });
    expect((await promoteVersion(ok, CAND, 'hub', { root: '.' })).cliSuccess).toBe(true);
  });
  it('gives official install links and Partner Console guidance', () => {
    expect(installLinks(CAND).production).toBe(`https://login.salesforce.com/packaging/installPackage.apexp?p0=${CAND}`);
    expect(installLinks(CAND).sandbox).toContain('test.salesforce.com');
    expect(nextSteps(CAND, false).join('\n')).toMatch(/Partner Console/);
    expect(nextSteps(CAND, false).join('\n')).toMatch(/consider protecting/);
    expect(nextSteps(CAND, true).join('\n')).toMatch(/securely|secure channel/);
  });
});

// ---------------------------------------------------------------- executors against a mocked CLI
interface Sim {
  versions: unknown[];
  live: Record<string, unknown>;
  promote: () => RunResult;
  /** After a promote call, what the version report says. */
  afterPromote: 'released' | 'unreleased' | 'unreadable';
}

function setup(over: { sim?: Partial<Sim>; steps?: Partial<Record<StepId, StepState['status']>>; now?: () => Date } = {}) {
  const dir = tmp();
  const evidenceFile = path.join(dir, 'ev.json');
  fs.writeFileSync(evidenceFile, '{"ok":true}');
  const sim: Sim = {
    versions: [
      { Version: '1.2.0.4', IsReleased: true, SubscriberPackageVersionId: REL, Id: '05i1' },
      { Version: '1.3.0.1', IsReleased: false, SubscriberPackageVersionId: CAND, Id: '05i9', AncestorId: '05i1' }
    ],
    live: { SubscriberPackageVersionId: CAND, Package2Id: PKG, Version: '1.3.0.1', IsReleased: false, ValidationSkipped: false, CodeCoverage: { apexCodeCoveragePercentage: 82 }, HasPassedCodeCoverageCheck: true },
    promote: () => env({ id: CAND, success: true }), afterPromote: 'released', ...over.sim
  };
  let promoted = false;
  const runner = new FakeRunner(req => {
    const a = req.args;
    if (a[0] === 'package' && a[1] === 'version' && a[2] === 'list') { return env(sim.versions); }
    if (a[0] === 'package' && a[1] === 'version' && a[2] === 'promote') { promoted = true; return sim.promote(); }
    if (a[0] === 'package' && a[1] === 'version' && a[2] === 'report') {
      if (promoted && sim.afterPromote === 'unreadable') { return err('ConnectionError', 'socket hang up'); }
      return env({ ...sim.live, IsReleased: promoted && sim.afterPromote === 'released' ? true : sim.live.IsReleased });
    }
    return done();
  });
  const sf = new SfCli(runner, new CommandHistory(), { command: 'sf', prefixArgs: [] });
  const snapshot = { devHub: { orgId: HUB.orgId, alias: 'hub', username: 'hub@x.com' }, selectedPackage: { id: PKG, name: 'P' } } as unknown as DiscoverySnapshot;
  const packaging = new PackagingStore(path.join(dir, 'pk.json'));
  packaging.upsert(green().candidate!);
  const quality = new QualityStore(path.join(dir, 'q.json'));
  quality.update({ analysis: analysis(), apex: apex() });
  const qa = new QaStore(path.join(dir, 'qa.json'));
  qa.save(signedEnv('fresh-install'));
  qa.save(signedEnv('upgrade'));
  const releaseStore = new ReleaseStore(path.join(dir, 'rel.json'));
  const steps = allSteps(over.steps);
  for (const id of ['analysis', 'tests', 'package-build', 'clean-install-qa', 'upgrade-qa'] as StepId[]) {
    steps[id].evidence = [{ id: id, kind: 'k', label: id, ref: evidenceFile, createdAt: 'now' }];
  }
  let token: ApprovalToken | undefined;
  let tokenTakes = 0;
  const git = { isRepo: true, files: [] as Array<{ path: string; status: string }>, fingerprint: 'fp' };
  const deps: ReleaseDeps = {
    sf, discovery: { snapshot } as unknown as DiscoveryService, reports: new ReportWriter(path.join(dir, 'r')), reportsDir: path.join(dir, 'r'), quality, packaging, qa,
    release: releaseStore, triage: new TriageStore(path.join(dir, 't.json')), getRoot: () => dir, git: async () => git, steps: () => steps,
    settings: () => ({ severityGate: 'high', coverageTarget: 80, allowDirty: false }),
    takeApproval: () => { tokenTakes++; const t = token; token = undefined; return t; }, now: over.now
  };
  const ex = createReleaseExecutors(deps);
  const ctx: StepContext = { runId: 'r', signal: new AbortController().signal, log: () => undefined };
  const promoteCalls = () => runner.calls.filter(c => c.args[2] === 'promote');
  const review = async () => {
    const r = await ex['release-review'](ctx);
    if (r.status === 'passed') { steps['release-review'].status = 'passed'; steps['release-review'].fingerprint = r.fingerprint; }
    return r;
  };
  return { ...ex, ctx, runner, sim, dir, qa, quality, releaseStore, steps, git, review, promoteCalls, setToken: (t?: ApprovalToken) => { token = t; }, tokenTakes: () => tokenTakes,
    approve: (hash: string): ApprovalToken => ({ versionId: CAND, evidenceHash: hash, approver: 'Ada', at: Date.now() }) };
}

describe('release-review executor', () => {
  it('passes with JSON, Markdown and HTML evidence bound to a hash', async () => {
    const t = setup();
    const r = await t.review();
    expect(r.status).toBe('passed');
    expect(r.evidence?.map(e => e.kind)).toEqual(['release-readiness-json', 'release-readiness-md', 'release-readiness-html']);
    expect(r.fingerprint).toBe(t.releaseStore.lastReport()?.evidenceHash);
    expect(fs.readFileSync(r.evidence![1].ref, 'utf8')).toContain('READY for promotion approval');
    expect(t.promoteCalls()).toHaveLength(0);
  });
  it('fails on a platform blocker with every reason listed', async () => {
    const t = setup({ sim: { live: { SubscriberPackageVersionId: CAND, Package2Id: PKG, Version: '1.3.0.1', IsReleased: false, ValidationSkipped: true, CodeCoverage: { apexCodeCoveragePercentage: 60 }, HasPassedCodeCoverageCheck: false } } });
    const r = await t.review();
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('RELEASE_BLOCKED');
    expect(r.failure?.detail).toMatch(/coverage/i);
    expect(r.failure?.detail).toMatch(/Full validation/);
  });
  it('needs a decision for policy failures, and passes once a justified override exists', async () => {
    const t = setup();
    t.quality.update({ apex: apex({ orgWideCoverage: 60 }) });
    const first = await t.review();
    expect(first.status).toBe('needs-review');
    expect(first.failure?.code).toBe('POLICY_REVIEW_REQUIRED');
    t.releaseStore.addOverride({ gateId: 'org-coverage', versionId: CAND, sourceFingerprint: 'fp', reason: 'Accepted: legacy classes are being retired', owner: 'Ada', at: 'now' });
    const second = await t.review();
    expect(second.status).toBe('passed');
    expect(t.releaseStore.lastReport()?.overrides).toHaveLength(1);
  });
  it('flags a candidate built from different source as blocked', async () => {
    const t = setup();
    t.git.fingerprint = 'moved-on';
    const r = await t.review();
    expect(r.status).toBe('failed');
    expect(r.failure?.detail).toMatch(/source changed/i);
  });
});

describe('promotion executor', () => {
  it('refuses without a current, ready review', async () => {
    const t = setup();
    expect((await t.promotion(t.ctx)).failure?.code).toBe('NO_REVIEWED_CANDIDATE');
    await t.review();
    t.steps['release-review'].status = 'stale';
    expect((await t.promotion(t.ctx)).failure?.code).toBe('REVIEW_NOT_CURRENT');
    expect(t.promoteCalls()).toHaveLength(0);
  });

  it('never promotes without an approval for this exact version and evidence', async () => {
    const t = setup();
    await t.review();
    const hash = t.releaseStore.lastReport()!.evidenceHash;
    const none = await t.promotion(t.ctx);
    expect(none.status).toBe('blocked');
    expect(none.failure?.code).toBe('APPROVAL_REQUIRED');
    t.setToken({ ...t.approve(hash), versionId: '04t000000000099AAA' });
    expect((await t.promotion(t.ctx)).status).toBe('blocked');
    t.setToken({ ...t.approve(hash), evidenceHash: 'stale-hash' });
    expect((await t.promotion(t.ctx)).status).toBe('blocked');
    t.setToken({ ...t.approve(hash), at: Date.now() - 11 * 60_000 });
    expect((await t.promotion(t.ctx)).status).toBe('blocked');
    expect(t.promoteCalls()).toHaveLength(0);
    expect(t.releaseStore.promotion(CAND)).toBeUndefined();
  });

  it('promotes after valid approval, records intent first, and passes only after Salesforce confirms Released', async () => {
    const t = setup();
    await t.review();
    const hash = t.releaseStore.lastReport()!.evidenceHash;
    t.setToken(t.approve(hash));
    const r = await t.promotion(t.ctx);
    expect(r.status).toBe('passed');
    expect(r.message).toMatch(/Salesforce confirms .* is Released/);
    expect(t.promoteCalls()).toHaveLength(1);
    // the adapter appends --json; nothing else may be added to the promote command
    expect(t.promoteCalls()[0].args).toEqual(['package', 'version', 'promote', '--package', CAND, '--target-dev-hub', 'hub', '--no-prompt', '--json']);
    expect(t.releaseStore.promotion(CAND)).toMatchObject({ status: 'released', approver: 'Ada', evidenceHash: hash });
    const entry = t.releaseStore.history()[0];
    expect(entry).toMatchObject({ versionId: CAND, approver: 'Ada', verifiedOnly: false, coverage: 82 });
    const receipt = JSON.parse(fs.readFileSync(r.evidence![0].ref, 'utf8')) as { installLinks: { production: string }; nextSteps: string[]; evidenceHash: string };
    expect(receipt.evidenceHash).toBe(hash);
    expect(receipt.installLinks.production).toContain(CAND);
    expect(receipt.nextSteps.join()).toMatch(/Partner Console/);
    t.setToken(undefined);
  });

  it('consumes the approval: a second run cannot reuse it', async () => {
    const t = setup({ sim: { afterPromote: 'unreleased' } });
    await t.review();
    const hash = t.releaseStore.lastReport()!.evidenceHash;
    t.setToken(t.approve(hash));
    expect((await t.promotion(t.ctx)).status).toBe('failed');
    expect(t.promoteCalls()).toHaveLength(1);
    expect((await t.promotion(t.ctx)).status).toBe('blocked');
    expect(t.promoteCalls()).toHaveLength(1);
  });

  it('does not call success when Salesforce still shows the version unreleased', async () => {
    const t = setup({ sim: { afterPromote: 'unreleased', promote: () => env({ id: CAND, success: true }) } });
    await t.review();
    t.setToken(t.approve(t.releaseStore.lastReport()!.evidenceHash));
    const r = await t.promotion(t.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('PROMOTION_FAILED');
    expect(t.releaseStore.promotion(CAND)?.status).toBe('failed');
    expect(t.releaseStore.history()).toHaveLength(0);
  });

  it('treats an ambiguous CLI error as success only if Salesforce then reports Released', async () => {
    const t = setup({ sim: { promote: () => err('Timeout', 'socket hang up'), afterPromote: 'released' } });
    await t.review();
    t.setToken(t.approve(t.releaseStore.lastReport()!.evidenceHash));
    expect((await t.promotion(t.ctx)).status).toBe('passed');
    const failing = setup({ sim: { promote: () => err('PromoteError', 'Insufficient coverage'), afterPromote: 'unreleased' } });
    await failing.review();
    failing.setToken(failing.approve(failing.releaseStore.lastReport()!.evidenceHash));
    const f = await failing.promotion(failing.ctx);
    expect(f.status).toBe('failed');
    expect(f.failure?.message).toMatch(/Insufficient coverage/);
  });

  it('goes to Needs Review, not failure or success, when the result cannot be verified, and a retry re-queries before promoting', async () => {
    const t = setup({ sim: { afterPromote: 'unreadable' } });
    await t.review();
    t.setToken(t.approve(t.releaseStore.lastReport()!.evidenceHash));
    const r = await t.promotion(t.ctx);
    expect(r.status).toBe('needs-review');
    expect(r.failure?.code).toBe('PROMOTION_UNVERIFIED');
    expect(t.releaseStore.promotion(CAND)?.status).toBe('attempting');
    // Salesforce did release it meanwhile.
    t.sim.live = { ...t.sim.live, IsReleased: true };
    t.sim.afterPromote = 'released';
    const retry = await t.promotion(t.ctx);
    expect(retry.status).toBe('passed');
    expect(t.promoteCalls()).toHaveLength(1);
    expect(t.releaseStore.history()[0].verifiedOnly).toBe(false);
  });

  it('only verifies, without approval or a promote command, when the version is already released', async () => {
    const t = setup();
    await t.review();
    t.sim.live = { ...t.sim.live, IsReleased: true };
    const r = await t.promotion(t.ctx);
    expect(r.status).toBe('passed');
    expect(r.message).toMatch(/Verified only/);
    expect(t.promoteCalls()).toHaveLength(0);
    expect(t.releaseStore.history()[0].verifiedOnly).toBe(true);
  });

  it('refuses to promote when the evidence changed after the review', async () => {
    const t = setup();
    await t.review();
    const hash = t.releaseStore.lastReport()!.evidenceHash;
    // a test run is invalidated between review and approval
    t.quality.update({ apex: apex({ failed: 2, passed: 8, outcome: 'Failed' }) });
    t.setToken(t.approve(hash));
    const r = await t.promotion(t.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('REVIEW_DRIFTED');
    expect(t.promoteCalls()).toHaveLength(0);
    // an evidence file edited after review also breaks the binding
    const t2 = setup();
    await t2.review();
    const h2 = t2.releaseStore.lastReport()!.evidenceHash;
    fs.writeFileSync(path.join(t2.dir, 'ev.json'), '{"tampered":true}');
    t2.setToken(t2.approve(h2));
    expect((await t2.promotion(t2.ctx)).failure?.code).toBe('REVIEW_DRIFTED');
    expect(t2.promoteCalls()).toHaveLength(0);
  });

  it('fails verification if the released version is not the approved package', async () => {
    const t = setup();
    await t.review();
    t.setToken(t.approve(t.releaseStore.lastReport()!.evidenceHash));
    t.sim.live = { ...t.sim.live };
    const orig = t.runner.handler;
    t.runner.handler = req => {
      const res = orig(req);
      if (req.args[2] === 'report' && t.promoteCalls().length > 0) {
        const body = JSON.parse(res.stdout) as { result: Record<string, unknown> };
        return env({ ...body.result, Package2Id: '0Ho000000000099AAA' });
      }
      return res;
    };
    expect((await t.promotion(t.ctx)).failure?.code).toBe('VERIFICATION_MISMATCH');
  });
});

describe('slice 6 message validation', () => {
  it('validates release actions', () => {
    expect(parseMessage({ type: 'promote' })).toBeDefined();
    expect(parseMessage({ type: 'overrideGate', gateId: 'org-coverage' })).toBeDefined();
    expect(parseMessage({ type: 'overrideGate', gateId: 'Org Coverage;' })).toBeUndefined();
    expect(parseMessage({ type: 'removeOverride', gateId: 'lwc' })).toBeDefined();
    expect(parseMessage({ type: 'removeOverride' })).toBeUndefined();
  });
});
