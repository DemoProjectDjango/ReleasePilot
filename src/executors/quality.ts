import { randomUUID } from 'crypto';
import { SfCli, SfError } from '../adapters/sfCli';
import { ProcessRunner } from '../adapters/processRunner';
import { GitSnapshot } from '../adapters/git';
import { SeverityGate, gateBlockers, runCodeAnalyzer } from '../analysis/analyzer';
import { TriageStore } from '../analysis/triage';
import { Evidence, StepExecutor, StepResult } from '../core/models';
import { DiscoveryService } from '../discovery/discoveryService';
import { QualityStore } from '../testing/qualityStore';
import { TestLevel, deployLocalSource, evaluateApex, runApexTests } from '../testing/apex';
import { runLwcJest } from '../testing/lwc';
import { ReportWriter, sha256 } from './reportWriter';

export interface QualitySettings {
  ruleSelectors: string[];
  severityGate: SeverityGate;
  testLevel: TestLevel;
  deployBeforeTests: boolean;
  waitMinutes: number;
  coverageTargetPercent: number;
}

export interface QualityDeps {
  sf: SfCli;
  runner: ProcessRunner;
  discovery: DiscoveryService;
  reports: ReportWriter;
  reportsDir: string;
  quality: QualityStore;
  triage: TriageStore;
  getRoot: () => string | undefined;
  settings: () => QualitySettings;
  git: (root: string) => Promise<GitSnapshot>;
  /** Asks the user before any operation that writes to or runs inside a remote org. */
  confirm: (title: string, detail: string) => Promise<boolean>;
}

const ev = (kind: string, label: string, ref: string): Evidence => ({ id: randomUUID(), kind, label, ref, createdAt: new Date().toISOString() });

const failed = (code: string, message: string, remediation?: string, detail?: string): StepResult =>
  ({ status: 'failed', message, failure: { code, message, remediation, detail } });

export function createQualityExecutors(d: QualityDeps): { analysis: StepExecutor; tests: StepExecutor } {
  const analysis: StepExecutor = async ctx => {
    const root = d.getRoot();
    if (!root) {
      return failed('NO_WORKSPACE', 'No workspace folder is open.');
    }
    const cfg = d.settings();
    const git = await d.git(root);
    ctx.log('info', `Running Code Analyzer (${cfg.ruleSelectors.join(', ')})...`);
    let report;
    try {
      report = await runCodeAnalyzer(d.sf, { root, outputDir: d.reportsDir, selectors: cfg.ruleSelectors, signal: ctx.signal });
    } catch (e) {
      if (e instanceof SfError) {
        return failed(e.code, e.message, e.remediation);
      }
      throw e;
    }
    report.sourceFingerprint = git.fingerprint;
    d.quality.update({ analysis: report });

    const triaged = d.triage.keys();
    const blockers = gateBlockers(report.findings, cfg.severityGate, triaged);
    const evidence: Evidence[] = [ev('code-analyzer-report', 'Code Analyzer JSON report', report.jsonPath)];
    if (report.htmlPath) {
      evidence.push(ev('code-analyzer-report', 'Code Analyzer HTML report', report.htmlPath));
    }
    evidence.push(d.reports.write('analysis-summary', 'Analysis summary', {
      selectors: report.selectors, versions: report.versions, counts: report.counts, gate: cfg.severityGate,
      blockers: blockers.length, triaged: report.findings.filter(f => triaged.has(f.key)).length, sourceFingerprint: git.fingerprint
    }));
    const fingerprint = sha256(JSON.stringify([git.fingerprint, report.selectors, report.versions, cfg.severityGate, [...triaged].sort()]));
    const c = report.counts;
    const summary = `${c.total} finding(s): ${c.Critical} critical, ${c.High} high, ${c.Moderate} moderate, ${c.Low} low.`;
    if (report.warnings.length) {
      // A warning (e.g. a file the engine could not parse) means the scan may be incomplete; never pass on it.
      return {
        status: 'needs-review', evidence, fingerprint, message: `${summary} Code Analyzer printed ${report.warnings.length} warning line(s); the scan may be incomplete.`,
        failure: {
          code: 'ANALYZER_WARNINGS', message: 'Code Analyzer reported warnings, so some files or rules may not have been analyzed.',
          detail: report.warnings.slice(0, 12).join('\n'),
          remediation: 'Fix the cause (for example Apex that does not compile) and rescan. A clean result is only valid when the analyzer runs without warnings.'
        }
      };
    }
    if (blockers.length) {
      return {
        status: 'needs-review', evidence, fingerprint, message: `${summary} ${blockers.length} untriaged finding(s) at or above ${cfg.severityGate}.`,
        failure: {
          code: 'ANALYSIS_BLOCKERS', message: `${blockers.length} finding(s) at or above ${cfg.severityGate} severity block the pipeline.`,
          remediation: 'Fix them in source and rescan, or triage each with a justification in the Quality tab.'
        }
      };
    }
    return { status: 'passed', evidence, fingerprint, message: `${summary} No untriaged findings at or above ${cfg.severityGate}.` };
  };

  const tests: StepExecutor = async ctx => {
    const root = d.getRoot();
    if (!root) {
      return failed('NO_WORKSPACE', 'No workspace folder is open.');
    }
    const snap = d.discovery.snapshot;
    const org = snap.validationOrg;
    const cfg = d.settings();
    if (!org) {
      return failed('NO_VALIDATION_ORG', 'No validation org is selected.', 'Select a scratch or sandbox validation org in the dashboard. It must not be your Dev Hub.');
    }
    if (snap.devHub && snap.devHub.orgId === org.orgId) {
      return failed('VALIDATION_ORG_IS_DEV_HUB', 'The validation org is the Dev Hub. Tests and deployments must not run there.', 'Choose a scratch org or sandbox.');
    }
    if (org.expired) {
      return failed('AUTH_EXPIRED', 'The validation org authorization has expired.', 'Re-authenticate with "sf org login web".');
    }
    const label = `${org.alias ?? org.username} (${org.orgId})`;
    const dirs = (snap.project?.packageDirectories ?? []).filter(p => p.exists && p.path).map(p => p.path);
    const orgKind = org.isScratch ? 'scratch org' : org.isSandbox ? 'sandbox' : 'production/developer org';
    const approved = await d.confirm(
      `Run Apex tests in ${label}?`,
      `Target: ${label}, ${orgKind}.\n` +
      (cfg.deployBeforeTests ? `ReleasePilot will FIRST DEPLOY these local directories to the org: ${dirs.join(', ')}.\n` : 'Local source will NOT be deployed; results may not describe your local code.\n') +
      `Then it runs ${cfg.testLevel} and collects coverage.`);
    if (!approved) {
      return { status: 'blocked', message: 'Declined: no operation was performed in the validation org.' };
    }
    const git = await d.git(root);
    const evidence: Evidence[] = [];
    let deployed = false;
    if (cfg.deployBeforeTests) {
      ctx.log('info', `Deploying ${dirs.join(', ')} to ${label}...`);
      try {
        const dep = await deployLocalSource(d.sf, { root, org: org.alias ?? org.username, dirs, waitMinutes: cfg.waitMinutes, signal: ctx.signal });
        deployed = true;
        evidence.push(d.reports.write('validation-deploy', `Deployed local source to ${label}`, { org: label, dirs, deployId: dep.id, status: dep.status, sourceFingerprint: git.fingerprint }));
      } catch (e) {
        if (e instanceof SfError) {
          return failed(e.code, `Deployment to the validation org failed: ${e.message}`, e.remediation ?? 'Fix the deployment errors and retry. No tests were run.');
        }
        throw e;
      }
    }
    ctx.log('info', `Running ${cfg.testLevel} in ${label}...`);
    let apex;
    try {
      apex = await runApexTests(d.sf, {
        root, org: org.alias ?? org.username, orgLabel: label, level: cfg.testLevel, waitMinutes: cfg.waitMinutes,
        outputDir: d.reportsDir, deployedLocalSource: deployed, sourceFingerprint: git.fingerprint, signal: ctx.signal
      });
    } catch (e) {
      if (e instanceof SfError) {
        return { status: e.code === 'TIMEOUT' ? 'needs-review' : 'failed', evidence, message: e.message,
          failure: { code: e.code, message: e.message, remediation: e.remediation ?? 'Check the Apex Test Execution page in the org, then retry.' } };
      }
      throw e;
    }
    if (apex.rawPath) {
      evidence.push(ev('apex-test-results', `Apex test results (${label})`, apex.rawPath));
    }
    const gate = evaluateApex(apex, cfg.coverageTargetPercent);

    ctx.log('info', 'Checking LWC Jest configuration...');
    const lwc = await runLwcJest(d.runner, root, d.reportsDir, ctx.signal);
    if (lwc.rawPath) {
      evidence.push(ev('lwc-jest-results', 'LWC Jest results', lwc.rawPath));
    }
    d.quality.update({ apex, lwc });
    const problems = [...gate.problems];
    if (lwc.configured && lwc.failed > 0) {
      problems.push(`${lwc.failed} LWC Jest test(s) failed.`);
    }
    evidence.push(d.reports.write('test-summary', 'Test and coverage summary', {
      org: label, level: apex.testLevel, outcome: apex.outcome, total: apex.total, passed: apex.passed, failed: apex.failed, skipped: apex.skipped,
      coverage: gate.coverageLabel, coverageTargetPercent: cfg.coverageTargetPercent,
      note: 'Org-wide coverage is not package-version coverage. Salesforce requires >= 75% package-version coverage and every package trigger covered; that is verified when the beta package is built.',
      lwc: { configured: lwc.configured, reason: lwc.reason, total: lwc.total, failed: lwc.failed },
      deployedLocalSource: deployed, problems, sourceFingerprint: git.fingerprint
    }));
    const fingerprint = sha256(JSON.stringify([git.fingerprint, org.orgId, cfg.testLevel, deployed]));
    const lwcNote = lwc.configured ? `LWC Jest ${lwc.passed}/${lwc.total}.` : `LWC Jest not configured.`;
    const summary = `Apex ${apex.passed}/${apex.total} passed, coverage ${gate.coverageLabel}. ${lwcNote}`;

    if (lwc.installMissing) {
      return { status: 'needs-review', evidence, fingerprint, message: `${summary} ${lwc.reason}`, failure: { code: 'LWC_DEPS_MISSING', message: lwc.reason ?? 'LWC Jest dependencies missing.', remediation: 'Run "npm install" in the project and retry.' } };
    }
    if (problems.length) {
      const bad = apex.tests.filter(t => t.outcome !== 'Pass' && t.outcome !== 'Skip').slice(0, 20)
        .map(t => `${t.fullName}: ${t.message ?? t.outcome}`).join('\n');
      return { status: 'failed', evidence, fingerprint, message: `${summary} ${problems.join(' ')}`, failure: { code: apex.failed > 0 ? 'TESTS_FAILED' : 'QUALITY_GATE_FAILED', message: problems.join(' '), detail: bad || undefined, remediation: 'Fix the issues and run the step again. Dependent steps stay blocked.' } };
    }
    if (gate.sourceUnverified) {
      return { status: 'needs-review', evidence, fingerprint, message: `${summary} Local source was not deployed by ReleasePilot.`, failure: { code: 'SOURCE_NOT_VERIFIED_IN_ORG', message: 'Tests passed, but nothing proves the validation org contains the current local source.', remediation: 'Enable "releasepilot.deployBeforeTests" so ReleasePilot deploys the local source before testing.' } };
    }
    return { status: 'passed', evidence, fingerprint, message: summary };
  };

  return { analysis, tests };
}
