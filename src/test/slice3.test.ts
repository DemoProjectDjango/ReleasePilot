import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { NodeProcessRunner, ProcessRunner, RunRequest, RunResult } from '../adapters/processRunner';
import { SfCli } from '../adapters/sfCli';
import { applyFix, assertSelector, extractWarnings, countBySeverity, gateBlockers, groupFindings, parseAnalyzerJson, runCodeAnalyzer } from '../analysis/analyzer';
import { TriageStore } from '../analysis/triage';
import { DiscoverySnapshot, DiscoveryService } from '../discovery/discoveryService';
import { OrgInfo } from '../discovery/parsers';
import { QualityDeps, QualitySettings, createQualityExecutors } from '../executors/quality';
import { ReportWriter } from '../executors/reportWriter';
import { StepContext } from '../core/models';
import { evaluateApex, parseApexResult, runApexTests, deployLocalSource, ApexRun } from '../testing/apex';
import { detectLwcJest, parseJestJson, runLwcJest } from '../testing/lwc';
import { QualityStore } from '../testing/qualityStore';
import { buildSummaryMarkdown } from '../testing/summary';
import { parseMessage } from '../ui/messages';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp3-'));
const done = (stdout = '', exitCode: number | null = 0, stderr = ''): RunResult =>
  ({ exitCode, stdout, stderr, durationMs: 1, timedOut: false, aborted: false, truncated: false });

class FakeRunner implements ProcessRunner {
  calls: RunRequest[] = [];
  constructor(private handler: (req: RunRequest) => RunResult) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    return this.handler(req);
  }
}
const sfWith = (h: (r: RunRequest) => RunResult) => {
  const runner = new FakeRunner(h);
  return { runner, sf: new SfCli(runner, new CommandHistory(), { command: 'sf', prefixArgs: [] }) };
};
const envelope = (result: unknown) => done(JSON.stringify({ status: 0, result }));

// A trimmed copy of real `sf code-analyzer run` JSON output (Code Analyzer 0.52.0).
const REAL_REPORT = JSON.stringify({
  runDir: 'C:\\proj\\',
  violationCounts: { total: 3, sev1: 0, sev2: 1, sev3: 1, sev4: 1, sev5: 0 },
  versions: { 'code-analyzer': '0.52.0', pmd: '0.45.0' },
  violations: [
    { rule: 'ApexCRUDViolation', engine: 'pmd', severity: 2, tags: ['Recommended', 'Security'], primaryLocationIndex: 0,
      locations: [{ file: 'force-app\\main\\default\\classes\\Bad.cls', startLine: 4, startColumn: 9, endLine: 4, endColumn: 30 }],
      message: 'Validate CRUD permission before SOQL', resources: ['https://docs.pmd-code.org/x'] },
    { rule: 'ApexSharingViolations', engine: 'pmd', severity: 3, tags: ['Security'], primaryLocationIndex: 0,
      locations: [{ file: 'force-app\\main\\default\\classes\\Bad.cls', startLine: 1, startColumn: 1, endLine: 1, endColumn: 7 }],
      message: 'Apex classes should declare a sharing model', resources: [],
      fixes: [{ location: { file: 'force-app\\main\\default\\classes\\Bad.cls', startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, fixedCode: 'public with sharing ' }] },
    { rule: 'AvoidDebugStatements', engine: 'pmd', severity: 4, tags: [], primaryLocationIndex: 0,
      locations: [{ file: 'force-app\\main\\default\\classes\\Other.cls', startLine: 9, startColumn: 3, endLine: 9, endColumn: 12 }],
      message: 'Avoid debug statements', suggestions: [{ message: 'Use a logging framework' }] },
    { bogus: true }
  ]
});

// ---------------------------------------------------------------- analyzer parsing, grouping, gating
describe('Code Analyzer parsing', () => {
  const parsed = parseAnalyzerJson(REAL_REPORT, 'C:\\proj');
  it('normalizes real-shape output and skips malformed entries', () => {
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.versions['code-analyzer']).toBe('0.52.0');
    const f = parsed.findings[0];
    expect(f.severityLabel).toBe('High');
    expect(f.file).toBe('force-app/main/default/classes/Bad.cls');
    expect(f.line).toBe(4);
    expect(parsed.findings[1].fix?.fixedCode).toBe('public with sharing ');
    expect(parsed.findings[2].suggestions).toEqual(['Use a logging framework']);
  });
  it('counts, groups by file/severity/rule', () => {
    expect(countBySeverity(parsed.findings)).toMatchObject({ total: 3, High: 1, Moderate: 1, Low: 1, Critical: 0 });
    expect(groupFindings(parsed.findings, 'file')[0].key).toContain('Bad.cls');
    expect(groupFindings(parsed.findings, 'severity').map(g => g.key)).toEqual(['High', 'Moderate', 'Low']);
    expect(groupFindings(parsed.findings, 'rule')).toHaveLength(3);
  });
  it('gates by severity and respects triage', () => {
    expect(gateBlockers(parsed.findings, 'high', new Set())).toHaveLength(1);
    expect(gateBlockers(parsed.findings, 'moderate', new Set())).toHaveLength(2);
    expect(gateBlockers(parsed.findings, 'none', new Set())).toHaveLength(0);
    expect(gateBlockers(parsed.findings, 'high', new Set([parsed.findings[0].key]))).toHaveLength(0);
  });
  it('rejects hostile rule selectors', () => {
    expect(assertSelector('Recommended:Security')).toBe('Recommended:Security');
    expect(() => assertSelector('--workspace')).toThrow();
    expect(() => assertSelector('a b')).toThrow();
  });
});

describe('applyFix', () => {
  it('inserts, replaces and deletes by 1-based range', () => {
    expect(applyFix('class A {}', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, fixedCode: 'public ' })).toBe('public class A {}');
    expect(applyFix('a\nbad line\nc', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 4, fixedCode: 'good' })).toBe('a\ngood line\nc');
    expect(applyFix('x;;y', { startLine: 1, startColumn: 3, endLine: 1, endColumn: 4, fixedCode: '' })).toBe('x;y');
  });
  it('handles CRLF files and refuses out-of-range fixes', () => {
    expect(applyFix('a\r\nbb\r\n', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3, fixedCode: 'Z' })).toBe('a\r\nZ\r\n');
    expect(() => applyFix('abc', { startLine: 5, startColumn: 1, endLine: 5, endColumn: 2, fixedCode: 'x' })).toThrow(/rescan/);
    expect(() => applyFix('abc', { startLine: 1, startColumn: 99, endLine: 1, endColumn: 100, fixedCode: 'x' })).toThrow(/rescan/);
  });
});

describe('runCodeAnalyzer (mocked CLI writing a real-shape report)', () => {
  it('invokes the expected arguments and reads the report', async () => {
    const out = tmp();
    const { sf, runner } = sfWith(req => {
      const files = req.args.flatMap((a, i) => (req.args[i - 1] === '--output-file' ? [a] : []));
      fs.writeFileSync(files[0], REAL_REPORT);
      return done('ok');
    });
    const report = await runCodeAnalyzer(sf, { root: 'C:\\proj', outputDir: out, selectors: ['Recommended', 'AppExchange'] });
    const args = runner.calls[0].args;
    expect(args.slice(0, 4)).toEqual(['code-analyzer', 'run', '--workspace', '.']);
    expect(args.filter(a => a === '--rule-selector')).toHaveLength(2);
    expect(args).toContain('--include-fixes');
    expect(args).not.toContain('--json');
    expect(report.findings).toHaveLength(3);
    expect(report.jsonPath.startsWith(out)).toBe(true);
  });
  it('fails clearly when no report is written', async () => {
    const { sf } = sfWith(() => done('ok'));
    await expect(runCodeAnalyzer(sf, { root: '.', outputDir: tmp(), selectors: [] })).rejects.toMatchObject({ code: 'NO_REPORT' });
  });
});

describe('analyzer warnings', () => {
  it('extracts meaningful warning lines and ignores the update notice and progress noise', () => {
    const stderr = ' \u00BB   Warning: @salesforce/cli update available from 2.1.0 to 2.2.0.\nSelecting rules... 50%\r\n \u00BB   Error: Failed to parse Broken.cls: unexpected token\n';
    expect(extractWarnings(stderr)).toEqual(['Error: Failed to parse Broken.cls: unexpected token']);
    const real = ' \u00BB   Warning: Could not find typescript. Please ensure that typescript is a\n \u00BB   devDependency. Falling back to compiled source.\n \u00BB   Error: Engine \'pmd\' [17:8:34]:\n \u00BB   PMD issued a processing error for file \'A.cls\':\n \u00BB   ParseException: Failed to parse\n';
    const w = extractWarnings(real);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^Error: Engine .pmd.*ParseException/);
    expect(extractWarnings('Executing rules... done')).toEqual([]);
  });
  it('never lets a scan with warnings pass, even with zero findings', async () => {
    const h = harness({ analyzerReport: JSON.stringify({ runDir: 'C:\\proj\\', versions: {}, violations: [] }), analyzerStderr: ' \u00BB   pmd failed to parse Broken.cls\n' });
    const r = await h.analysis(h.ctx);
    expect(r.status).toBe('needs-review');
    expect(r.failure?.code).toBe('ANALYZER_WARNINGS');
    expect(r.failure?.detail).toMatch(/Broken\.cls/);
    const clean = harness({ analyzerReport: JSON.stringify({ runDir: 'C:\\proj\\', versions: {}, violations: [] }) });
    expect((await clean.analysis(clean.ctx)).status).toBe('passed');
  });
});

// ---------------------------------------------------------------- triage
describe('TriageStore', () => {
  it('requires a justification and persists decisions', () => {
    const file = path.join(tmp(), 't.json');
    const t = new TriageStore(file);
    expect(() => t.add('k', 'short', 'me')).toThrow(/at least 10/);
    expect(() => t.add('k', 'a long enough reason', '  ')).toThrow(/owner/);
    t.add('k', 'False positive: input is a constant', 'me');
    expect(new TriageStore(file).list()[0]).toMatchObject({ key: 'k', owner: 'me' });
    expect(new TriageStore(file).keys().has('k')).toBe(true);
    t.remove('k');
    expect(new TriageStore(file).list()).toEqual([]);
  });
});

// ---------------------------------------------------------------- apex parsing & gate
// Shape follows `sf apex run test --code-coverage --json` documentation; NOT verified against a live org.
const APEX_RESULT = {
  summary: { outcome: 'Failed', testsRan: 3, passing: 2, failing: 1, skipped: 0, testRunId: '707000000000001', orgId: '00D000000000009', orgWideCoverage: '82%', testRunCoverage: '77%' },
  tests: [
    { FullName: 'FooTest.passes', MethodName: 'passes', Outcome: 'Pass', ApexClass: { Name: 'FooTest' }, RunTime: 12 },
    { FullName: 'FooTest.alsoPasses', MethodName: 'alsoPasses', Outcome: 'Pass', ApexClass: { Name: 'FooTest' } },
    { FullName: 'BarTest.breaks', MethodName: 'breaks', Outcome: 'Fail', Message: 'System.AssertException: expected 1', StackTrace: 'Class.BarTest.breaks: line 9', ApexClass: { Name: 'BarTest' } }
  ],
  coverage: { coverage: [{ name: 'Foo', totalLines: 10, totalCovered: 9, coveredPercent: 90 }, { name: 'Bar', totalLines: 10, totalCovered: 5 }] }
};
describe('Apex results', () => {
  const base = { at: 'now', orgLabel: 'org', testLevel: 'RunLocalTests' as const, deployedLocalSource: true, partial: false };
  it('parses summary, tests, failures and class coverage', () => {
    const p = parseApexResult(APEX_RESULT);
    expect(p).toMatchObject({ total: 3, passed: 2, failed: 1, orgWideCoverage: 82, testRunCoverage: 77, testRunId: '707000000000001' });
    expect(p.tests[2]).toMatchObject({ className: 'BarTest', outcome: 'Fail', stackTrace: 'Class.BarTest.breaks: line 9' });
    expect(p.classes.find(c => c.name === 'Bar')?.percent).toBe(50);
  });
  it('fails the gate on failures and labels coverage as org-wide', () => {
    const run: ApexRun = { ...base, ...parseApexResult(APEX_RESULT) };
    const g = evaluateApex(run, 80);
    expect(g.passed).toBe(false);
    expect(g.problems.join(' ')).toMatch(/1 Apex test\(s\) failed/);
    expect(g.coverageLabel).toMatch(/org-wide.*not package-version/);
  });
  it('enforces coverage target, partial runs, no coverage and unverified source', () => {
    const ok = { ...base, ...parseApexResult({ ...APEX_RESULT, summary: { ...APEX_RESULT.summary, outcome: 'Passed', failing: 0, passing: 3 }, tests: APEX_RESULT.tests.slice(0, 2) }) };
    expect(evaluateApex(ok, 80).passed).toBe(true);
    expect(evaluateApex(ok, 90).problems.join()).toMatch(/below the 90%/);
    expect(evaluateApex({ ...ok, partial: true }, 80).passed).toBe(false);
    expect(evaluateApex({ ...ok, orgWideCoverage: undefined, testRunCoverage: undefined }, 80).problems.join()).toMatch(/no coverage/);
    const g = evaluateApex({ ...ok, deployedLocalSource: false }, 80);
    expect(g.passed).toBe(false);
    expect(g.sourceUnverified).toBe(true);
    expect(g.problems).toEqual([]);
  });
  it('treats zero tests as a failure', () => {
    const none = { ...base, ...parseApexResult({ summary: { outcome: 'Passed', testsRan: 0, orgWideCoverage: '90%' } }) };
    expect(evaluateApex(none, 80).problems.join()).toMatch(/No Apex tests/);
  });
});

describe('Apex / deploy command construction (mocked CLI)', () => {
  it('builds the run-test command and validates names', async () => {
    const out = tmp();
    const { sf, runner } = sfWith(() => envelope(APEX_RESULT));
    const run = await runApexTests(sf, { root: '.', org: 'val-org', orgLabel: 'val', level: 'RunLocalTests', waitMinutes: 30, outputDir: out, deployedLocalSource: true });
    const a = runner.calls[0].args;
    expect(a.slice(0, 3)).toEqual(['apex', 'run', 'test']);
    expect(a).toEqual(expect.arrayContaining(['--target-org', 'val-org', '--test-level', 'RunLocalTests', '--code-coverage', '--json']));
    expect(run.rawPath && fs.existsSync(run.rawPath)).toBeTruthy();
    await expect(runApexTests(sf, { root: '.', org: 'x', orgLabel: 'x', level: 'RunSpecifiedTests', tests: ['Bad Name; rm'], waitMinutes: 5, outputDir: out, deployedLocalSource: false })).rejects.toThrow(/Invalid test name/);
    await expect(runApexTests(sf, { root: '.', org: '--evil', orgLabel: 'x', level: 'RunLocalTests', waitMinutes: 5, outputDir: out, deployedLocalSource: false })).rejects.toThrow();
    const sub = await runApexTests(sf, { root: '.', org: 'x', orgLabel: 'x', level: 'RunSpecifiedTests', tests: ['BarTest.breaks'], waitMinutes: 5, outputDir: out, deployedLocalSource: false });
    expect(sub.partial).toBe(true);
    expect(runner.calls.at(-1)!.args).toEqual(expect.arrayContaining(['--tests', 'BarTest.breaks']));
  });
  it('deploys only declared directories and never passes ignore flags', async () => {
    const { sf, runner } = sfWith(() => envelope({ success: true, status: 'Succeeded', id: '0Af0' }));
    await deployLocalSource(sf, { root: '.', org: 'val', dirs: ['force-app', 'extra'], waitMinutes: 10 });
    const a = runner.calls[0].args;
    expect(a.slice(0, 3)).toEqual(['project', 'deploy', 'start']);
    expect(a.filter(x => x === '--source-dir')).toHaveLength(2);
    expect(a.some(x => /ignore/.test(x))).toBe(false);
    await expect(deployLocalSource(sf, { root: '.', org: 'val', dirs: [], waitMinutes: 1 })).rejects.toMatchObject({ code: 'NO_SOURCE_DIRS' });
    await expect(deployLocalSource(sf, { root: '.', org: 'val', dirs: ['--evil'], waitMinutes: 1 })).rejects.toThrow();
    const failing = sfWith(() => envelope({ success: false, status: 'Failed' }));
    await expect(deployLocalSource(failing.sf, { root: '.', org: 'val', dirs: ['force-app'], waitMinutes: 1 })).rejects.toMatchObject({ code: 'DEPLOY_FAILED' });
  });
});

// ---------------------------------------------------------------- LWC jest (local integration with a fake jest binary)
describe('LWC Jest', () => {
  it('reports NOT_CONFIGURED when absent', () => {
    expect(detectLwcJest(tmp())).toMatchObject({ configured: false });
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ devDependencies: {} }));
    expect(detectLwcJest(d).configured).toBe(false);
  });
  it('flags configured-but-not-installed', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ devDependencies: { '@salesforce/sfdx-lwc-jest': '1' } }));
    fs.writeFileSync(path.join(d, 'jest.config.js'), 'module.exports={}');
    expect(detectLwcJest(d)).toMatchObject({ configured: true, installMissing: true });
  });
  it('runs the project Jest through node and parses failures', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ devDependencies: { '@salesforce/sfdx-lwc-jest': '1' } }));
    fs.writeFileSync(path.join(d, 'jest.config.js'), 'module.exports={}');
    const bin = path.join(d, 'node_modules', '@salesforce', 'sfdx-lwc-jest', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sfdx-lwc-jest'), `
const out = process.argv.find(a => a.startsWith('--outputFile=')).split('=')[1];
require('fs').writeFileSync(out, JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1,
  testResults: [{ name: 'a.test.js', status: 'failed', assertionResults: [{ status: 'passed', fullName: 'ok' }, { status: 'failed', fullName: 'broken', failureMessages: ['expected 1'] }] }] }));
process.exit(1);`);
    const r = await runLwcJest(new NodeProcessRunner(), d, path.join(d, 'out'));
    expect(r).toMatchObject({ configured: true, total: 2, passed: 1, failed: 1 });
    expect(r.failures[0]).toMatchObject({ test: 'broken', message: 'expected 1' });
    expect(parseJestJson('{"numTotalTests":0}').total).toBe(0);
  });
});

// ---------------------------------------------------------------- executors (mocked CLI, real fs)
const org = (o: Partial<OrgInfo> = {}): OrgInfo => ({ orgId: '00D000000000009', username: 'val@x.com', alias: 'val', isDevHub: false, isScratch: true, isSandbox: false, tracksSource: true, isDefaultDevHub: false, isDefaultOrg: false, expired: false, ...o });
const hub = org({ orgId: '00D000000000001', username: 'hub@x.com', alias: 'hub', isDevHub: true, isScratch: false });

function harness(opts: { analyzerStderr?: string; validation?: OrgInfo; settings?: Partial<QualitySettings>; confirm?: boolean; handler?: (r: RunRequest) => RunResult; analyzerReport?: string }) {
  const dir = tmp();
  const snapshot = {
    devHub: hub, validationOrg: opts.validation,
    project: { packageDirectories: [{ path: 'force-app', exists: true }] }
  } as unknown as DiscoverySnapshot;
  const { sf, runner } = sfWith(req => {
    if (req.args[0] === 'code-analyzer') {
      const files = req.args.flatMap((a, i) => (req.args[i - 1] === '--output-file' ? [a] : []));
      fs.writeFileSync(files[0], opts.analyzerReport ?? REAL_REPORT);
      return done('ok', 0, opts.analyzerStderr ?? '');
    }
    if (req.args[0] === 'project' && req.args[1] === 'deploy') {
      return envelope({ success: true, status: 'Succeeded', id: '0Af' });
    }
    if (req.args[0] === 'apex') {
      return envelope(APEX_PASS);
    }
    return opts.handler ? opts.handler(req) : done();
  });
  const triage = new TriageStore(path.join(dir, 'triage.json'));
  const quality = new QualityStore(path.join(dir, 'q.json'));
  const deps: QualityDeps = {
    sf, runner, discovery: { snapshot } as unknown as DiscoveryService, reports: new ReportWriter(path.join(dir, 'r')), reportsDir: path.join(dir, 'r'),
    quality, triage, getRoot: () => dir,
    settings: () => ({ ruleSelectors: ['Recommended'], severityGate: 'high', testLevel: 'RunLocalTests', deployBeforeTests: true, waitMinutes: 5, coverageTargetPercent: 80, ...opts.settings }),
    git: async () => ({ isRepo: true, files: [], fingerprint: 'fp1' }),
    confirm: async () => opts.confirm ?? true
  };
  const ctx: StepContext = { runId: 'r', signal: new AbortController().signal, log: () => undefined };
  return { ...createQualityExecutors(deps), ctx, triage, quality, runner };
}
const APEX_PASS = { ...APEX_RESULT, summary: { ...APEX_RESULT.summary, outcome: 'Passed', failing: 0, passing: 3 }, tests: APEX_RESULT.tests.slice(0, 2) };

describe('analysis executor', () => {
  it('needs review while untriaged findings at/above the gate exist, with report evidence', async () => {
    const h = harness({});
    const r = await h.analysis(h.ctx);
    expect(r.status).toBe('needs-review');
    expect(r.failure?.code).toBe('ANALYSIS_BLOCKERS');
    expect(r.evidence?.some(e => e.kind === 'code-analyzer-report')).toBe(true);
    expect(h.quality.get().analysis?.sourceFingerprint).toBe('fp1');
  });
  it('passes once the blocker is triaged with a justification, or the gate is relaxed', async () => {
    const h = harness({});
    const first = await h.analysis(h.ctx);
    expect(first.status).toBe('needs-review');
    const key = h.quality.get().analysis!.findings.find(f => f.severity === 2)!.key;
    h.triage.add(key, 'Verified: object is system-owned, CRUD not applicable', 'tester');
    expect((await h.analysis(h.ctx)).status).toBe('passed');
    expect((await harness({ settings: { severityGate: 'critical' } }).analysis(h.ctx)).status).toBe('passed');
  });
});

describe('tests executor', () => {
  it('fails without a validation org', async () => {
    const r = await harness({}).tests(harness({}).ctx);
    expect(r.failure?.code).toBe('NO_VALIDATION_ORG');
  });
  it('refuses the Dev Hub and expired orgs', async () => {
    const h1 = harness({ validation: hub });
    expect((await h1.tests(h1.ctx)).failure?.code).toBe('VALIDATION_ORG_IS_DEV_HUB');
    const h2 = harness({ validation: org({ expired: true }) });
    expect((await h2.tests(h2.ctx)).failure?.code).toBe('AUTH_EXPIRED');
  });
  it('does nothing in the org when the user declines', async () => {
    const h = harness({ validation: org(), confirm: false });
    const r = await h.tests(h.ctx);
    expect(r.status).toBe('blocked');
    expect(h.runner.calls).toHaveLength(0);
  });
  it('deploys, runs tests and passes with evidence when everything is green', async () => {
    const h = harness({ validation: org() });
    const r = await h.tests(h.ctx);
    expect(r.status).toBe('passed');
    expect(h.runner.calls.map(c => c.args.slice(0, 2).join(' '))).toEqual(['project deploy', 'apex run']);
    expect(r.evidence?.map(e => e.kind)).toEqual(expect.arrayContaining(['validation-deploy', 'apex-test-results', 'test-summary']));
    expect(h.quality.get().apex?.deployedLocalSource).toBe(true);
  });
  it('is only needs-review when source was not deployed', async () => {
    const h = harness({ validation: org(), settings: { deployBeforeTests: false } });
    const r = await h.tests(h.ctx);
    expect(r.status).toBe('needs-review');
    expect(r.failure?.code).toBe('SOURCE_NOT_VERIFIED_IN_ORG');
    expect(h.runner.calls.some(c => c.args[0] === 'project')).toBe(false);
  });
  it('fails on coverage below target', async () => {
    const h = harness({ validation: org(), settings: { coverageTargetPercent: 95 } });
    const r = await h.tests(h.ctx);
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/below the 95%/);
  });
  it('fails with failing-test details and stops before tests when deploy fails', async () => {
    const failing = harness({ validation: org(), handler: () => done() });
    const orig = failing.runner.run.bind(failing.runner);
    failing.runner.run = async req => (req.args[0] === 'apex' ? envelope(APEX_RESULT) : orig(req));
    const r = await failing.tests(failing.ctx);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('TESTS_FAILED');
    expect(r.failure?.detail).toMatch(/BarTest.breaks.*expected 1/);

    const dep = harness({ validation: org() });
    const orig2 = dep.runner.run.bind(dep.runner);
    dep.runner.run = async req => (req.args[1] === 'deploy' ? done(JSON.stringify({ status: 1, name: 'DeployError', message: 'compile error' }), 1) : orig2(req));
    const r2 = await dep.tests(dep.ctx);
    expect(r2.status).toBe('failed');
    expect(r2.message).toMatch(/Deployment/);
    expect(dep.runner.calls.some(c => c.args[0] === 'apex')).toBe(false);
  });
});

// ---------------------------------------------------------------- summary & messages
describe('summary report', () => {
  it('includes fingerprints, blockers, coverage disclaimer and never secrets', () => {
    const analysis = { at: 'now', workspace: 'w', selectors: ['Recommended'], versions: { pmd: '1' }, sourceFingerprint: 'fp9', findings: parseAnalyzerJson(REAL_REPORT, 'C:\\proj').findings, counts: { total: 3, Critical: 0, High: 1, Moderate: 1, Low: 1, Info: 0 }, jsonPath: 'x.json', warnings: ['pmd could not parse Broken.cls'] };
    const apex: ApexRun = { at: 'now', orgLabel: 'val (00D)', testLevel: 'RunLocalTests', deployedLocalSource: true, partial: false, sourceFingerprint: 'fp9', ...parseApexResult(APEX_RESULT) };
    const md = buildSummaryMarkdown({
      project: 'C:\\proj access_token=SECRET123', generatedAt: 'now', quality: { analysis, apex }, triage: [], gate: 'high', coverageTarget: 80,
      steps: { analysis: { id: 'analysis', status: 'needs-review', attempt: 1, evidence: [] }, tests: { id: 'tests', status: 'failed', attempt: 1, evidence: [] } } as never
    });
    expect(md).toContain('fp9');
    expect(md).toContain('ApexCRUDViolation');
    expect(md).toContain('BarTest.breaks');
    expect(md).toMatch(/not package-version coverage/);
    expect(md).not.toContain('SECRET123');
  });
});

describe('slice 3 message validation', () => {
  it('accepts quality actions and settings, rejects bad values', () => {
    expect(parseMessage({ type: 'openFile', key: 'rule|a.cls|1|msg' })).toBeDefined();
    expect(parseMessage({ type: 'triage', key: 'k' })).toBeDefined();
    expect(parseMessage({ type: 'openReport', ref: 'C:\\x\\r.json' })).toBeDefined();
    expect(parseMessage({ type: 'openReport', ref: 'a\nb' })).toBeUndefined();
    expect(parseMessage({ type: 'applyFix' })).toBeUndefined();
    expect(parseMessage({ type: 'selectValidationOrg', alias: 'val' })).toBeDefined();
    expect(parseMessage({ type: 'selectValidationOrg', alias: '--x' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'severityGate', value: 'high' })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'severityGate', value: 'whatever' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'testLevel', value: 'RunSpecifiedTests' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'deployBeforeTests', value: false })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'testWaitMinutes', value: 0 })).toBeUndefined();
    expect(parseMessage({ type: 'rerunFailed' })).toBeDefined();
  });
});
