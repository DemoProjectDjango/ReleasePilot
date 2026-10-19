import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { GitSnapshot } from '../adapters/git';
import { SfCli, SfError } from '../adapters/sfCli';
import { SeverityGate } from '../analysis/analyzer';
import { TriageStore } from '../analysis/triage';
import { Evidence, StepExecutor, StepId, StepResult, StepState } from '../core/models';
import { DiscoveryService } from '../discovery/discoveryService';
import { fetchVersionReport, listAllVersions } from '../packaging/build';
import { PackagingStore, PackageCandidate } from '../packaging/store';
import { VersionReport } from '../packaging/parsers';
import { QaStore } from '../qa/store';
import { evaluateUpgradePath } from '../qa/upgradePath';
import { ReadinessReport, ReleaseInput, evaluateRelease, renderHtml, renderMarkdown } from '../release/gates';
import { installLinks, nextSteps, promoteVersion } from '../release/promote';
import { ReleaseStore } from '../release/store';
import { QualityStore } from '../testing/qualityStore';
import { ReportWriter } from './reportWriter';

export interface ApprovalToken {
  versionId: string;
  evidenceHash: string;
  approver: string;
  /** Epoch ms when the person confirmed. */
  at: number;
}

export interface ReleaseDeps {
  sf: SfCli;
  discovery: DiscoveryService;
  reports: ReportWriter;
  reportsDir: string;
  quality: QualityStore;
  packaging: PackagingStore;
  qa: QaStore;
  release: ReleaseStore;
  triage: TriageStore;
  getRoot: () => string | undefined;
  git: (root: string) => Promise<GitSnapshot>;
  steps: () => Record<StepId, StepState>;
  settings: () => { severityGate: SeverityGate; coverageTarget: number; allowDirty: boolean };
  /** One-shot human approval captured by the UI immediately before promotion; consumed (cleared) on read. */
  takeApproval: () => ApprovalToken | undefined;
  now?: () => Date;
}

const APPROVAL_TTL_MS = 10 * 60_000;
const failed = (code: string, message: string, remediation?: string, detail?: string): StepResult =>
  ({ status: 'failed', message, failure: { code, message, remediation, detail } });

const hashFile = (file: string): string | undefined => {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
};

export function createReleaseExecutors(d: ReleaseDeps): { 'release-review': StepExecutor; promotion: StepExecutor } {
  const now = () => (d.now ?? (() => new Date()))();

  /** Re-reads Salesforce and local evidence, then evaluates every gate. Nothing here changes any state. */
  const gather = async (signal?: AbortSignal): Promise<{ report: ReadinessReport; candidate?: PackageCandidate; live?: VersionReport } | StepResult> => {
    const root = d.getRoot();
    const snap = d.discovery.snapshot;
    if (!root || !snap.devHub || !snap.selectedPackage) {
      return failed('NO_PACKAGE_CONTEXT', 'Dev Hub or package context is missing.', 'Run Discover & Preflight.');
    }
    const hub = snap.devHub.alias ?? snap.devHub.username;
    const pkg = { id: snap.selectedPackage.id, name: snap.selectedPackage.name };
    const git = await d.git(root);
    const cx = { root, signal };
    const all = d.packaging.candidates().filter(c => c.packageId === pkg.id && c.devHubOrgId === snap.devHub!.orgId && c.status === 'Success' && !!c.subscriberPackageVersionId);
    const candidate = all.find(c => c.sourceFingerprint === git.fingerprint) ?? all[0];
    let live: VersionReport | undefined;
    let liveError: string | undefined;
    let versions: Awaited<ReturnType<typeof listAllVersions>> = [];
    try {
      versions = await listAllVersions(d.sf, hub, pkg.id, cx);
      if (candidate?.subscriberPackageVersionId) {
        live = await fetchVersionReport(d.sf, hub, candidate.subscriberPackageVersionId, cx);
      }
    } catch (e) {
      liveError = e instanceof SfError ? e.message : String(e);
    }
    const steps = d.steps();
    const versionId = candidate?.subscriberPackageVersionId;
    const signed = (kind: 'fresh-install' | 'upgrade') => d.qa.list().find(e => e.kind === kind && e.targetVersionId === versionId && !!e.signoff);
    const q = d.quality.get();
    const evidenceFileHashes: Record<string, string> = {};
    for (const id of ['analysis', 'tests', 'package-build', 'clean-install-qa', 'upgrade-qa'] as StepId[]) {
      for (const e of steps[id].evidence) {
        const h = hashFile(e.ref);
        if (h) { evidenceFileHashes[e.ref] = h; }
      }
    }
    const settings = d.settings();
    const input: ReleaseInput = {
      now: now().toISOString(), project: root, devHub: { alias: hub, orgId: snap.devHub.orgId }, pkg, candidate, live, liveError, versions,
      git: { fingerprint: git.fingerprint, dirtyCount: git.files.length }, allowDirty: settings.allowDirty, steps,
      analysis: q.analysis, analysisGate: settings.severityGate, triaged: d.triage.keys(), apex: q.apex, coverageTarget: settings.coverageTarget, lwc: q.lwc,
      freshQa: signed('fresh-install'), upgradeQa: signed('upgrade'),
      upgradePath: versionId ? evaluateUpgradePath(versions, versionId) : { state: 'unsupported', reason: 'No candidate.' },
      overrides: d.release.overrides(), evidenceFileHashes
    };
    return { report: evaluateRelease(input), candidate, live };
  };

  const review: StepExecutor = async ctx => {
    ctx.log('info', 'Re-verifying every release gate against Salesforce and the saved evidence...');
    const g = await gather(ctx.signal);
    if ('status' in g) {
      return g;
    }
    const { report } = g;
    d.release.setLastReport(report);
    const evidence: Evidence[] = [
      d.reports.write('release-readiness-json', 'Release readiness report (JSON)', report),
      writeText(d, 'release-readiness-md', 'Release readiness report (Markdown)', 'md', renderMarkdown(report)),
      writeText(d, 'release-readiness-html', 'Release readiness report (HTML)', 'html', renderHtml(report))
    ];
    if (report.hardBlockers.length) {
      return {
        status: 'failed', evidence, message: `${report.hardBlockers.length} blocker(s) prevent promotion.`,
        failure: { code: 'RELEASE_BLOCKED', message: report.hardBlockers[0], detail: report.hardBlockers.join('\n'), remediation: 'These cannot be overridden. Fix them (rebuild or re-test as needed) and run Release Readiness again.' }
      };
    }
    if (report.policyBlockers.length) {
      return {
        status: 'needs-review', evidence, message: `${report.policyBlockers.length} policy check(s) need a decision.`,
        failure: { code: 'POLICY_REVIEW_REQUIRED', message: report.policyBlockers[0], detail: report.policyBlockers.join('\n'), remediation: 'Fix each, or override it with a written justification in the Release tab, then run Release Readiness again.' }
      };
    }
    return {
      status: 'passed', evidence, fingerprint: report.evidenceHash,
      message: `Ready: ${report.package.name} ${report.candidate?.version ?? ''} (${report.candidate?.versionId}) passed ${report.gates.filter(x => x.status === 'pass').length} gate(s)${report.overrides.length ? ` with ${report.overrides.length} override(s)` : ''}. Evidence ${report.evidenceHash.slice(0, 12)}.`
    };
  };

  const promotion: StepExecutor = async ctx => {
    const root = d.getRoot();
    const snap = d.discovery.snapshot;
    const reviewed = d.release.lastReport();
    const reviewStep = d.steps()['release-review'];
    if (!root || !snap.devHub || !snap.selectedPackage || !reviewed?.candidate) {
      return failed('NO_REVIEWED_CANDIDATE', 'There is no reviewed release candidate.', 'Run Release Readiness first.');
    }
    if (reviewStep.status !== 'passed' || reviewStep.fingerprint !== reviewed.evidenceHash || !reviewed.ready) {
      return failed('REVIEW_NOT_CURRENT', 'The readiness review is missing, stale or not ready.', 'Run Release Readiness again.');
    }
    const hub = snap.devHub.alias ?? snap.devHub.username;
    const versionId = reviewed.candidate.versionId;
    const cx = { root, signal: ctx.signal };

    // 1. Ask Salesforce first. If it is already released, never promote again: verify and record.
    let live: VersionReport;
    try {
      live = await fetchVersionReport(d.sf, hub, versionId, cx);
    } catch (e) {
      return { status: 'needs-review', message: 'Could not read the version state from the Dev Hub; nothing was promoted.',
        failure: { code: e instanceof SfError ? e.code : 'UNEXPECTED', message: e instanceof Error ? e.message : String(e), remediation: 'Fix the connection and run the step again. ReleasePilot re-queries before it ever promotes.' } };
    }
    const prior = d.release.promotion(versionId);
    let verifiedOnly = false;
    let approver = prior?.approver ?? 'unknown';
    let cliNote = '';

    if (!live.isReleased) {
      // 2. Needs fresh, matching, single-use human approval.
      const token = d.takeApproval();
      if (!token || token.versionId !== versionId || token.evidenceHash !== reviewed.evidenceHash || now().getTime() - token.at > APPROVAL_TTL_MS) {
        return { status: 'blocked', message: 'No valid explicit approval for this exact version; nothing was promoted.', failure: { code: 'APPROVAL_REQUIRED', message: 'Promotion needs a fresh, explicit confirmation of this exact 04t.', remediation: 'Use Approve & Promote in the Release tab.' } };
      }
      approver = token.approver;
      // 3. The world must still match what was reviewed.
      const again = await gather(ctx.signal);
      if ('status' in again) {
        return again;
      }
      if (!again.report.ready || again.report.evidenceHash !== reviewed.evidenceHash) {
        return failed('REVIEW_DRIFTED', 'Evidence changed since the readiness review; nothing was promoted.', 'Run Release Readiness again and approve the new result.', again.report.hardBlockers.concat(again.report.policyBlockers).join('\n') || 'The evidence hash differs.');
      }
      // 4. Record the attempt BEFORE the irreversible call so an interruption is recoverable.
      d.release.setPromotion({ versionId, packageId: snap.selectedPackage.id, devHubOrgId: snap.devHub.orgId, devHubAlias: hub, status: 'attempting', approver, evidenceHash: reviewed.evidenceHash, startedAt: now().toISOString() });
      ctx.log('warn', `Promoting ${versionId} on ${hub} (approved by ${approver}).`);
      const outcome = await promoteVersion(d.sf, versionId, hub, cx);
      cliNote = outcome.message ?? 'CLI reported success.';
      try {
        live = await fetchVersionReport(d.sf, hub, versionId, cx);
      } catch (e) {
        return { status: 'needs-review', message: 'The promote command ran but its result could not be verified. Do NOT retry blindly.',
          failure: { code: 'PROMOTION_UNVERIFIED', message: e instanceof Error ? e.message : String(e), remediation: 'Run this step again: it re-queries Salesforce first and will not promote a version that is already released.' } };
      }
      if (!live.isReleased) {
        d.release.setPromotion({ versionId, packageId: snap.selectedPackage.id, devHubOrgId: snap.devHub.orgId, devHubAlias: hub, status: 'failed', approver, evidenceHash: reviewed.evidenceHash, startedAt: now().toISOString(), completedAt: now().toISOString(), error: cliNote });
        return failed('PROMOTION_FAILED', `Salesforce did not release the version. ${cliNote}`, 'Read the Salesforce message, fix the cause and run the step again (a new approval is required).');
      }
    } else {
      verifiedOnly = prior?.status !== 'attempting';
      cliNote = prior?.status === 'attempting' ? 'Salesforce shows the version as released after an earlier attempt.' : 'Salesforce already showed the version as released; verified only, no promote command was run.';
    }

    // 5. Independent verification of what Salesforce now says.
    const problems: string[] = [];
    if (live.packageId && live.packageId !== snap.selectedPackage.id) { problems.push('belongs to a different package'); }
    if (live.subscriberPackageVersionId && live.subscriberPackageVersionId !== versionId) { problems.push('is a different 04t'); }
    if (problems.length) {
      return failed('VERIFICATION_MISMATCH', `Released status was reported but the version ${problems.join(' and ')}.`, 'Inspect the Dev Hub manually.');
    }
    const completedAt = now().toISOString();
    d.release.setPromotion({ versionId, packageId: snap.selectedPackage.id, devHubOrgId: snap.devHub.orgId, devHubAlias: hub, status: 'released', approver, evidenceHash: reviewed.evidenceHash, startedAt: prior?.startedAt ?? completedAt, completedAt });
    const links = installLinks(versionId);
    const steps = nextSteps(versionId, reviewed.candidate.keyMode === 'key');
    const receipt = d.reports.write('promotion-receipt', `Promotion receipt: ${versionId}`, {
      package: reviewed.package, devHub: reviewed.devHub, versionId, version: live.version, releasedVerifiedAt: completedAt, approver,
      verifiedOnly, evidenceHash: reviewed.evidenceHash, sourceFingerprint: reviewed.sourceFingerprint, packageCoverage: live.codeCoverage,
      overrides: reviewed.overrides, cliResult: cliNote, installLinks: links, nextSteps: steps, readinessSummary: reviewed.summary
    });
    d.release.addHistory({
      at: completedAt, packageName: reviewed.package.name, packageId: reviewed.package.id, devHubAlias: hub, devHubOrgId: reviewed.devHub.orgId, versionId, version: live.version,
      approver, evidenceHash: reviewed.evidenceHash, sourceFingerprint: reviewed.sourceFingerprint ?? '', coverage: live.codeCoverage, overrides: reviewed.overrides, receiptRef: receipt.ref, verifiedOnly
    });
    return { status: 'passed', evidence: [receipt], fingerprint: reviewed.evidenceHash, message: `Salesforce confirms ${versionId} (${live.version ?? ''}) is Released. ${verifiedOnly ? 'Verified only; no promote command was run.' : `Promoted with approval from ${approver}.`}` };
  };

  return { 'release-review': review, promotion };
}

function writeText(d: ReleaseDeps, kind: string, label: string, ext: string, body: string): Evidence {
  fs.mkdirSync(d.reportsDir, { recursive: true });
  const at = new Date().toISOString();
  const file = `${d.reportsDir}/${kind}-${at.replace(/[:.]/g, '-')}.${ext}`;
  fs.writeFileSync(file, body, 'utf8');
  return { id: randomUUID(), kind, label, ref: file, createdAt: at };
}
