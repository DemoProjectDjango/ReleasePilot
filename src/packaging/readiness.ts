import { GitSnapshot } from '../adapters/git';
import { DevHubPackage } from '../discovery/parsers';
import { PackageDirectory, ProjectInfo } from '../discovery/project';
import { CreateRequest, ExistingVersion } from './parsers';
import { compareMmp, mmp, parseVersion } from './versions';

export interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  remediation?: string;
}

export interface ReadinessInput {
  project: ProjectInfo;
  dir: PackageDirectory;
  pkg: DevHubPackage;
  versions: ExistingVersion[];
  /** Create requests from the Dev Hub (any status); in-flight ones are filtered here. */
  requests: CreateRequest[];
  git: GitSnapshot;
  allowDirty: boolean;
  /** Source fingerprints recorded by the analysis and test runs. */
  analysisFingerprint?: string;
  testsFingerprint?: string;
  analysisPassed: boolean;
  testsPassed: boolean;
  /** Results of looking up explicit 04t dependency versions in the Dev Hub. */
  dependencyLookup: Record<string, 'found' | 'missing'>;
}

const IN_FLIGHT = ['Queued', 'InProgress', 'Verifying'];
const V04T = /^04t[A-Za-z0-9]{12,15}$/;

/**
 * Pure readiness evaluation (FR-14). Every failure names the cause and the fix; nothing here talks to Salesforce,
 * so it is unit-testable. Salesforce itself remains the final authority at build time.
 */
export function evaluateReadiness(i: ReadinessInput): Check[] {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string, remediation?: string) => checks.push({ name, status, detail, remediation });

  // Package type
  if (i.pkg.containerOptions && i.pkg.containerOptions !== 'Managed') {
    add('Package type', 'fail', `${i.pkg.name} is "${i.pkg.containerOptions}", not Managed.`, 'ReleasePilot supports managed 2GP packages only.');
  } else {
    add('Package type', 'pass', `${i.pkg.name} (${i.pkg.id}) is a managed package.`);
  }

  // Version number
  const target = parseVersion(i.dir.versionNumber);
  const released = i.versions.filter(v => v.isReleased).map(v => parseVersion(v.version)).filter((v): v is NonNullable<typeof v> => !!v);
  const all = i.versions.map(v => parseVersion(v.version)).filter((v): v is NonNullable<typeof v> => !!v);
  if (!target) {
    add('Version number', 'fail', `versionNumber "${i.dir.versionNumber ?? '(missing)'}" is not valid.`, 'Set versionNumber like 1.4.0.NEXT in sfdx-project.json.');
  } else {
    if (target.build !== 'NEXT') {
      add('Version number', 'warn', `versionNumber ${i.dir.versionNumber} pins a build number; use .NEXT so Salesforce assigns it.`);
    }
    const highestReleased = released.sort(compareMmp).at(-1);
    const highestAny = all.sort(compareMmp).at(-1);
    if (highestReleased && compareMmp(target, highestReleased) === 0) {
      add('Version number', 'fail', `${mmp(target)} is already released. A new version needs a higher major.minor.patch.`, 'Increase versionNumber in sfdx-project.json.');
    } else if (highestReleased && compareMmp(target, highestReleased) < 0) {
      add('Version number', 'fail', `${mmp(target)} is lower than the released ${mmp(highestReleased)}.`, 'Use a higher version, or build older patches from a dedicated branch.');
    } else if (highestAny && compareMmp(target, highestAny) < 0) {
      add('Version number', 'warn', `${mmp(target)} is lower than an existing beta ${mmp(highestAny)}.`);
    } else {
      add('Version number', 'pass', `${i.dir.versionNumber} is higher than every released version${highestReleased ? ` (latest released ${mmp(highestReleased)})` : ' (none released yet)'}.`);
    }
  }

  // Ancestry
  const releasedRaw = i.versions.filter(v => v.isReleased);
  const anc = i.dir.ancestorId ?? i.dir.ancestorVersion;
  if (releasedRaw.length === 0) {
    add('Ancestry', anc && anc !== 'NONE' ? 'warn' : 'pass',
      anc && anc !== 'NONE' ? `No released version exists yet, but an ancestor "${anc}" is configured.` : 'First release: no ancestor needed.');
  } else if (!anc) {
    add('Ancestry', 'fail', 'Released versions exist, so an ancestor is required.', 'Set ancestorId (a released 04t, alias or HIGHEST) or ancestorVersion in sfdx-project.json. ReleasePilot never uses --skip-ancestor-check.');
  } else if (anc === 'NONE') {
    add('Ancestry', 'fail', 'ancestorId is NONE although released versions exist.', 'Choose HIGHEST or a specific released version.');
  } else if (anc === 'HIGHEST') {
    add('Ancestry', 'pass', 'Ancestor is HIGHEST (the latest released version).');
  } else {
    const resolved = i.project.packageAliases[anc] ?? anc;
    if (V04T.test(resolved)) {
      const hit = releasedRaw.find(v => v.subscriberPackageVersionId === resolved);
      add('Ancestry', hit ? 'pass' : 'fail', hit ? `Ancestor ${resolved} is released version ${hit.version}.` : `Ancestor ${resolved} is not a released version of this package.`,
        hit ? undefined : 'Pick a released 04t of this package, or HIGHEST.');
    } else {
      const v = parseVersion(resolved);
      const hit = v && releasedRaw.some(r => { const p = parseVersion(r.version); return !!p && compareMmp(p, v) === 0; });
      add('Ancestry', hit ? 'pass' : 'fail', hit ? `Ancestor version ${resolved} matches a released version.` : `Ancestor "${anc}" does not match any released version.`,
        hit ? undefined : 'Use a released version number, a released 04t, or HIGHEST.');
    }
  }

  // Dependencies
  if (i.dir.dependencies.length === 0) {
    add('Dependencies', 'pass', 'No package dependencies.');
  }
  for (const dep of i.dir.dependencies) {
    const ref = dep.subscriberPackageVersionId ?? i.project.packageAliases[dep.package] ?? dep.package;
    if (dep.subscriberPackageVersionId || V04T.test(ref)) {
      const id = dep.subscriberPackageVersionId ?? ref;
      const found = i.dependencyLookup[id];
      add(`Dependency ${dep.package}`, found === 'found' ? 'pass' : found === 'missing' ? 'fail' : 'warn',
        found === 'found' ? `${id} exists in the Dev Hub.` : found === 'missing' ? `${id} was not found in the Dev Hub.` : `${id} could not be verified.`,
        found === 'missing' ? 'Fix subscriberPackageVersionId or the alias in sfdx-project.json.' : undefined);
    } else if (ref.startsWith('0Ho')) {
      add(`Dependency ${dep.package}`, dep.versionNumber && parseVersion(dep.versionNumber) ? 'pass' : 'fail',
        dep.versionNumber && parseVersion(dep.versionNumber) ? `${dep.package} ${dep.versionNumber}.` : `${dep.package} needs a valid versionNumber (e.g. 1.0.0.LATEST).`,
        dep.versionNumber ? undefined : 'Add versionNumber to the dependency.');
    } else {
      add(`Dependency ${dep.package}`, 'fail', `"${dep.package}" is not defined in packageAliases.`, 'Add the alias (0Ho or 04t) to packageAliases.');
    }
  }

  // In-flight builds on the Dev Hub
  const flying = i.requests.filter(r => r.packageId === i.pkg.id && IN_FLIGHT.includes(r.status));
  if (flying.length) {
    add('Build in progress', 'fail', `${flying.length} build request(s) already ${flying[0].status}: ${flying.map(r => r.requestId).join(', ')}.`,
      'Wait for it to finish (or track it) instead of starting a duplicate.');
  } else {
    add('Build in progress', 'pass', 'No queued or in-progress build requests for this package.');
  }

  // Source state
  if (!i.git.isRepo || !i.git.fingerprint) {
    add('Source snapshot', 'fail', i.git.error ?? 'Git is required to bind the package to its source.', 'Place the project under Git.');
  } else if (i.git.files.length && !i.allowDirty) {
    add('Source snapshot', 'fail', `${i.git.files.length} uncommitted change(s). Packaging uses the files on disk, so they would be included.`,
      'Commit or stash them, or enable releasepilot.allowDirtySource.');
  } else if (i.git.files.length) {
    add('Source snapshot', 'warn', `${i.git.files.length} uncommitted change(s) will be packaged (allowed by setting).`);
  } else {
    add('Source snapshot', 'pass', `Clean tree at ${(i.git.head ?? '').slice(0, 8)} on ${i.git.branch ?? '?'}.`);
  }

  // Validation evidence must describe the same source
  const fp = i.git.fingerprint;
  const fresh = (name: string, passed: boolean, recorded?: string) => {
    if (!passed) {
      add(`${name} validation`, 'fail', `${name} has not passed.`, `Run ${name} until it passes.`);
    } else if (!fp || recorded !== fp) {
      add(`${name} validation`, 'fail', `${name} passed for different source than the current tree.`, `Re-run ${name} on the current source.`);
    } else {
      add(`${name} validation`, 'pass', `${name} passed for the current source.`);
    }
  };
  fresh('Static analysis', i.analysisPassed, i.analysisFingerprint);
  fresh('Pre-package tests', i.testsPassed, i.testsFingerprint);
  return checks;
}
