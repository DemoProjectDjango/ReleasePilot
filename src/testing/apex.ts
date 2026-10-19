import * as fs from 'fs';
import * as path from 'path';
import { SfCli, SfError, assertAlias } from '../adapters/sfCli';

export type TestLevel = 'RunLocalTests' | 'RunAllTestsInOrg' | 'RunSpecifiedTests';
export const TEST_LEVELS: readonly TestLevel[] = ['RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests'];

export interface ApexTestCase {
  fullName: string;
  className: string;
  methodName: string;
  outcome: 'Pass' | 'Fail' | 'Skip' | 'CompileFail' | string;
  message?: string;
  stackTrace?: string;
  runTimeMs?: number;
}

export interface ClassCoverage {
  name: string;
  totalLines: number;
  coveredLines: number;
  percent: number;
}

export interface ApexRun {
  at: string;
  orgId?: string;
  orgLabel: string;
  testRunId?: string;
  testLevel: TestLevel;
  outcome: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  tests: ApexTestCase[];
  /** Org-wide percentage reported by Salesforce for the validation org. NOT package-version coverage. */
  orgWideCoverage?: number;
  testRunCoverage?: number;
  classes: ClassCoverage[];
  /** Whether local source was deployed to the org immediately before this run. */
  deployedLocalSource: boolean;
  sourceFingerprint?: string;
  rawPath?: string;
  /** True when only a subset of tests was executed (e.g. a failed-test rerun). Never sufficient to pass the gate. */
  partial: boolean;
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const n = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && /^-?\d+(\.\d+)?%?$/.test(v.trim())) {
    return parseFloat(v);
  }
  return undefined;
};

export function parseApexResult(result: unknown): Omit<ApexRun, 'at' | 'orgLabel' | 'testLevel' | 'deployedLocalSource' | 'partial' | 'sourceFingerprint' | 'rawPath'> {
  const r = o(result);
  const sum = o(r.summary);
  const tests: ApexTestCase[] = (Array.isArray(r.tests) ? r.tests : []).map(raw => {
    const t = o(raw);
    const cls = o(t.ApexClass);
    const className = s(cls.Name) ?? s(t.className) ?? 'Unknown';
    const methodName = s(t.MethodName) ?? s(t.methodName) ?? 'unknown';
    return {
      fullName: s(t.FullName) ?? `${className}.${methodName}`, className, methodName,
      outcome: s(t.Outcome) ?? s(t.outcome) ?? 'Unknown',
      message: s(t.Message) ?? s(t.message), stackTrace: s(t.StackTrace) ?? s(t.stackTrace),
      runTimeMs: n(t.RunTime) ?? n(t.runTime)
    };
  });
  const count = (o1: string) => tests.filter(t => t.outcome === o1).length;
  const covBlock = o(r.coverage);
  const classes: ClassCoverage[] = (Array.isArray(covBlock.coverage) ? covBlock.coverage : []).flatMap(raw => {
    const c = o(raw);
    const name = s(c.name);
    const total = n(c.totalLines);
    const covered = n(c.totalCovered);
    if (!name || total === undefined || covered === undefined) {
      return [];
    }
    return [{ name, totalLines: total, coveredLines: covered, percent: n(c.coveredPercent) ?? (total ? Math.round((covered / total) * 100) : 0) }];
  });
  const covSummary = o(covBlock.summary);
  return {
    orgId: s(sum.orgId), testRunId: s(sum.testRunId),
    outcome: s(sum.outcome) ?? 'Unknown',
    total: n(sum.testsRan) ?? tests.length,
    passed: n(sum.passing) ?? count('Pass'),
    failed: n(sum.failing) ?? tests.filter(t => t.outcome === 'Fail' || t.outcome === 'CompileFail').length,
    skipped: n(sum.skipped) ?? count('Skip'),
    tests,
    orgWideCoverage: n(sum.orgWideCoverage) ?? n(covSummary.orgWideCoverage),
    testRunCoverage: n(sum.testRunCoverage) ?? n(covSummary.testRunCoverage),
    classes
  };
}

export interface ApexGate {
  passed: boolean;
  /** Hard failures: failed tests, no tests, missing or low coverage, partial runs. */
  problems: string[];
  /** Tests passed but nothing proves the org holds the local source; needs a human decision. */
  sourceUnverified: boolean;
  coverage?: number;
  coverageLabel: string;
}

/**
 * Applies the quality gate. The coverage figure is org-wide coverage of the validation org and is labelled
 * as such; Salesforce's package-version coverage (>= 75%, all triggers covered) is verified at build time.
 */
export function evaluateApex(run: ApexRun, coverageTargetPercent: number): ApexGate {
  const problems: string[] = [];
  if (run.partial) {
    problems.push('Only a subset of tests was run; a full run is required.');
  }
  if (run.total === 0) {
    problems.push('No Apex tests were executed.');
  }
  if (run.failed > 0) {
    problems.push(`${run.failed} Apex test(s) failed.`);
  }
  if (run.outcome !== 'Passed' && run.failed === 0 && run.total > 0) {
    problems.push(`Salesforce reported the run outcome "${run.outcome}".`);
  }
  const coverage = run.orgWideCoverage ?? run.testRunCoverage;
  if (coverage === undefined) {
    problems.push('Salesforce returned no coverage figure.');
  } else if (coverage < coverageTargetPercent) {
    problems.push(`Org-wide coverage ${coverage}% is below the ${coverageTargetPercent}% target.`);
  }
  return {
    passed: problems.length === 0 && run.deployedLocalSource, problems, coverage, sourceUnverified: !run.deployedLocalSource,
    coverageLabel: coverage === undefined ? 'n/a' : `${coverage}% org-wide (validation org; not package-version coverage)`
  };
}

const NAME_RE = /^[A-Za-z0-9_.]{1,200}$/;

export interface RunApexOptions {
  root: string;
  org: string;
  orgLabel: string;
  level: TestLevel;
  waitMinutes: number;
  outputDir: string;
  /** Required when level is RunSpecifiedTests: "Class" or "Class.method". */
  tests?: string[];
  deployedLocalSource: boolean;
  sourceFingerprint?: string;
  signal?: AbortSignal;
}

export async function runApexTests(sf: SfCli, opts: RunApexOptions): Promise<ApexRun> {
  if (!TEST_LEVELS.includes(opts.level)) {
    throw new SfError('INVALID_ARGUMENT', `Unsupported test level "${opts.level}".`);
  }
  const wait = Math.min(Math.max(Math.floor(opts.waitMinutes), 1), 600);
  const args = ['apex', 'run', 'test', '--target-org', assertAlias(opts.org), '--test-level', opts.level,
    '--code-coverage', '--wait', String(wait)];
  if (opts.level === 'RunSpecifiedTests') {
    if (!opts.tests?.length) {
      throw new SfError('INVALID_ARGUMENT', 'RunSpecifiedTests needs at least one test.');
    }
    opts.tests.forEach(t => {
      if (!NAME_RE.test(t)) {
        throw new SfError('INVALID_ARGUMENT', `Invalid test name "${t}".`);
      }
      args.push('--tests', t);
    });
  }
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const { result } = await sf.json(args, { cwd: opts.root, signal: opts.signal, timeoutMs: (wait + 5) * 60_000 });
  const rawPath = path.join(opts.outputDir, `apex-tests-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  return {
    at: new Date().toISOString(), orgLabel: opts.orgLabel, testLevel: opts.level,
    deployedLocalSource: opts.deployedLocalSource, sourceFingerprint: opts.sourceFingerprint,
    partial: opts.level === 'RunSpecifiedTests', rawPath, ...parseApexResult(result)
  };
}

/** Deploys the project's package directories to the validation org so tests exercise the local source. */
export async function deployLocalSource(sf: SfCli, opts: { root: string; org: string; dirs: string[]; waitMinutes: number; signal?: AbortSignal }): Promise<{ id?: string; status?: string }> {
  if (!opts.dirs.length) {
    throw new SfError('NO_SOURCE_DIRS', 'The project has no package directories to deploy.');
  }
  const args = ['project', 'deploy', 'start', '--target-org', assertAlias(opts.org), '--wait', String(Math.max(1, Math.floor(opts.waitMinutes)))];
  opts.dirs.forEach(d => {
    if (d.startsWith('-') || /[\0\r\n]/.test(d)) {
      throw new SfError('INVALID_ARGUMENT', `Invalid package directory "${d}".`);
    }
    args.push('--source-dir', d);
  });
  const { result } = await sf.json<Record<string, unknown>>(args, { cwd: opts.root, signal: opts.signal, timeoutMs: (opts.waitMinutes + 5) * 60_000 });
  const r = o(result);
  if (r.success === false) {
    throw new SfError('DEPLOY_FAILED', `Deployment to the validation org did not succeed (status ${s(r.status) ?? 'unknown'}).`);
  }
  return { id: s(r.id), status: s(r.status) };
}
