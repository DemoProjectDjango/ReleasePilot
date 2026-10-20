import * as fs from 'fs';
import { StepExecutor, StepResult, StepId } from '../core/models';
import { DiscoveryService, DiscoverySnapshot } from '../discovery/discoveryService';
import { ReportWriter, sha256 } from './reportWriter';

export interface ExecutorDeps {
  discovery: DiscoveryService;
  reports: ReportWriter;
  getRoot: () => string | undefined;
  allowDirtySource: () => boolean;
}

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  remediation?: string;
}

const fail = (check: Check): StepResult['failure'] => ({
  code: 'PREFLIGHT_FAILED',
  message: check.detail,
  remediation: check.remediation
});

export function evaluatePreflight(s: DiscoverySnapshot): Check[] {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string, remediation?: string) => checks.push({ name, status, detail, remediation });

  if (s.project) {
    add('Salesforce DX project', 'pass', `sfdx-project.json parsed (${s.project.packageDirectories.length} package directory/ies).`);
    s.project.warnings.forEach(w => add('Project configuration', 'warn', w));
    const pkgDirs = s.project.packageDirectories.filter(p => p.package);
    if (!pkgDirs.length) {
      add('Package configuration', 'fail', 'No package directory declares a "package".', 'Add a "package" and a versionNumber to a packageDirectories entry.');
    }
    for (const d of s.project.packageDirectories.filter(p => !p.exists && p.path)) {
      add('Package directory', 'fail', `"${d.path}" does not exist.`, 'Create the directory or fix sfdx-project.json.');
    }
  } else {
    const e = s.errors.find(x => x.scope === 'project');
    add('Salesforce DX project', 'fail', e?.message ?? 'No project found.', 'Open the root folder of a Salesforce DX project.');
  }

  const t = s.tooling;
  add('Salesforce CLI', t?.sf ? 'pass' : 'fail', t?.sf ?? 'Salesforce CLI not available.', t?.sf ? undefined : 'Install Salesforce CLI and restart VS Code.');
  if (t?.sf) {
    add('Code Analyzer v5', t.codeAnalyzer ? 'pass' : 'fail',
      t.codeAnalyzer ? `code-analyzer ${t.codeAnalyzer.version}` : 'The Code Analyzer v5 plugin (code-analyzer) is not installed.',
      t.codeAnalyzer ? undefined : 'Run "sf plugins install code-analyzer".');
    if (t.legacyScanner) {
      add('Legacy scanner', 'warn', `@salesforce/sfdx-scanner ${t.legacyScanner.version} (v4) is installed; ReleasePilot uses code-analyzer v5 only.`);
    }
  }
  add('Git', s.git?.isRepo ? 'pass' : 'fail', s.git?.isRepo ? `${s.git.version} on ${s.git.branch ?? '?'}` : (s.git?.error ?? 'Git unavailable.'),
    s.git?.isRepo ? undefined : 'Install Git and keep the project in a repository.');

  s.errors.filter(e => ['orgs', 'packages', 'versions'].includes(e.scope)).forEach(e => add(`Discovery (${e.scope})`, 'fail', e.message, e.remediation));

  if (!s.devHub) {
    add('Dev Hub', 'fail', 'No Dev Hub org is selected.', 'Select an authenticated Dev Hub org in the dashboard.');
  } else {
    add('Dev Hub', 'pass', `${s.devHub.alias ?? s.devHub.username} (${s.devHub.orgId})`);
    const wantedId = s.project?.packageDirectories.find(p => p.packageId)?.packageId;
    if (!s.selectedPackage) {
      add('Package ownership', 'fail', wantedId ? `Package ${wantedId} was not found in the selected Dev Hub.` : 'No package could be matched in the Dev Hub.',
        'Select the Dev Hub that owns the package, or fix packageAliases in sfdx-project.json.');
    } else {
      add('Package ownership', 'pass', `${s.selectedPackage.name} (${s.selectedPackage.id}) is owned by the selected Dev Hub.`);
      const ns = s.project?.namespace;
      const pns = s.selectedPackage.namespacePrefix;
      if (pns && ns && pns !== ns) {
        add('Namespace', 'fail', `Project namespace "${ns}" differs from the package namespace "${pns}".`, 'Fix "namespace" in sfdx-project.json.');
      } else if (pns && !ns) {
        add('Namespace', 'warn', `Package namespace is "${pns}" but sfdx-project.json declares none.`);
      } else {
        add('Namespace', 'pass', pns ? `Namespace "${pns}" matches.` : 'Package has no namespace.');
      }
      if (s.selectedPackage.containerOptions && s.selectedPackage.containerOptions !== 'Managed') {
        add('Package type', 'warn', `Package container option is "${s.selectedPackage.containerOptions}", not Managed.`);
      }
    }
  }
  if (s.devOrg) {
    add('Development org', 'pass', `${s.devOrg.alias ?? s.devOrg.username} (${s.devOrg.orgId})`);
  }
  return checks;
}

export function createExecutors(deps: ExecutorDeps): Partial<Record<StepId, StepExecutor>> {
  const preflight: StepExecutor = async ctx => {
    const root = deps.getRoot();
    if (!root) {
      return { status: 'failed', failure: { code: 'NO_WORKSPACE', message: 'No workspace folder is open.', remediation: 'Open a Salesforce DX project folder.' } };
    }
    ctx.log('info', 'Running read-only discovery...');
    const snap = await deps.discovery.discover(root, ctx.signal);
    const checks = evaluatePreflight(snap);
    const failed = checks.filter(c => c.status === 'fail');
    const evidence = [deps.reports.write('preflight', 'Preflight report', {
      project: root, devHub: snap.devHub && { alias: snap.devHub.alias, username: snap.devHub.username, orgId: snap.devHub.orgId },
      package: snap.selectedPackage, tooling: snap.tooling, checks, mocked: false
    })];
    const fingerprint = sha256(JSON.stringify({ hub: snap.devHub?.orgId, pkg: snap.selectedPackage?.id, ns: snap.project?.namespace }));
    if (failed.length) {
      return { status: 'failed', evidence, fingerprint, message: `${failed.length} preflight check(s) failed.`, failure: fail(failed[0]) };
    }
    const warns = checks.filter(c => c.status === 'warn').length;
    return { status: 'passed', evidence, fingerprint, message: `${checks.length} checks passed${warns ? ` (${warns} warning(s))` : ''}.` };
  };

  const source: StepExecutor = async ctx => {
    const root = deps.getRoot();
    if (!root) {
      return { status: 'failed', failure: { code: 'NO_WORKSPACE', message: 'No workspace folder is open.' } };
    }
    const snap = await deps.discovery.discover(root, ctx.signal);
    const git = snap.git;
    if (!git?.isRepo || !git.fingerprint) {
      return { status: 'failed', failure: { code: 'NOT_A_GIT_REPO', message: git?.error ?? 'Git repository required.', remediation: 'Place the project under Git so the source can be fingerprinted.' } };
    }
    if (!snap.project || !fs.existsSync(snap.project.file)) {
      return { status: 'failed', failure: { code: 'NO_SFDX_PROJECT', message: 'sfdx-project.json is missing.' } };
    }
    const dirty = git.files;
    const evidence = [deps.reports.write('source-snapshot', 'Source snapshot', {
      branch: git.branch, head: git.head, fingerprint: git.fingerprint, uncommitted: dirty, allowDirty: deps.allowDirtySource()
    })];
    if (dirty.length && !deps.allowDirtySource()) {
      return {
        status: 'needs-review', evidence, fingerprint: git.fingerprint,
        message: `${dirty.length} uncommitted change(s). A release candidate should be built from committed source.`,
        failure: { code: 'DIRTY_SOURCE', message: `${dirty.length} uncommitted change(s) in the working tree.`, remediation: 'Commit or stash the changes, or enable "releasepilot.allowDirtySource" to accept an uncommitted snapshot.' }
      };
    }
    return {
      status: 'passed', evidence, fingerprint: git.fingerprint,
      message: `Snapshot ${git.fingerprint.slice(0, 12)} on ${git.branch}${dirty.length ? ` (${dirty.length} uncommitted change(s) accepted)` : ''}.`
    };
  };

  return { preflight, source };
}
