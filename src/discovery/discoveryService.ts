import { GitAdapter, GitSnapshot } from '../adapters/git';
import { CommandRecord } from '../adapters/commandHistory';
import { SfCli, SfError, assertAlias } from '../adapters/sfCli';
import { DevHubPackage, OrgInfo, PackageVersionInfo, PluginInfo, parseConfigValue, parseOrgList, parsePackageList, parsePackageVersionList, parsePluginsText } from './parsers';
import { ProjectConfig, readConfig, writeConfig } from './projectConfig';
import { ProjectError, ProjectInfo, readProject } from './project';

export interface DiscoveryError {
  code: string;
  message: string;
  remediation?: string;
  scope: string;
}

export interface Tooling {
  sf?: string;
  node: string;
  codeAnalyzer?: PluginInfo;
  legacyScanner?: PluginInfo;
  git?: string;
}

export interface DiscoverySnapshot {
  root?: string;
  project?: ProjectInfo;
  config: ProjectConfig;
  tooling?: Tooling;
  orgs: OrgInfo[];
  devHub?: OrgInfo;
  devOrg?: OrgInfo;
  validationOrg?: OrgInfo;
  packages: DevHubPackage[];
  selectedPackage?: DevHubPackage;
  versions: PackageVersionInfo[];
  git?: GitSnapshot;
  errors: DiscoveryError[];
  commands: CommandRecord[];
  discoveredAt?: string;
}

export class DiscoveryService {
  private snap: DiscoverySnapshot = { config: { schemaVersion: '1.0' }, orgs: [], packages: [], versions: [], errors: [], commands: [] };

  constructor(private readonly sf: SfCli, private readonly git: GitAdapter) {}

  get snapshot(): DiscoverySnapshot {
    return { ...this.snap, commands: this.sf.history.list().slice(0, 50) };
  }

  /** Full read-only discovery for a project root. Errors are collected, never swallowed. */
  async discover(root: string, signal?: AbortSignal): Promise<DiscoverySnapshot> {
    const errors: DiscoveryError[] = [];
    const next: DiscoverySnapshot = { root, config: readConfig(root), orgs: [], packages: [], versions: [], errors, commands: [] };
    const fail = (scope: string, e: unknown) => {
      if (e instanceof SfError) {
        errors.push({ scope, code: e.code, message: e.message, remediation: e.remediation });
      } else if (e instanceof ProjectError) {
        errors.push({ scope, code: e.code, message: e.message });
      } else {
        errors.push({ scope, code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e) });
      }
    };

    try { next.project = readProject(root); } catch (e) { fail('project', e); }

    const [tooling, gitSnap] = await Promise.all([this.tooling(root, signal, fail), this.git.snapshot(root)]);
    next.tooling = tooling;
    next.git = gitSnap;
    if (gitSnap.error) {
      errors.push({ scope: 'git', code: 'GIT', message: gitSnap.error });
    }

    if (this.sf.available) {
      try {
        const { result } = await this.sf.json(['org', 'list', '--skip-connection-status'], { cwd: root, signal });
        next.orgs = parseOrgList(result);
      } catch (e) { fail('orgs', e); }

      const defaults = await this.defaults(root, signal);
      const find = (name?: string) => name ? next.orgs.find(o => o.alias === name || o.username === name) : undefined;
      next.devHub = find(next.config.devHubAlias) ?? find(defaults.devHub);
      next.devOrg = find(next.config.devOrgAlias) ?? find(defaults.org);
      // The validation org is never defaulted: tests/deploys must target an explicit, user-chosen org.
      next.validationOrg = find(next.config.validationOrgAlias);
      if (next.config.devHubAlias && !find(next.config.devHubAlias)) {
        errors.push({ scope: 'orgs', code: 'ORG_NOT_FOUND', message: `Configured Dev Hub "${next.config.devHubAlias}" is not among the authenticated orgs.`, remediation: 'Authenticate it with "sf org login web --set-default-dev-hub" or select another Dev Hub.' });
      }
      if (next.devHub && !next.devHub.isDevHub) {
        errors.push({ scope: 'orgs', code: 'NOT_DEV_HUB', message: `"${next.devHub.alias ?? next.devHub.username}" is not a Dev Hub org.` });
        next.devHub = undefined;
      }
      if (next.devHub) {
        await this.loadPackages(next, root, signal, fail);
      }
    }
    next.discoveredAt = new Date().toISOString();
    this.snap = next;
    return this.snapshot;
  }

  async selectDevHub(alias: string | undefined, signal?: AbortSignal): Promise<DiscoverySnapshot> {
    return this.update({ devHubAlias: alias ? assertAlias(alias) : undefined, packageAlias: undefined }, signal);
  }

  async selectDevOrg(alias: string | undefined, signal?: AbortSignal): Promise<DiscoverySnapshot> {
    return this.update({ devOrgAlias: alias ? assertAlias(alias) : undefined }, signal);
  }

  async selectValidationOrg(alias: string | undefined, signal?: AbortSignal): Promise<DiscoverySnapshot> {
    return this.update({ validationOrgAlias: alias ? assertAlias(alias) : undefined }, signal);
  }

  async selectPackage(alias: string | undefined, signal?: AbortSignal): Promise<DiscoverySnapshot> {
    return this.update({ packageAlias: alias ? assertAlias(alias) : undefined }, signal);
  }

  private async update(patch: Partial<ProjectConfig>, signal?: AbortSignal): Promise<DiscoverySnapshot> {
    const root = this.snap.root;
    if (!root) {
      return this.snapshot;
    }
    writeConfig(root, { ...readConfig(root), ...patch });
    return this.discover(root, signal);
  }

  private async tooling(root: string, signal: AbortSignal | undefined, fail: (s: string, e: unknown) => void): Promise<Tooling> {
    const t: Tooling = { node: process.version };
    if (!this.sf.available) {
      fail('tooling', new SfError('SF_NOT_FOUND', 'Salesforce CLI (sf) was not found on PATH.', 'Install it from https://developer.salesforce.com/tools/salesforcecli and restart VS Code.'));
      return t;
    }
    try { t.sf = (await this.sf.text(['--version'], { cwd: root, signal, timeoutMs: 30_000 })).split(/\r?\n/)[0]; } catch (e) { fail('tooling', e); }
    try {
      const plugins = parsePluginsText(await this.sf.text(['plugins'], { cwd: root, signal, timeoutMs: 60_000 }));
      t.codeAnalyzer = plugins.find(p => p.name === '@salesforce/plugin-code-analyzer' || p.name === 'code-analyzer');
      t.legacyScanner = plugins.find(p => p.name === '@salesforce/sfdx-scanner');
    } catch (e) { fail('tooling', e); }
    return t;
  }

  private async defaults(root: string, signal?: AbortSignal): Promise<{ devHub?: string; org?: string }> {
    try {
      const { result } = await this.sf.json(['config', 'get', 'target-dev-hub', 'target-org'], { cwd: root, signal });
      return { devHub: parseConfigValue(result, 'target-dev-hub'), org: parseConfigValue(result, 'target-org') };
    } catch {
      return {};
    }
  }

  private async loadPackages(next: DiscoverySnapshot, root: string, signal: AbortSignal | undefined, fail: (s: string, e: unknown) => void): Promise<void> {
    const hub = next.devHub!.username;
    try {
      const { result } = await this.sf.json(['package', 'list', '--target-dev-hub', hub], { cwd: root, signal });
      next.packages = parsePackageList(result);
    } catch (e) { fail('packages', e); return; }

    const projectIds = new Set((next.project?.packageDirectories ?? []).map(p => p.packageId).filter(Boolean));
    const wanted = next.config.packageAlias;
    next.selectedPackage =
      (wanted ? next.packages.find(p => p.id === wanted || p.alias === wanted || p.name === wanted) : undefined) ??
      next.packages.find(p => projectIds.has(p.id));
    if (next.selectedPackage) {
      try {
        const { result } = await this.sf.json(['package', 'version', 'list', '--target-dev-hub', hub, '--packages', next.selectedPackage.id, '--concise'], { cwd: root, signal, timeoutMs: 180_000 });
        next.versions = parsePackageVersionList(result).slice(-15).reverse();
      } catch (e) { fail('versions', e); }
    }
  }
}
