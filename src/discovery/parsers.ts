/**
 * Whitelist parsers for Salesforce CLI JSON. Only named, non-secret fields are copied, so access tokens
 * present in `sf org list` output can never reach the UI, logs or persisted state.
 */

export interface OrgInfo {
  orgId: string;
  username: string;
  alias?: string;
  instanceUrl?: string;
  isDevHub: boolean;
  isScratch: boolean;
  isSandbox: boolean;
  tracksSource: boolean;
  isDefaultDevHub: boolean;
  isDefaultOrg: boolean;
  connectedStatus?: string;
  expired: boolean;
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

export function parseOrgList(result: unknown): OrgInfo[] {
  const byUser = new Map<string, OrgInfo>();
  for (const group of Object.values(o(result))) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const raw of group) {
      const r = o(raw);
      const username = s(r.username);
      const orgId = s(r.orgId);
      if (!username || !orgId) {
        continue;
      }
      const prev = byUser.get(username);
      byUser.set(username, {
        orgId, username,
        alias: s(r.alias) ?? prev?.alias,
        instanceUrl: s(r.instanceUrl) ?? prev?.instanceUrl,
        isDevHub: r.isDevHub === true || prev?.isDevHub === true,
        isScratch: r.isScratch === true || prev?.isScratch === true,
        isSandbox: r.isSandbox === true || prev?.isSandbox === true,
        tracksSource: r.tracksSource === true || prev?.tracksSource === true,
        isDefaultDevHub: r.isDefaultDevHubUsername === true || prev?.isDefaultDevHub === true,
        isDefaultOrg: r.isDefaultUsername === true || prev?.isDefaultOrg === true,
        connectedStatus: s(r.connectedStatus) ?? prev?.connectedStatus,
        expired: r.isExpired === true || prev?.expired === true
      });
    }
  }
  return [...byUser.values()].sort((a, b) => (a.alias ?? a.username).localeCompare(b.alias ?? b.username));
}

export interface DevHubPackage {
  id: string;
  name: string;
  namespacePrefix?: string;
  containerOptions?: string;
  alias?: string;
}

export function parsePackageList(result: unknown): DevHubPackage[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.flatMap(raw => {
    const r = o(raw);
    const id = s(r.Id) ?? s(r.id);
    const name = s(r.Name) ?? s(r.name);
    return id && name ? [{
      id, name,
      namespacePrefix: s(r.NamespacePrefix) ?? s(r.namespacePrefix),
      containerOptions: s(r.ContainerOptions) ?? s(r.containerOptions),
      alias: s(r.Alias) ?? s(r.alias)
    }] : [];
  });
}

export interface PackageVersionInfo {
  subscriberPackageVersionId?: string;
  packageId?: string;
  version?: string;
  branch?: string;
  isReleased: boolean;
  codeCoverage?: string;
  hasPassedCodeCoverageCheck?: boolean;
  ancestorId?: string;
  createdDate?: string;
}

export function parsePackageVersionList(result: unknown): PackageVersionInfo[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.map(raw => {
    const r = o(raw);
    const cov = o(r.CodeCoverage);
    return {
      subscriberPackageVersionId: s(r.SubscriberPackageVersionId),
      packageId: s(r.Package2Id),
      version: s(r.Version),
      branch: s(r.Branch),
      isReleased: r.IsReleased === true,
      codeCoverage: s(r.CodeCoverage) ?? (typeof cov.apexCodeCoveragePercentage === 'number' ? `${cov.apexCodeCoveragePercentage}%` : undefined),
      hasPassedCodeCoverageCheck: typeof r.HasPassedCodeCoverageCheck === 'boolean' ? r.HasPassedCodeCoverageCheck : undefined,
      ancestorId: s(r.AncestorId),
      createdDate: s(r.CreatedDate)
    };
  });
}

export interface PluginInfo {
  name: string;
  version: string;
}

export function parsePlugins(result: unknown): PluginInfo[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.flatMap(raw => {
    const r = o(raw);
    const name = s(r.name);
    return name ? [{ name, version: s(r.version) ?? '' }] : [];
  });
}

/** Parses plain-text `sf plugins` output; only the installed section (before "Uninstalled JIT Plugins") counts. */
export function parsePluginsText(text: string): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Uninstalled/i.test(line)) {
      break;
    }
    const m = /^\s*(@?[\w][\w./-]*)\s+(\d+\.\d+\.\d+\S*)/.exec(line);
    if (m) {
      plugins.push({ name: m[1], version: m[2] });
    }
  }
  return plugins;
}

export function parseConfigValue(result: unknown, key: string): string | undefined {
  if (!Array.isArray(result)) {
    return undefined;
  }
  const hit = result.map(o).find(r => r.name === key || r.key === key);
  return hit ? s(hit.value) : undefined;
}

export interface RetrieveChange {
  type: string;
  fullName: string;
  path?: string;
}

export interface RetrievePreview {
  toRetrieve: RetrieveChange[];
  toDeploy: RetrieveChange[];
  toDelete: RetrieveChange[];
  conflicts: RetrieveChange[];
}

export function parseRetrievePreview(result: unknown): RetrievePreview {
  const r = o(result);
  const list = (key: string): RetrieveChange[] =>
    (Array.isArray(r[key]) ? r[key] as unknown[] : []).flatMap(raw => {
      const c = o(raw);
      const fullName = s(c.fullName);
      return fullName ? [{ type: s(c.type) ?? 'Unknown', fullName, path: s(c.projectRelativePath) ?? s(c.path) }] : [];
    });
  return { toRetrieve: list('toRetrieve'), toDeploy: list('toDeploy'), toDelete: list('toDelete'), conflicts: list('conflicts') };
}
