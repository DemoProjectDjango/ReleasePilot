import { Triage, gateBlockers, SeverityGate } from '../analysis/analyzer';
import { StepId, StepState } from '../core/models';
import { redact } from '../core/redact';
import { evaluateApex } from './apex';
import { QualityState } from './qualityStore';

export interface SummaryInput {
  project?: string;
  generatedAt: string;
  quality: QualityState;
  triage: Triage[];
  gate: SeverityGate;
  coverageTarget: number;
  steps: Record<StepId, StepState>;
}

const cell = (s: string | number | undefined) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Human-readable quality report (analysis, tests, coverage) identifying project, org, fingerprint and status. */
export function buildSummaryMarkdown(i: SummaryInput): string {
  const L: string[] = [];
  const { analysis, apex, lwc } = i.quality;
  L.push('# ReleasePilot quality summary', '', `- Project: ${i.project ?? '(none)'}`, `- Generated: ${i.generatedAt}`);
  L.push('', '## Step status', '', '| Step | Status | Message |', '|---|---|---|');
  for (const id of ['analysis', 'tests'] as StepId[]) {
    const s = i.steps[id];
    L.push(`| ${id} | ${s.status} | ${cell(s.message)} |`);
  }

  L.push('', '## Static analysis (Salesforce Code Analyzer v5)', '');
  if (!analysis) {
    L.push('No scan has been run.');
  } else {
    const triaged = new Set(i.triage.map(t => t.key));
    const blockers = gateBlockers(analysis.findings, i.gate, triaged);
    L.push(`- Scan time: ${analysis.at}`, `- Source fingerprint: ${analysis.sourceFingerprint ?? 'unknown'}`,
      `- Rule selectors: ${analysis.selectors.join(', ')}`, `- Engine versions: ${Object.entries(analysis.versions).map(([k, v]) => `${k} ${v}`).join(', ')}`,
      `- Findings: ${analysis.counts.total} (critical ${analysis.counts.Critical}, high ${analysis.counts.High}, moderate ${analysis.counts.Moderate}, low ${analysis.counts.Low})`,
      `- Gate: block at ${i.gate} and above; ${blockers.length} untriaged blocker(s)`);
    if (analysis.warnings?.length) {
      L.push('- WARNING: the analyzer printed warnings, so the scan may be incomplete:', ...analysis.warnings.slice(0, 10).map(w => `  - ${w}`));
    }
    if (blockers.length) {
      L.push('', '| Severity | Rule | Location | Message |', '|---|---|---|---|');
      blockers.slice(0, 100).forEach(f => L.push(`| ${f.severityLabel} | ${f.rule} | ${f.file}:${f.line} | ${cell(f.message)} |`));
    }
    if (i.triage.length) {
      L.push('', '### Triage decisions', '', '| Finding | Owner | When | Reason |', '|---|---|---|---|');
      i.triage.forEach(t => L.push(`| ${cell(t.key)} | ${t.owner} | ${t.at} | ${cell(t.reason)} |`));
    }
  }

  L.push('', '## Tests and coverage', '');
  if (!apex) {
    L.push('No Apex test run recorded.');
  } else {
    const gate = evaluateApex(apex, i.coverageTarget);
    L.push(`- Org: ${apex.orgLabel}`, `- Run: ${apex.testRunId ?? 'n/a'} (${apex.testLevel}) at ${apex.at}`,
      `- Source fingerprint: ${apex.sourceFingerprint ?? 'unknown'}; local source deployed by ReleasePilot: ${apex.deployedLocalSource ? 'yes' : 'no'}`,
      `- Result: ${apex.passed}/${apex.total} passed, ${apex.failed} failed, ${apex.skipped} skipped (outcome ${apex.outcome})`,
      `- Coverage: ${gate.coverageLabel}; internal target ${i.coverageTarget}%`,
      '- Note: this is org-wide coverage of the validation org, not package-version coverage. Salesforce requires at least 75% package-version coverage and every package trigger covered; that is verified when the beta package is built.');
    gate.problems.forEach(p => L.push(`- PROBLEM: ${p}`));
    const bad = apex.tests.filter(t => t.outcome !== 'Pass' && t.outcome !== 'Skip');
    if (bad.length) {
      L.push('', '### Failed tests', '');
      bad.forEach(t => L.push(`- **${t.fullName}** (${t.outcome}): ${cell(t.message)}`, ...(t.stackTrace ? ['  ```', ...t.stackTrace.split('\n').map(x => `  ${x}`), '  ```'] : [])));
    }
    const low = [...apex.classes].sort((a, b) => a.percent - b.percent).slice(0, 15);
    if (low.length) {
      L.push('', '### Lowest class coverage', '', '| Class | Covered | Lines | % |', '|---|---|---|---|');
      low.forEach(c => L.push(`| ${c.name} | ${c.coveredLines} | ${c.totalLines} | ${c.percent} |`));
    }
  }
  L.push('', '### LWC Jest', '', lwc ? (lwc.configured ? `${lwc.passed}/${lwc.total} passed, ${lwc.failed} failed.` : `NOT_CONFIGURED: ${lwc.reason}`) : 'Not run.');
  return redact(L.join('\n')) + '\n';
}
