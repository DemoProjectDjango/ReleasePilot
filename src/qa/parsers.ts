/** Whitelist parsers: scratch-org and install JSON can contain tokens/URLs, so only named fields are copied. */
const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export interface ScratchOrgResult {
  orgId: string;
  username: string;
  expirationDate?: string;
}

export function parseScratchCreate(result: unknown): ScratchOrgResult | undefined {
  const r = o(result);
  const orgId = s(r.orgId) ?? s(o(r.scratchOrgInfo).Id);
  const username = s(r.username) ?? s(o(r.authFields).username);
  if (!orgId || !username) {
    return undefined;
  }
  return { orgId, username, expirationDate: s(o(r.scratchOrgInfo).ExpirationDate) ?? s(r.expirationDate) };
}

export type InstallStatus = 'IN_PROGRESS' | 'SUCCESS' | 'ERROR' | string;

export interface InstallResult {
  requestId?: string;
  status: InstallStatus;
  errors: string[];
  versionId?: string;
}

function messages(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(e => (typeof e === 'string' ? e : s(o(e).message) ?? s(o(e).Message) ?? JSON.stringify(e))).filter(Boolean);
  }
  if (v && typeof v === 'object') {
    const inner = o(v);
    const direct = s(inner.message) ?? s(inner.Message);
    if (direct) {
      return [direct];
    }
    const nested = (Array.isArray(inner.errors) ? inner.errors : []).flatMap(messages);
    return nested.length ? nested : [JSON.stringify(v).slice(0, 500)];
  }
  return typeof v === 'string' && v ? [v] : [];
}

export function parseInstallResult(result: unknown): InstallResult {
  const r = o(Array.isArray(result) ? result[0] : result);
  return {
    requestId: s(r.Id) ?? s(r.id),
    status: (s(r.Status) ?? s(r.status) ?? 'UNKNOWN').toUpperCase(),
    errors: [...messages(r.Errors), ...messages(r.errors), ...messages(r.Error)],
    versionId: s(r.SubscriberPackageVersionKey) ?? s(r.subscriberPackageVersionKey)
  };
}

export interface InstalledPackage {
  versionId?: string;
  packageId?: string;
  name?: string;
  namespace?: string;
  versionNumber?: string;
}

export function parseInstalledList(result: unknown): InstalledPackage[] {
  return (Array.isArray(result) ? result : []).map(raw => {
    const r = o(raw);
    return {
      versionId: s(r.SubscriberPackageVersionId), packageId: s(r.SubscriberPackageId), name: s(r.SubscriberPackageName),
      namespace: s(r.SubscriberPackageNamespace), versionNumber: s(r.SubscriberPackageVersionNumber)
    };
  });
}

export function parseQueryRecords(result: unknown): Array<Record<string, unknown>> {
  const recs = o(result).records;
  return Array.isArray(recs) ? recs.map(o) : [];
}

export interface ScratchListEntry {
  alias?: string;
  username: string;
  orgId: string;
  status?: string;
  devHubOrgId?: string;
  expirationDate?: string;
}

/** Scratch orgs from `sf org list` (tokens are never copied). */
export function parseScratchOrgs(result: unknown): ScratchListEntry[] {
  const list = o(result).scratchOrgs;
  return (Array.isArray(list) ? list : []).flatMap(raw => {
    const r = o(raw);
    const username = s(r.username);
    const orgId = s(r.orgId);
    return username && orgId ? [{ alias: s(r.alias), username, orgId, status: s(r.status), devHubOrgId: s(r.devHubOrgId), expirationDate: s(r.expirationDate) }] : [];
  });
}
