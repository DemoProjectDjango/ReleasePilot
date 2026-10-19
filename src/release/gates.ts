import { createHash } from 'crypto';
import { AnalysisReport, SeverityGate, gateBlockers } from '../analysis/analyzer';
import { StepId, StepStatus } from '../core/models';
import { redact } from '../core/redact';
import { ExistingVersion, VersionReport } from '../packaging/parsers';
import { PackageCandidate } from '../packaging/store';
import { compareMmp, parseVersion } from '../packaging/versions';
import { QaEnvironment } from '../qa/store';
import { UpgradePath } from '../qa/upgradePath';
import { ApexRun, evaluateApex } from '../testing/apex';
import { LwcRun } from '../testing/lwc';
import type { Override } from './store';

export type GateStatus = 'pass' | 'fail' | 'warn' | 'na' | 'overridden';

export interface Gate {
  id: string;
  title: string;
  /** hard = Salesforce platform rule or a required evidence gate; never overridable. policy = local policy that a person may override with a justification. */
  kind: 'hard' | 'policy' | 'advisory';
  status: GateStatus;
  detail: string;
  remediation?: string;
  evidence: string[];
  override?: Override;
}

export interface ReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  project?: string;
  devHub: { alias: string; orgId: string };
  package: { id: string; name: string };
  candidate?: {
    versionId: string;
    version?: string;
    requestId?: string;
    coverage?: number;
    branch?: string;
    tag?: string;
    keyMode?: string;
    createdAt?: string;
  };
  sourceFingerprint?: string;
  gates: Gate[];
  hardBlockers: string[];
  policyBlockers: string[];
  warnings: string[];
  overrides: Override[];
  /** Ready = no failing hard gate and every failing policy gate carries an override. */
  ready: boolean;
  /** Hash binding the 04t, Dev Hub, package, source and the content of all evidence files. */
  evidenceHash: string;
  summary: {
    analysis?: string;
    tests?: string;
    coverage?: string;
    packageCoverage?: string;
  };
}

type StepInfo = { status: StepStatus; fingerprint?: string; message?: string };

export interface ReleaseInput {
  now: string;
  project?: string;
  devHub: { alias: string; orgId: string };
  pkg: { id: string; name: string };
  candidate?: PackageCandidate;
  /** Live `package version report` for the candidate; undefined when it could not be read. */
  live?: VersionReport;
  liveError?: string;
  versions: ExistingVersion[];
  git: { fingerprint?: string; dirtyCount: number };
  allowDirty: boolean;
  steps: Record<StepId, StepInfo>;
  analysis?: AnalysisReport;
  analysisGate: SeverityGate;
  triaged: ReadonlySet<string>;
  apex?: ApexRun;
  coverageTarget: number;
  lwc?: LwcRun;
  freshQa?: QaEnvironment;
  upgradeQa?: QaEnvironment;
  upgradePath: UpgradePath;
  overrides: Override[];
  /** SHA-256 of each evidence file's content, keyed by path. */
  evidenceFileHashes: Record<string, string>;
}

const OVERRIDABLE = new Set(['source-clean', 'org-coverage', 'lwc']);

export function evaluateRelease(i: ReleaseInput): ReadinessReport {
  const gates: Gate[] = [];
  const add = (g: Omit<Gate, 'evidence'> & { evidence?: string[] }) => gates.push({ evidence: [], ...g });
  const c = i.candidate;
  const fp = i.git.fingerprint;
  const stepOk = (id: StepId) => i.steps[id]?.status === 'passed';
  const stepNote = (id: StepId) => `${id} is ${i.steps[id]?.status ?? 'unknown'}`;

  // Identity: exactly one candidate 04t, owned by the selected package and Dev Hub.
  if (!c?.subscriberPackageVersionId) {
    add({ id: 'candidate', title: 'Candidate package version', kind: 'hard', status: 'fail', detail: 'There is no successfully built candidate for this package and Dev Hub.', remediation: 'Create a beta package from the current source.' });
  } else if (c.packageId !== i.pkg.id || c.devHubOrgId !== i.devHub.orgId) {
    add({ id: 'candidate', title: 'Candidate package version', kind: 'hard', status: 'fail', detail: 'The candidate belongs to a different package or Dev Hub than the one selected.', remediation: 'Select the Dev Hub and package that built it.' });
  } else {
    add({ id: 'candidate', title: 'Candidate package version', kind: 'hard', status: 'pass', detail: `${i.pkg.name} ${i.live?.version ?? c.versionNumber} = ${c.subscriberPackageVersionId} (request ${c.requestId}) on ${i.devHub.alias} (${i.devHub.orgId}).` });
  }

  // Live state from Salesforce, not from the local record.
  if (!i.live) {
    add({ id: 'package-state', title: 'Package version state in the Dev Hub', kind: 'hard', status: 'fail', detail: `The version could not be read from the Dev Hub${i.liveError ? `: ${i.liveError}` : ''}.`, remediation: 'Check the Dev Hub connection and run Release Readiness again.' });
  } else {
    const problems: string[] = [];
    if (i.live.packageId && i.live.packageId !== i.pkg.id) { problems.push(`it belongs to package ${i.live.packageId}`); }
    if (c?.subscriberPackageVersionId && i.live.subscriberPackageVersionId && i.live.subscriberPackageVersionId !== c.subscriberPackageVersionId) { problems.push('the Dev Hub returned a different 04t'); }
    if (i.live.isReleased) { problems.push('it is already released'); }
    add({
      id: 'package-state', title: 'Package version state in the Dev Hub', kind: 'hard', status: problems.length ? 'fail' : 'pass',
      detail: problems.length ? `Not promotable: ${problems.join('; ')}.` : 'The version exists in the selected package and is an unreleased beta.',
      remediation: problems.length ? 'Release only the intended, unreleased candidate.' : undefined
    });
    const covOk = i.live.codeCoverage !== undefined && i.live.codeCoverage >= 75 && i.live.hasPassedCodeCoverageCheck === true;
    add({
      id: 'package-coverage', title: 'Package-version code coverage (Salesforce minimum 75%, every trigger covered)', kind: 'hard', status: covOk ? 'pass' : 'fail',
      detail: covOk ? `${i.live.codeCoverage}% and Salesforce's coverage check passed.` : `Coverage ${i.live.codeCoverage ?? 'n/a'}%, check passed: ${String(i.live.hasPassedCodeCoverageCheck)}.`,
      remediation: covOk ? undefined : 'Raise package coverage (including triggers) and build a new version. This one cannot be promoted.'
    });
    add({
      id: 'build-validation', title: 'Full validation (no --skip-validation)', kind: 'hard', status: i.live.validationSkipped ? 'fail' : 'pass',
      detail: i.live.validationSkipped ? 'Validation was skipped; Salesforce does not allow promoting such a version.' : 'Validation was not skipped.',
      remediation: i.live.validationSkipped ? 'Build a new version without skipping validation.' : undefined
    });
  }

  // The package must be built from exactly the source that was validated.
  add({
    id: 'source', title: 'Package built from the validated source', kind: 'hard',
    status: c && fp && c.sourceFingerprint === fp && stepOk('source') ? 'pass' : 'fail',
    detail: !c ? 'No candidate.' : !fp ? 'The current source could not be fingerprinted.' : c.sourceFingerprint !== fp
      ? 'The source changed after the package was built; the 04t does not contain the current code.' : stepOk('source') ? `Candidate and current source match (${fp.slice(0, 12)}).` : `Source Ready: ${stepNote('source')}.`,
    remediation: 'Rebuild the package from the current source and re-validate.'
  });
  add({
    id: 'source-clean', title: 'Committed source', kind: 'policy', status: i.git.dirtyCount === 0 ? 'pass' : i.allowDirty ? 'warn' : 'fail',
    detail: i.git.dirtyCount === 0 ? 'The working tree is clean.' : `${i.git.dirtyCount} uncommitted change(s).`, remediation: 'Commit the changes (they would not be reproducible from Git otherwise).'
  });
  add({ id: 'identity', title: 'Dev Hub and package identity (Preflight)', kind: 'hard', status: stepOk('preflight') ? 'pass' : 'fail', detail: stepOk('preflight') ? 'Preflight verified the Dev Hub and package ownership.' : `Preflight: ${stepNote('preflight')}.`, remediation: 'Run Discover & Preflight.' });

  // Quality evidence.
  const aEvidence = i.analysis ? [i.analysis.jsonPath] : [];
  const blockers = i.analysis ? gateBlockers(i.analysis.findings, i.analysisGate, i.triaged).length : -1;
  const analysisFresh = !!i.analysis && !!fp && i.analysis.sourceFingerprint === fp;
  add({
    id: 'analysis', title: 'Static analysis (Code Analyzer v5)', kind: 'hard', status: stepOk('analysis') && analysisFresh && blockers === 0 && (i.analysis?.warnings.length ?? 0) === 0 ? 'pass' : 'fail',
    detail: !stepOk('analysis') ? `${stepNote('analysis')}.` : !analysisFresh ? 'The scan does not describe the current source.' : blockers > 0 ? `${blockers} untriaged finding(s) at or above ${i.analysisGate}.` : (i.analysis?.warnings.length ? 'The scan reported warnings and may be incomplete.' : `${i.analysis?.counts.total ?? 0} finding(s), none blocking.`),
    remediation: 'Fix or justify the findings and rescan.', evidence: aEvidence
  });
  const testsFresh = !!i.apex && !!fp && i.apex.sourceFingerprint === fp;
  const apexGate = i.apex ? evaluateApex(i.apex, i.coverageTarget) : undefined;
  const hardApexProblems = apexGate ? apexGate.problems.filter(p => !/below the/.test(p)) : [];
  add({
    id: 'tests', title: 'Apex tests', kind: 'hard',
    status: stepOk('tests') && testsFresh && i.apex && hardApexProblems.length === 0 && i.apex.deployedLocalSource ? 'pass' : 'fail',
    detail: !stepOk('tests') ? `${stepNote('tests')}.` : !testsFresh ? 'The test run does not describe the current source.' : !i.apex?.deployedLocalSource ? 'Local source was not deployed to the validation org.' : hardApexProblems.length ? hardApexProblems.join(' ') : `${i.apex?.passed}/${i.apex?.total} passed in ${i.apex?.orgLabel}.`,
    remediation: 'Run Pre-package Tests on the current source.', evidence: i.apex?.rawPath ? [i.apex.rawPath] : []
  });
  const cov = i.apex?.orgWideCoverage ?? i.apex?.testRunCoverage;
  add({
    id: 'org-coverage', title: `Internal org-wide coverage target (${i.coverageTarget}%)`, kind: 'policy', status: cov !== undefined && cov >= i.coverageTarget ? 'pass' : 'fail',
    detail: cov === undefined ? 'No org-wide coverage recorded.' : `${cov}% org-wide in the validation org (this is not package-version coverage).`, remediation: 'Add tests, or override with a justification.'
  });
  add({
    id: 'lwc', title: 'LWC Jest tests', kind: 'policy', status: !i.lwc || !i.lwc.configured ? 'na' : i.lwc.failed > 0 || i.lwc.installMissing ? 'fail' : 'pass',
    detail: !i.lwc || !i.lwc.configured ? 'Not configured for this project.' : i.lwc.installMissing ? (i.lwc.reason ?? 'Dependencies missing.') : `${i.lwc.passed}/${i.lwc.total} passed.`, remediation: 'Fix the failing LWC tests.'
  });

  // QA evidence: signed by a person, for this 04t and this source.
  const qaOk = (e?: QaEnvironment) => !!e && e.targetVersionId === c?.subscriberPackageVersionId && !!e.signoff && e.sourceFingerprint === fp && e.checklist.every(x => x.state === 'pass');
  add({
    id: 'fresh-qa', title: 'Clean-install QA (automation + signed manual checklist)', kind: 'hard', status: stepOk('clean-install-qa') && qaOk(i.freshQa) ? 'pass' : 'fail',
    detail: stepOk('clean-install-qa') && qaOk(i.freshQa) ? `Signed off by ${i.freshQa?.signoff?.approver} on ${i.freshQa?.signoff?.at} in ${i.freshQa?.alias}.` : `${stepNote('clean-install-qa')}; no matching signed QA for this exact version and source.`,
    remediation: 'Prepare a QA environment for this candidate and complete the checklist.', evidence: i.freshQa?.logRefs.slice(-2) ?? []
  });
  if (i.upgradePath.state === 'not-applicable') {
    add({ id: 'upgrade-qa', title: 'Upgrade QA', kind: 'hard', status: 'na', detail: i.upgradePath.reason });
  } else if (i.upgradePath.state === 'unsupported') {
    add({ id: 'upgrade-qa', title: 'Upgrade QA', kind: 'hard', status: 'fail', detail: `No supported upgrade path to test: ${i.upgradePath.reason}`, remediation: i.upgradePath.alternative });
  } else {
    const ok = stepOk('upgrade-qa') && qaOk(i.upgradeQa);
    add({
      id: 'upgrade-qa', title: 'Upgrade QA (previous released version to candidate)', kind: 'hard', status: ok ? 'pass' : 'fail',
      detail: ok ? `Signed off by ${i.upgradeQa?.signoff?.approver} (${i.upgradePath.baseline?.version} to ${i.live?.version ?? c?.versionNumber}).` : `${stepNote('upgrade-qa')}; upgrade QA from ${i.upgradePath.baseline?.version} is required for an existing product.`,
      remediation: 'Run the upgrade test and sign off its checklist.', evidence: i.upgradeQa?.logRefs.slice(-2) ?? []
    });
  }

  // Platform rule: a released major.minor.patch cannot be reused.
  const target = parseVersion(i.live?.version ?? c?.versionNumber);
  const clash = target ? i.versions.find(v => v.isReleased && v.subscriberPackageVersionId !== c?.subscriberPackageVersionId && (() => { const p = parseVersion(v.version); return !!p && compareMmp(p, target) === 0; })()) : undefined;
  add({
    id: 'version-uniqueness', title: 'Only one beta is promoted per version number', kind: 'hard', status: clash ? 'fail' : 'pass',
    detail: clash ? `${clash.version} is already released with the same major.minor.patch.` : 'No released version shares this major.minor.patch.', remediation: 'Increase the version number and build again.'
  });
  add({
    id: 'install-key', title: 'Installation key', kind: 'advisory', status: c?.keyMode === 'key' ? 'pass' : 'warn',
    detail: c?.keyMode === 'key' ? 'The version is protected by an installation key.' : 'Built with the key bypass: anyone with the install link can install it. Salesforce recommends a hard-to-guess key for released versions.'
  });

  // Apply overrides to failing overridable policy gates only.
  const used: Override[] = [];
  for (const g of gates) {
    if (g.kind === 'policy' && g.status === 'fail' && OVERRIDABLE.has(g.id)) {
      const o = i.overrides.find(x => x.gateId === g.id && x.versionId === c?.subscriberPackageVersionId && x.sourceFingerprint === fp);
      if (o) { g.status = 'overridden'; g.override = o; used.push(o); }
    }
  }
  const hardBlockers = gates.filter(g => g.kind === 'hard' && g.status === 'fail').map(g => `${g.title}: ${g.detail}`);
  const policyBlockers = gates.filter(g => g.kind === 'policy' && g.status === 'fail').map(g => `${g.title}: ${g.detail}`);
  const warnings = gates.filter(g => g.status === 'warn' || g.status === 'overridden').map(g => `${g.title}: ${g.status === 'overridden' ? `OVERRIDDEN by ${g.override?.owner} (${g.override?.reason})` : g.detail}`);

  const evidenceFiles = Object.keys(i.evidenceFileHashes).sort().map(k => [k, i.evidenceFileHashes[k]]);
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    version: c?.subscriberPackageVersionId, hub: i.devHub.orgId, pkg: i.pkg.id, source: fp, gates: gates.map(g => [g.id, g.status]), evidenceFiles
  })).digest('hex');

  return {
    schemaVersion: 1, generatedAt: i.now, project: i.project, devHub: i.devHub, package: i.pkg,
    candidate: c?.subscriberPackageVersionId ? { versionId: c.subscriberPackageVersionId, version: i.live?.version ?? c.versionNumber, requestId: c.requestId, coverage: i.live?.codeCoverage ?? c.coveragePercent, branch: c.branch, tag: c.tag, keyMode: c.keyMode, createdAt: c.createdAt } : undefined,
    sourceFingerprint: fp, gates, hardBlockers, policyBlockers, warnings, overrides: used,
    ready: hardBlockers.length === 0 && policyBlockers.length === 0, evidenceHash,
    summary: {
      analysis: i.analysis ? `${i.analysis.counts.total} finding(s); ${blockers} blocking` : undefined,
      tests: i.apex ? `${i.apex.passed}/${i.apex.total} passed in ${i.apex.orgLabel}` : undefined,
      coverage: cov !== undefined ? `${cov}% org-wide (validation org, not package coverage)` : undefined,
      packageCoverage: i.live?.codeCoverage !== undefined ? `${i.live.codeCoverage}% (Salesforce check ${i.live.hasPassedCodeCoverageCheck ? 'passed' : 'NOT passed'})` : undefined
    }
  };
}

const ICON: Record<GateStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', na: 'N/A', overridden: 'OVERRIDDEN' };

export function renderMarkdown(r: ReadinessReport): string {
  const L: string[] = [];
  L.push('# ReleasePilot release readiness report', '', `- Generated: ${r.generatedAt}`, `- Project: ${r.project ?? '(none)'}`,
    `- Package: ${r.package.name} (${r.package.id})`, `- Dev Hub: ${r.devHub.alias} (${r.devHub.orgId})`,
    `- Candidate: ${r.candidate ? `${r.candidate.version ?? ''} ${r.candidate.versionId} (request ${r.candidate.requestId ?? 'n/a'})` : 'none'}`,
    `- Source fingerprint: ${r.sourceFingerprint ?? 'unknown'}`, `- Evidence hash: ${r.evidenceHash}`,
    `- **Verdict: ${r.ready ? 'READY for promotion approval' : 'NOT READY'}**`, '');
  L.push('## Summary', '', `- Static analysis: ${r.summary.analysis ?? 'n/a'}`, `- Apex tests: ${r.summary.tests ?? 'n/a'}`, `- Org-wide coverage: ${r.summary.coverage ?? 'n/a'}`, `- Package-version coverage: ${r.summary.packageCoverage ?? 'n/a'}`, '');
  L.push('## Gates', '', '| Gate | Type | Result | Detail |', '|---|---|---|---|');
  r.gates.forEach(g => L.push(`| ${g.title} | ${g.kind} | ${ICON[g.status]} | ${g.detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`));
  if (r.hardBlockers.length) { L.push('', '## Blockers that cannot be overridden', '', ...r.hardBlockers.map(b => `- ${b}`)); }
  if (r.policyBlockers.length) { L.push('', '## Policy checks needing a decision', '', ...r.policyBlockers.map(b => `- ${b}`)); }
  if (r.warnings.length) { L.push('', '## Remaining warnings', '', ...r.warnings.map(b => `- ${b}`)); }
  if (r.overrides.length) { L.push('', '## Overrides', '', '| Gate | Owner | When | Reason |', '|---|---|---|---|', ...r.overrides.map(o => `| ${o.gateId} | ${o.owner} | ${o.at} | ${o.reason.replace(/\|/g, '\\|')} |`)); }
  L.push('', '## Promotion impact', '', '- Promotion is permanent: a released version can never return to beta.', '- Only one beta can be promoted per version number; development continues on a higher version.',
    '- Released versions can be installed in production orgs and be used for subscriber upgrades.', '- This report is not a promotion. Promotion needs separate explicit approval.');
  return redact(L.join('\n')) + '\n';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderHtml(r: ReadinessReport): string {
  const rows = r.gates.map(g => `<tr class="${g.status}"><td>${esc(g.title)}</td><td>${g.kind}</td><td>${ICON[g.status]}</td><td>${esc(g.detail)}</td></tr>`).join('\n');
  const list = (title: string, items: string[]) => items.length ? `<h2>${title}</h2><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release readiness report</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:.35rem .5rem;text-align:left;vertical-align:top}.fail td:nth-child(3){font-weight:700;color:#a00}.pass td:nth-child(3){color:#060}.verdict{font-size:1.2rem;font-weight:700}code{word-break:break-all}</style></head><body>
<h1>ReleasePilot release readiness report</h1>
<p>Generated ${esc(r.generatedAt)}<br>Package ${esc(r.package.name)} (${esc(r.package.id)})<br>Dev Hub ${esc(r.devHub.alias)} (${esc(r.devHub.orgId)})<br>Candidate ${esc(r.candidate?.version ?? '')} <code>${esc(r.candidate?.versionId ?? 'none')}</code><br>Source <code>${esc(r.sourceFingerprint ?? 'unknown')}</code><br>Evidence hash <code>${esc(r.evidenceHash)}</code></p>
<p class="verdict">${r.ready ? 'READY for promotion approval' : 'NOT READY'}</p>
<table><thead><tr><th>Gate</th><th>Type</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
${list('Blockers that cannot be overridden', r.hardBlockers)}${list('Policy checks needing a decision', r.policyBlockers)}${list('Remaining warnings', r.warnings)}
<h2>Promotion impact</h2><p>Promotion is permanent and cannot be reverted. Only one beta can be promoted per version number. This report is not a promotion.</p></body></html>`;
  return redact(html);
}
