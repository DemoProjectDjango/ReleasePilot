import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { GitSnapshot } from '../adapters/git';
import { SfCli, SfError } from '../adapters/sfCli';
import { Evidence, StepExecutor, StepResult } from '../core/models';
import { DiscoveryService } from '../discovery/discoveryService';
import { PackageDirectory } from '../discovery/project';
import { abortableSleep, listAllVersions } from '../packaging/build';
import { ExistingVersion } from '../packaging/parsers';
import { PackageCandidate, PackagingStore } from '../packaging/store';
import { parseVersion } from '../packaging/versions';
import { assignPermsets, assignedPermsets, createScratch, installPackage, installedPackages, listScratchOrgs, openOrg, pollInstall, runApexFile } from '../qa/ops';
import { InstallResult } from '../qa/parsers';
import { resolveInside, validateScratchDefinition } from '../qa/scratchDef';
import { DEFAULT_QA_CHECKLIST, DEFAULT_UPGRADE_CHECKLIST, PhaseName, QaEnvironment, QaKind, QaStore, makeChecklist } from '../qa/store';
import { assertBaselineReleased, evaluateUpgradePath } from '../qa/upgradePath';
import { ReportWriter, sha256 } from './reportWriter';

export interface QaSettings {
  definitionFile: string;
  durationDays: number;
  waitMinutes: number;
  pollSeconds: number;
  securityType: 'AdminsOnly' | 'AllUsers';
  permissionSets: string[];
  initScripts: string[];
  smokeScripts: string[];
  seedScripts: string[];
  regressionScripts: string[];
  openOrgAfterInstall: boolean;
  checklist: string[];
  upgradeChecklist: string[];
  aliasPrefix: string;
}

export interface QaDeps {
  sf: SfCli;
  discovery: DiscoveryService;
  reports: ReportWriter;
  qa: QaStore;
  packaging: PackagingStore;
  getRoot: () => string | undefined;
  git: (root: string) => Promise<GitSnapshot>;
  settings: () => QaSettings;
  confirm: (title: string, detail: string) => Promise<boolean>;
  /** Asks for an installation key (never stored). Returns {} when none is needed, undefined when cancelled. */
  askKey: (label: string) => Promise<{ key?: string } | undefined>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Thrown inside a phase to stop the run with a specific, recorded outcome. */
class PhaseStop extends Error {
  constructor(readonly code: string, message: string, readonly remediation?: string, readonly reviewable = false, readonly detail?: string) {
    super(message);
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'pkg';
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
/** Alias suffix is random so two orgs created in the same minute can never share (and overwrite) an alias. */
const uniq = () => randomUUID().replace(/-/g, '').slice(0, 4);
const nowIso = () => new Date().toISOString();
const SCRIPT_EXT = /\.apex$/i;

const failed = (code: string, message: string, remediation?: string, detail?: string): StepResult =>
  ({ status: 'failed', message, failure: { code, message, remediation, detail } });

export function createQaExecutors(d: QaDeps): { 'clean-install-qa': StepExecutor; 'upgrade-qa': StepExecutor } {
  const run = (kind: QaKind): StepExecutor => async ctx => {
    const root = d.getRoot();
    const snap = d.discovery.snapshot;
    const { devHub, selectedPackage: pkg, project } = snap;
    if (!root || !devHub || !pkg || !project) {
      return failed('NO_PACKAGE_CONTEXT', 'Dev Hub, package or project context is missing.', 'Run Discover & Preflight again.');
    }
    const dir = project.packageDirectories.find(p => p.packageId === pkg.id);
    if (!dir) {
      return failed('PACKAGE_DIR_NOT_FOUND', `No package directory maps to ${pkg.name}.`);
    }
    const hub = devHub.alias ?? devHub.username;
    const cx = { root, signal: ctx.signal };
    const s = d.settings();
    const git = await d.git(root);

    // The candidate must be a promotable build of exactly the current, validated source.
    const candidate = d.packaging.candidates().find((c: PackageCandidate) => c.packageId === pkg.id && c.devHubOrgId === devHub.orgId &&
      c.status === 'Success' && !!c.subscriberPackageVersionId && c.hasPassedCodeCoverageCheck === true && c.sourceFingerprint === git.fingerprint);
    if (!candidate?.subscriberPackageVersionId) {
      return failed('NO_CURRENT_CANDIDATE', 'There is no promotable beta package built from the current source.', 'Build a beta package from the current source (Create Beta Package) first.');
    }
    const targetId = candidate.subscriberPackageVersionId;

    // Scripts and the scratch definition are validated before anything is created remotely.
    const def = validateScratchDefinition(root, s.definitionFile);
    if (!def.ok) {
      return failed('DEFINITION_INVALID', def.checks.find(c => c.status === 'fail')?.detail ?? 'Invalid scratch definition.', 'Fix the scratch org definition file (releasepilot.scratchDefinitionFile).', def.checks.map(c => `${c.status}: ${c.name} - ${c.detail}`).join('\n'));
    }
    const scriptList = kind === 'upgrade' ? [...s.seedScripts, ...s.regressionScripts, ...s.smokeScripts] : [...s.initScripts, ...s.smokeScripts];
    const scriptPaths = new Map<string, string>();
    for (const rel of scriptList) {
      const abs = resolveInside(root, rel);
      if (!abs || !SCRIPT_EXT.test(rel) || !fs.existsSync(abs)) {
        return failed('SCRIPT_INVALID', `Script "${rel}" must be an existing .apex file inside the project.`, 'Fix the QA script settings.');
      }
      scriptPaths.set(rel, abs);
    }
    for (const n of s.permissionSets) {
      if (!/^[A-Za-z0-9_]{1,80}$/.test(n)) {
        return failed('PERMSET_INVALID', `Invalid permission set name "${n}".`, 'Fix releasepilot.qaPermissionSets.');
      }
    }

    ctx.log('info', 'Reading package versions from the Dev Hub...');
    let versions: ExistingVersion[];
    try {
      versions = await listAllVersions(d.sf, hub, pkg.id, cx);
    } catch (e) {
      return e instanceof SfError ? failed(e.code, `Could not read package versions: ${e.message}`, e.remediation) : failed('UNEXPECTED', String(e));
    }
    const target = versions.find(v => v.subscriberPackageVersionId === targetId);

    let baseline: ExistingVersion | undefined;
    if (kind === 'upgrade') {
      const path = evaluateUpgradePath(versions, targetId);
      if (path.state === 'not-applicable') {
        return { status: 'skipped', message: path.reason };
      }
      if (path.state === 'unsupported' || !path.baseline) {
        return { status: 'blocked', message: path.reason, failure: { code: 'UPGRADE_PATH_UNSUPPORTED', message: path.reason, remediation: path.alternative } };
      }
      try {
        assertBaselineReleased(path.baseline);
      } catch (e) {
        return failed('BETA_BASELINE', e instanceof Error ? e.message : String(e));
      }
      baseline = path.baseline;
    }

    // Reuse an environment that can continue; otherwise reconcile or create a new one after confirmation.
    let env = d.qa.resumable(kind, targetId, devHub.orgId);
    if (env?.status === 'creating') {
      const found = (await listScratchOrgs(d.sf, cx)).find(o => o.alias === env!.alias && (!o.devHubOrgId || o.devHubOrgId === devHub.orgId));
      if (found) {
        env = { ...env, username: found.username, orgId: found.orgId, expiresAt: found.expirationDate, status: 'ready', phases: { ...env.phases, create: { status: 'done', at: nowIso(), detail: 'Found by alias after an interrupted run.' } } };
        d.qa.save(env);
      } else {
        d.qa.save({ ...env, status: 'failed', failedPhase: 'create', failure: 'The interrupted request produced no scratch org.' });
        env = undefined;
      }
    }

    const needTargetKey = candidate.keyMode === 'key' && env?.phases.install?.status !== 'done';
    const needBaselineKey = !!baseline?.passwordProtected && env?.phases.baseline?.status !== 'done';
    let targetKey: string | undefined;
    let baselineKey: string | undefined;
    if (needBaselineKey) {
      const a = await d.askKey(`previous released version ${baseline!.version}`);
      if (!a) { return { status: 'blocked', message: 'Installation key not provided; nothing was created.' }; }
      baselineKey = a.key;
    }
    if (needTargetKey) {
      const a = await d.askKey(`candidate ${target?.version ?? targetId}`);
      if (!a?.key) { return { status: 'blocked', message: 'Installation key not provided; nothing was created.' }; }
      targetKey = a.key;
    }

    if (!env) {
      const alias = `${s.aliasPrefix}-${slug(pkg.name)}-${kind === 'upgrade' ? 'up' : 'qa'}-${stamp()}-${uniq()}`.slice(0, 60);
      const ok = await d.confirm(
        `${kind === 'upgrade' ? 'Prepare an upgrade-test' : 'Prepare a QA'} scratch org from ${hub}?`,
        `Dev Hub: ${hub} (${devHub.orgId}) - uses one scratch org from its allocation.\nNew org alias: ${alias} (expires in ${s.durationDays} day(s), no namespace)\nDefinition: ${s.definitionFile}\n` +
        (kind === 'upgrade' ? `Install released ${baseline!.version} first, then upgrade to candidate ${target?.version ?? targetId}.\n` : `Install candidate ${target?.version ?? targetId} (${targetId}).\n`) +
        `Permission sets: ${s.permissionSets.join(', ') || '(none)'}\nProject scripts that will run in the new org: ${scriptList.join(', ') || '(none)'}\n\nNothing in your existing orgs is changed. The org is NOT deleted automatically.`);
      if (!ok) {
        return { status: 'blocked', message: 'Declined: no scratch org was created.' };
      }
      env = {
        id: randomUUID(), kind, alias, devHubOrgId: devHub.orgId, devHubAlias: hub, packageId: pkg.id, packageName: pkg.name,
        targetVersionId: targetId, targetVersion: target?.version, baselineVersionId: baseline?.subscriberPackageVersionId, baselineVersion: baseline?.version,
        sourceFingerprint: git.fingerprint ?? '', status: 'creating', createdAt: nowIso(), durationDays: s.durationDays, definitionFile: s.definitionFile,
        permsets: s.permissionSets, phases: { definition: { status: 'done', at: nowIso() } }, smoke: [], logRefs: [],
        checklist: makeChecklist(kind === 'upgrade' ? (s.upgradeChecklist.length ? s.upgradeChecklist : DEFAULT_UPGRADE_CHECKLIST) : (s.checklist.length ? s.checklist : DEFAULT_QA_CHECKLIST))
      };
      d.qa.save(env);
    }
    const current = (): QaEnvironment => env!;
    const update = (patch: Partial<QaEnvironment>) => { env = { ...env!, ...patch }; d.qa.save(env); };
    const mark = (name: PhaseName, st: 'done' | 'failed', detail?: string) => update({ phases: { ...env!.phases, [name]: { status: st, at: nowIso(), detail } } });
    const evidence: Evidence[] = [];
    const keepLog = (kindName: string, label: string, body: unknown) => {
      const e = d.reports.write(kindName, label, body);
      evidence.push(e);
      update({ logRefs: [...env!.logRefs, e.ref] });
    };
    const done = (name: PhaseName) => current().phases[name]?.status === 'done';
    const orgRef = () => current().alias;

    const installVia = async (label: string, versionId: string, key: string | undefined, requestOf: () => string | undefined, remember: (id: string) => void): Promise<void> => {
      const wait = s.waitMinutes;
      let result: InstallResult;
      const existing = requestOf();
      if (existing) {
        result = (await pollInstall(d.sf, orgRef(), existing, cx, { intervalMs: s.pollSeconds * 1000, timeoutMs: wait * 60_000, sleep: d.sleep ?? abortableSleep })).result;
      } else {
        result = await installPackage(d.sf, { org: orgRef(), versionId, key, waitMinutes: Math.min(wait, 20), securityType: s.securityType }, cx);
        if (result.requestId) { remember(result.requestId); }
      }
      if (result.status === 'IN_PROGRESS' && result.requestId) {
        const p = await pollInstall(d.sf, orgRef(), result.requestId, cx, { intervalMs: s.pollSeconds * 1000, timeoutMs: wait * 60_000, sleep: d.sleep ?? abortableSleep });
        result = p.result;
        if (p.timedOut) {
          throw new PhaseStop('INSTALL_STILL_RUNNING', `Installation of ${label} is still in progress after the local wait.`, 'Retry the step to keep tracking the same installation.', true);
        }
      }
      keepLog('package-install-log', `Install log: ${label}`, { org: orgRef(), versionId, requestId: result.requestId, status: result.status, errors: result.errors });
      if (result.status !== 'SUCCESS') {
        throw new PhaseStop('INSTALL_FAILED', `Installation of ${label} ended as ${result.status}.`,
          'Read the preserved install log, fix the missing feature/permission or package problem, then run the step again to get a NEW clean org. The failed org is kept for inspection.', false, result.errors.join('\n') || undefined);
      }
    };

    const verifyInstalled = async (versionId: string, label: string): Promise<string | undefined> => {
      const list = await installedPackages(d.sf, orgRef(), cx);
      const hit = list.find(p => p.versionId === versionId);
      if (!hit) {
        throw new PhaseStop('VERIFY_FAILED', `${label} (${versionId}) is not listed as installed in ${orgRef()}.`, 'Inspect the org\'s Installed Packages and the install log.');
      }
      return hit.versionNumber;
    };

    try {
      // 1. Create the scratch org.
      if (!done('create')) {
        ctx.log('info', `Creating scratch org ${current().alias} from ${hub}...`);
        try {
          const created = await createScratch(d.sf, { hub, alias: current().alias, definitionFile: def.file, durationDays: s.durationDays, waitMinutes: s.waitMinutes }, cx);
          update({ username: created.username, orgId: created.orgId, expiresAt: created.expirationDate, status: 'ready' });
          mark('create', 'done', `${created.orgId}`);
        } catch (e) {
          if (e instanceof SfError && e.code === 'TIMEOUT') {
            throw new PhaseStop('CREATE_TIMEOUT', 'Scratch org creation did not finish in the local wait.', 'Retry: ReleasePilot will look for the org by alias instead of creating a second one.', true);
          }
          const msg = e instanceof SfError ? e.message : String(e);
          throw new PhaseStop('CREATE_FAILED', `Scratch org creation failed: ${msg}`, (e instanceof SfError && e.remediation) ||
            (/limit/i.test(msg) ? 'The Dev Hub has reached its scratch org limit. Delete unused scratch orgs yourself or choose another Dev Hub; ReleasePilot never deletes orgs without your confirmation.' : 'Fix the reported problem and run the step again.'));
        }
      }

      // 2. Dependencies, in declaration order.
      if (!done('dependencies')) {
        const plan = await resolveDependencies(d, dir, project.packageAliases, hub, cx);
        const installed = await installedPackages(d.sf, orgRef(), cx);
        const reqs = { ...(current().dependencyInstalls ?? {}) };
        for (const dep of plan) {
          if (installed.some(p => p.versionId === dep.versionId)) { continue; }
          ctx.log('info', `Installing dependency ${dep.label}...`);
          await installVia(`dependency ${dep.label}`, dep.versionId, undefined, () => reqs[dep.versionId], id => { reqs[dep.versionId] = id; update({ dependencyInstalls: { ...reqs } }); });
        }
        mark('dependencies', 'done', plan.map(p => p.label).join(', ') || 'none');
      }

      // 3. Upgrade tests: install the released baseline and seed data.
      if (kind === 'upgrade') {
        if (!done('baseline')) {
          ctx.log('info', `Installing released baseline ${baseline!.version}...`);
          await installVia(`released ${baseline!.version}`, baseline!.subscriberPackageVersionId!, baselineKey, () => current().baselineRequestId, id => update({ baselineRequestId: id }));
          await verifyInstalled(baseline!.subscriberPackageVersionId!, `released ${baseline!.version}`);
          mark('baseline', 'done', baseline!.version);
        }
        if (!done('seed')) {
          for (const rel of s.seedScripts) {
            ctx.log('info', `Seeding test data: ${rel}`);
            await runApexFile(d.sf, orgRef(), scriptPaths.get(rel)!, cx);
          }
          mark('seed', 'done', `${s.seedScripts.length} script(s)`);
        }
      }

      // 4. Install the candidate (fresh install, or the upgrade itself).
      if (!done('install')) {
        ctx.log('info', `Installing candidate ${target?.version ?? targetId}...`);
        await installVia(`candidate ${target?.version ?? targetId}`, targetId, targetKey, () => current().installRequestId, id => update({ installRequestId: id }));
        mark('install', 'done');
      }
      if (!done('verify')) {
        const v = await verifyInstalled(targetId, 'The candidate');
        update({ verifiedInstalledVersion: v, installStatus: 'SUCCESS' });
        mark('verify', 'done', `Installed ${v ?? targetId}`);
      }

      // 5. Permissions.
      if (!done('permsets')) {
        await assignPermsets(d.sf, orgRef(), s.permissionSets, cx);
        mark('permsets', 'done', s.permissionSets.join(', ') || 'none configured');
      }

      // 6. Project scripts: init for fresh installs, regression checks for upgrades.
      if (!done('scripts')) {
        for (const rel of kind === 'upgrade' ? s.regressionScripts : s.initScripts) {
          ctx.log('info', `Running ${rel}...`);
          await runApexFile(d.sf, orgRef(), scriptPaths.get(rel)!, cx);
        }
        mark('scripts', 'done');
      }

      // 7. Automated checks (these never replace manual QA).
      if (!done('smoke')) {
        const smoke = [...current().smoke.filter(x => x.name.startsWith('Installed'))];
        smoke.push({ name: 'Installed version', status: 'pass', detail: `${current().verifiedInstalledVersion ?? targetId} is installed in ${orgRef()}.` });
        if (s.permissionSets.length) {
          const have = (await assignedPermsets(d.sf, orgRef(), current().username ?? '', cx)).map(x => x.toLowerCase());
          const missing = s.permissionSets.filter(n => !have.includes(n.replace(/^[A-Za-z0-9]+__/, '').toLowerCase()));
          smoke.push({ name: 'Permission sets assigned', status: missing.length ? 'fail' : 'pass', detail: missing.length ? `Not assigned: ${missing.join(', ')}` : s.permissionSets.join(', ') });
        }
        for (const rel of s.smokeScripts) {
          try {
            await runApexFile(d.sf, orgRef(), scriptPaths.get(rel)!, cx);
            smoke.push({ name: `Smoke script ${rel}`, status: 'pass', detail: 'Completed without exception.' });
          } catch (e) {
            smoke.push({ name: `Smoke script ${rel}`, status: 'fail', detail: e instanceof Error ? e.message : String(e) });
          }
        }
        update({ smoke });
        const bad = smoke.filter(x => x.status === 'fail');
        if (bad.length) {
          throw new PhaseStop('SMOKE_FAILED', `${bad.length} automated check(s) failed: ${bad.map(b => b.name).join(', ')}.`, 'Inspect the failing checks in the QA tab, fix, and run the step again for a new clean org.', false, bad.map(b => `${b.name}: ${b.detail}`).join('\n'));
        }
        mark('smoke', 'done');
      }

      // 8. Open the org (best effort; never fails the run).
      if (s.openOrgAfterInstall && !done('open')) {
        try {
          await openOrg(d.sf, orgRef(), cx);
          mark('open', 'done');
        } catch (e) {
          ctx.log('warn', `Could not open the org automatically: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      const stop = e instanceof PhaseStop ? e : e instanceof SfError
        ? new PhaseStop(e.code, e.message, e.remediation, e.code === 'TIMEOUT' || e.code === 'CANCELLED')
        : new PhaseStop('UNEXPECTED', e instanceof Error ? e.message : String(e));
      keepLog('qa-failure', `QA run problem: ${stop.code}`, { env: summary(current()), code: stop.code, message: stop.message, detail: stop.detail });
      if (!stop.reviewable) {
        update({ status: 'failed', failedPhase: firstPending(current()), failure: stop.message });
      }
      return {
        status: stop.reviewable ? 'needs-review' : 'failed', evidence, message: stop.message,
        failure: { code: stop.code, message: stop.message, remediation: stop.remediation, detail: stop.detail }
      };
    }

    // Automation finished. Installation success is NOT functional QA, so the step waits for a signed manual result.
    keepLog('qa-environment', `${kind === 'upgrade' ? 'Upgrade' : 'QA'} environment ${current().alias}`, summary(current()));
    const fp = sha256(JSON.stringify([git.fingerprint, targetId, current().id]));
    return {
      status: 'needs-review', evidence, fingerprint: fp,
      message: `Automation passed: ${current().verifiedInstalledVersion ?? targetId} installed in ${current().alias}. Manual QA checklist and sign-off are still required.`
    };
  };

  return { 'clean-install-qa': run('fresh-install'), 'upgrade-qa': run('upgrade') };
}

function firstPending(env: QaEnvironment): PhaseName | undefined {
  const order: PhaseName[] = ['create', 'dependencies', 'baseline', 'seed', 'install', 'verify', 'permsets', 'scripts', 'smoke', 'open'];
  return order.find(p => env.phases[p]?.status !== 'done' && !(env.kind === 'fresh-install' && (p === 'baseline' || p === 'seed')));
}

/** Environment facts safe to store/export (no tokens, no URLs). */
export function summary(env: QaEnvironment) {
  const { id, kind, alias, username, orgId, devHubAlias, devHubOrgId, targetVersionId, targetVersion, baselineVersion, status, failedPhase, failure, createdAt, expiresAt, phases, smoke, verifiedInstalledVersion, permsets } = env;
  return { id, kind, alias, username, orgId, devHubAlias, devHubOrgId, targetVersionId, targetVersion, baselineVersion, status, failedPhase, failure, createdAt, expiresAt, phases, smoke, verifiedInstalledVersion, permsets };
}

interface PlannedDependency {
  versionId: string;
  label: string;
}

/** Resolves each declared dependency to an installable 04t, in declaration order. */
export async function resolveDependencies(d: Pick<QaDeps, 'sf'>, dir: PackageDirectory, aliases: Record<string, string>, hub: string, cx: { root: string; signal?: AbortSignal }): Promise<PlannedDependency[]> {
  const plan: PlannedDependency[] = [];
  for (const dep of dir.dependencies) {
    const ref = dep.subscriberPackageVersionId ?? aliases[dep.package] ?? dep.package;
    if (/^04t[A-Za-z0-9]{12,15}$/.test(ref)) {
      plan.push({ versionId: ref, label: `${dep.package} (${ref})` });
      continue;
    }
    if (!/^0Ho[A-Za-z0-9]{12,15}$/.test(ref)) {
      throw new PhaseStop('DEPENDENCY_UNRESOLVED', `Dependency "${dep.package}" cannot be resolved to a package.`, 'Add it to packageAliases.');
    }
    const want = parseVersion(dep.versionNumber);
    if (!want) {
      throw new PhaseStop('DEPENDENCY_UNRESOLVED', `Dependency "${dep.package}" needs a valid versionNumber.`, 'Add versionNumber (e.g. 1.0.0.LATEST).');
    }
    const all = await listAllVersions(d.sf, hub, ref, cx);
    const matches = all.filter(v => { const p = parseVersion(v.version); return !!p && p.major === want.major && p.minor === want.minor && p.patch === want.patch && (want.build === 'LATEST' || want.build === 'NEXT' || p.build === want.build) && !!v.subscriberPackageVersionId; });
    const pick = matches.sort((a, b) => Number(b.isReleased) - Number(a.isReleased) || (Number(parseVersion(b.version)?.build) || 0) - (Number(parseVersion(a.version)?.build) || 0))[0];
    if (!pick?.subscriberPackageVersionId) {
      throw new PhaseStop('DEPENDENCY_UNRESOLVED', `No installable version of "${dep.package}" matches ${dep.versionNumber}.`, 'Build or release the dependency, or pin a 04t.');
    }
    plan.push({ versionId: pick.subscriberPackageVersionId, label: `${dep.package} ${pick.version}` });
  }
  return plan;
}
