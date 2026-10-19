import { GitSnapshot } from '../adapters/git';
import { SfCli, SfError } from '../adapters/sfCli';
import { Evidence, StepExecutor, StepId, StepResult, StepStatus } from '../core/models';
import { DiscoveryService } from '../discovery/discoveryService';
import { QualityStore } from '../testing/qualityStore';
import { abortableSleep, fetchVersionReport, listAllVersions, listRecentRequests, pollRequest, startBuild } from '../packaging/build';
import { CreateRequest, TERMINAL } from '../packaging/parsers';
import { evaluateReadiness } from '../packaging/readiness';
import { PackagingStore } from '../packaging/store';
import { ReportWriter, sha256 } from './reportWriter';

export interface PackagingSettings {
  pollSeconds: number;
  buildWaitMinutes: number;
  /** 'require' = an installation key must be supplied; 'allow-bypass' = bypass is possible after explicit confirmation. */
  installationKeyPolicy: 'require' | 'allow-bypass';
}

export interface PackagingDeps {
  sf: SfCli;
  discovery: DiscoveryService;
  reports: ReportWriter;
  store: PackagingStore;
  quality: QualityStore;
  getRoot: () => string | undefined;
  git: (root: string) => Promise<GitSnapshot>;
  allowDirty: () => boolean;
  stepStatus: (id: StepId) => StepStatus;
  confirm: (title: string, detail: string) => Promise<boolean>;
  /** Returns the key, an explicit bypass, or undefined when the user cancels. The key is never stored. */
  askInstallationKey: (policy: PackagingSettings['installationKeyPolicy']) => Promise<{ key?: string; bypass?: boolean } | undefined>;
  settings: () => PackagingSettings;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const failed = (code: string, message: string, remediation?: string, detail?: string): StepResult =>
  ({ status: 'failed', message, failure: { code, message, remediation, detail } });

const safeBranch = (b?: string) => (b && /^[A-Za-z0-9_./-]{1,100}$/.test(b) ? b : undefined);

export function createPackagingExecutors(d: PackagingDeps): { 'package-readiness': StepExecutor; 'package-build': StepExecutor } {
  const context = () => {
    const root = d.getRoot();
    const snap = d.discovery.snapshot;
    const devHub = snap.devHub;
    const pkg = snap.selectedPackage;
    const project = snap.project;
    const dir = project?.packageDirectories.find(p => p.packageId && p.packageId === pkg?.id);
    return { root, devHub, pkg, project, dir };
  };

  const readiness: StepExecutor = async ctx => {
    const { root, devHub, pkg, project, dir } = context();
    if (!root) {
      return failed('NO_WORKSPACE', 'No workspace folder is open.');
    }
    if (!devHub || !pkg || !project) {
      return failed('NO_PACKAGE_CONTEXT', 'No Dev Hub, package or project is selected.', 'Select a Dev Hub and run Discover & Preflight first.');
    }
    if (!dir) {
      return failed('PACKAGE_DIR_NOT_FOUND', `No package directory in sfdx-project.json maps to ${pkg.name} (${pkg.id}).`, 'Check packageDirectories[].package and packageAliases.');
    }
    const hub = devHub.alias ?? devHub.username;
    const c = { root, signal: ctx.signal };
    ctx.log('info', `Reading package versions and build requests from ${hub}...`);
    let versions, requests;
    try {
      [versions, requests] = await Promise.all([listAllVersions(d.sf, hub, pkg.id, c), listRecentRequests(d.sf, hub, c)]);
    } catch (e) {
      if (e instanceof SfError) {
        return failed(e.code, `Could not read package information from the Dev Hub: ${e.message}`, e.remediation);
      }
      throw e;
    }
    const lookup: Record<string, 'found' | 'missing'> = {};
    for (const dep of dir.dependencies) {
      const id = dep.subscriberPackageVersionId ?? project.packageAliases[dep.package];
      if (id && /^04t/.test(id) && !(id in lookup)) {
        try {
          await fetchVersionReport(d.sf, hub, id, c);
          lookup[id] = 'found';
        } catch (e) {
          if (e instanceof SfError && /not found|no record|invalid|does not exist|INVALID_ID/i.test(e.message)) {
            lookup[id] = 'missing';
          }
        }
      }
    }
    const git = await d.git(root);
    const q = d.quality.get();
    const checks = evaluateReadiness({
      project, dir, pkg, versions, requests, git, allowDirty: d.allowDirty(),
      analysisFingerprint: q.analysis?.sourceFingerprint, testsFingerprint: q.apex?.sourceFingerprint,
      analysisPassed: d.stepStatus('analysis') === 'passed', testsPassed: d.stepStatus('tests') === 'passed',
      dependencyLookup: lookup
    });
    const fingerprint = sha256(JSON.stringify([git.fingerprint, pkg.id, devHub.orgId, dir.versionNumber, dir.ancestorId, dir.ancestorVersion, dir.dependencies]));
    d.store.setReadiness({ at: new Date().toISOString(), fingerprint, sourceFingerprint: git.fingerprint, checks, packageId: pkg.id });
    const evidence = [d.reports.write('package-readiness', `Package readiness for ${pkg.name}`, {
      devHub: { alias: hub, orgId: devHub.orgId }, package: pkg, directory: dir.path, versionNumber: dir.versionNumber,
      existingVersions: versions.length, releasedVersions: versions.filter(v => v.isReleased).length, checks, sourceFingerprint: git.fingerprint
    })];
    const bad = checks.filter(x => x.status === 'fail');
    if (bad.length) {
      return {
        status: 'failed', evidence, fingerprint, message: `${bad.length} readiness check(s) failed: ${bad.map(b => b.name).join(', ')}.`,
        failure: { code: 'READINESS_FAILED', message: bad[0].detail, remediation: bad[0].remediation, detail: bad.map(b => `${b.name}: ${b.detail}`).join('\n') }
      };
    }
    return { status: 'passed', evidence, fingerprint, message: `${checks.length} checks passed for ${pkg.name} ${dir.versionNumber}.` };
  };

  const build: StepExecutor = async ctx => {
    const { root, devHub, pkg, project, dir } = context();
    if (!root || !devHub || !pkg || !project || !dir) {
      return failed('NO_PACKAGE_CONTEXT', 'Dev Hub, package or project context is missing.', 'Run Discover & Preflight again.');
    }
    const settings = d.settings();
    const hub = devHub.alias ?? devHub.username;
    const c = { root, signal: ctx.signal };
    const git = await d.git(root);
    const ready = d.store.readiness();
    if (!git.fingerprint || !ready || ready.sourceFingerprint !== git.fingerprint || ready.packageId !== pkg.id) {
      return failed('READINESS_STALE', 'Package readiness was not evaluated for the current source and package.', 'Run Package Readiness again.');
    }
    if (ready.checks.some(x => x.status === 'fail')) {
      return failed('READINESS_FAILED', 'Package readiness has failing checks.', 'Resolve them and run Package Readiness again.');
    }
    const version = dir.versionNumber ?? '';

    // 1. Never create a second build when one of ours is in flight or this exact source is already built.
    let candidate = d.store.inFlight(pkg.id, devHub.orgId);
    if (candidate) {
      ctx.log('info', `Resuming tracking of existing request ${candidate.requestId}; no new build will be created.`);
    } else {
      const existing = d.store.successFor(pkg.id, devHub.orgId, git.fingerprint, version);
      if (existing) {
        ctx.log('info', `This source was already built as ${existing.subscriberPackageVersionId}; verifying instead of rebuilding.`);
        candidate = existing;
      }
    }

    // 2. Otherwise create it, after the Dev Hub confirms nothing else is running and the user approves.
    if (!candidate) {
      let requests: CreateRequest[];
      try {
        requests = await listRecentRequests(d.sf, hub, c);
      } catch (e) {
        if (e instanceof SfError) {
          return failed(e.code, `Could not check for running builds: ${e.message}`, e.remediation ?? 'Retry once the Dev Hub is reachable. No build was started.');
        }
        throw e;
      }
      const flying = requests.filter(r => r.packageId === pkg.id && ['Queued', 'InProgress', 'Verifying'].includes(r.status));
      if (flying.length) {
        return failed('BUILD_ALREADY_RUNNING', `Build request ${flying.map(r => r.requestId).join(', ')} is already ${flying[0].status} for this package.`, 'Wait for it to finish. No duplicate was created.');
      }
      const answer = await d.askInstallationKey(settings.installationKeyPolicy);
      if (!answer || (!answer.key && !answer.bypass)) {
        return { status: 'blocked', message: 'No installation key decision was made; no build was started.' };
      }
      const branch = safeBranch(git.branch);
      const tag = git.head?.slice(0, 12);
      const approved = await d.confirm(
        `Create a beta package version of ${pkg.name}?`,
        `Dev Hub: ${hub} (${devHub.orgId})\nPackage: ${pkg.name} (${pkg.id}) in ${dir.path}\nVersion: ${version}\nSource: ${branch ?? '(detached)'} @ ${tag ?? '?'} (fingerprint ${git.fingerprint.slice(0, 12)})\n` +
        `Installation key: ${answer.key ? 'yes (not stored)' : 'BYPASSED (anyone with the install link can install)'}\n\n` +
        'Full validation and code coverage are always enabled. This consumes a package version build on your Dev Hub and creates a new beta 04t that cannot be edited. Nothing is promoted.');
      if (!approved) {
        return { status: 'blocked', message: 'Declined: no package build was started.' };
      }
      ctx.log('info', `Creating package version (${version}) on ${hub}...`);
      let req: CreateRequest;
      try {
        req = await startBuild(d.sf, { packageId: pkg.id, devHub: hub, installationKey: answer.key, bypassKey: answer.bypass, branch, tag }, c);
      } catch (e) {
        if (e instanceof SfError) {
          return failed(e.code, `Package creation was rejected: ${e.message}`, e.remediation ?? 'Fix the reported problem and run the step again. No build request was registered.');
        }
        throw e;
      }
      candidate = {
        requestId: req.requestId, packageId: pkg.id, packageName: pkg.name, devHubOrgId: devHub.orgId, devHubAlias: hub,
        versionNumber: version, branch, tag, status: req.status, errors: req.errors, sourceFingerprint: git.fingerprint,
        keyMode: answer.key ? 'key' : 'bypass', createdAt: req.createdDate ?? new Date().toISOString()
      };
      d.store.upsert(candidate);
      ctx.log('info', `Build request ${req.requestId} registered (${req.status}).`);
    }

    // 3. Track to completion. The request id is already persisted, so a restart resumes here.
    let current = candidate;
    if (!TERMINAL.includes(current.status) || (current.status === 'Success' && !current.subscriberPackageVersionId)) {
      const { request, timedOut } = await pollRequest(d.sf, hub, current.requestId, c, {
        intervalMs: settings.pollSeconds * 1000, timeoutMs: settings.buildWaitMinutes * 60_000, sleep: d.sleep ?? abortableSleep, signal: ctx.signal,
        onUpdate: r => {
          ctx.log('info', `Request ${r.requestId}: ${r.status}`);
          d.store.upsert({ ...current, status: r.status, errors: r.errors, lastPolledAt: new Date().toISOString() });
        }
      });
      current = { ...current, status: request.status, errors: request.errors, subscriberPackageVersionId: request.subscriberPackageVersionId ?? current.subscriberPackageVersionId,
        packageVersionId: request.packageVersionId ?? current.packageVersionId, lastPolledAt: new Date().toISOString() };
      d.store.upsert(current);
      if (timedOut) {
        return {
          status: 'needs-review', message: `Request ${current.requestId} is still ${current.status} after the local wait.`,
          failure: { code: 'BUILD_STILL_RUNNING', message: `Build request ${current.requestId} has not finished.`, remediation: 'Retry the step to keep tracking this same request; no new build will be created.' }
        };
      }
    }
    const evidence: Evidence[] = [d.reports.write('package-build-request', `Build request ${current.requestId}`, current)];
    if (current.status !== 'Success') {
      return {
        status: 'failed', evidence, message: `Package build ${current.requestId} ended as ${current.status}.`,
        failure: { code: 'BUILD_FAILED', message: current.errors[0] ?? `The build ended as ${current.status}.`, detail: current.errors.join('\n') || undefined, remediation: 'Fix the reported errors and run the step again; a new build will be created.' }
      };
    }
    if (!current.subscriberPackageVersionId) {
      return failed('NO_04T', `Request ${current.requestId} succeeded but returned no subscriber package version ID.`, 'Inspect the request on the Dev Hub.');
    }

    // 4. Verify against the authoritative version report rather than trusting the create response.
    let report;
    try {
      report = await fetchVersionReport(d.sf, hub, current.subscriberPackageVersionId, c);
    } catch (e) {
      if (e instanceof SfError) {
        return { status: 'needs-review', evidence, message: `Build succeeded but its report could not be read: ${e.message}`,
          failure: { code: e.code, message: e.message, remediation: 'Retry the step; the 04t is already recorded and no new build will be created.' } };
      }
      throw e;
    }
    current = {
      ...current, ancestorId: report.ancestorId, isReleased: report.isReleased, validationSkipped: report.validationSkipped,
      coveragePercent: report.codeCoverage, hasPassedCodeCoverageCheck: report.hasPassedCodeCoverageCheck, completedAt: current.completedAt ?? new Date().toISOString()
    };
    d.store.upsert(current);
    evidence.push(d.reports.write('package-version-report', `Package version ${current.subscriberPackageVersionId}`, { candidate: current, report }));
    const problems: string[] = [];
    if (report.packageId && report.packageId !== pkg.id) {
      problems.push(`The version belongs to package ${report.packageId}, not ${pkg.id}.`);
    }
    if (report.validationSkipped) {
      problems.push('Validation was skipped for this version; it cannot be promoted.');
    }
    if (report.isReleased) {
      problems.push('The version is already released; this build was not expected to be.');
    }
    if (report.codeCoverage === undefined) {
      problems.push('Salesforce returned no package code coverage.');
    } else if (report.codeCoverage < 75) {
      problems.push(`Package code coverage is ${report.codeCoverage}%, below Salesforce's 75% minimum.`);
    }
    if (report.hasPassedCodeCoverageCheck !== true) {
      problems.push('Salesforce reports the code coverage check has not passed (coverage below 75% or an uncovered trigger).');
    }
    const fingerprint = sha256(JSON.stringify([git.fingerprint, current.subscriberPackageVersionId]));
    const desc = `${current.subscriberPackageVersionId} (${report.version ?? version}), coverage ${report.codeCoverage ?? 'n/a'}%`;
    if (problems.length) {
      return {
        status: 'failed', evidence, fingerprint, message: `${desc}. ${problems.join(' ')}`,
        failure: { code: 'PACKAGE_NOT_PROMOTABLE', message: problems[0], detail: problems.join('\n'), remediation: 'Raise package coverage or fix the issue and build a new version. This beta cannot be promoted.' }
      };
    }
    return { status: 'passed', evidence, fingerprint, message: `Built ${desc}; coverage check passed. Built from source ${git.fingerprint.slice(0, 12)}.` };
  };

  return { 'package-readiness': readiness, 'package-build': build };
}
