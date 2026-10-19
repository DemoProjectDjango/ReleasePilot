const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const n = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && /^\d+(\.\d+)?%?$/.test(v.trim())) {
    return parseFloat(v);
  }
  return undefined;
};

export type RequestStatus = 'Queued' | 'InProgress' | 'Verifying' | 'Success' | 'Error' | 'Canceled' | string;
export const TERMINAL: readonly string[] = ['Success', 'Error', 'Canceled'];

export interface CreateRequest {
  requestId: string;
  status: RequestStatus;
  packageId?: string;
  packageVersionId?: string;
  subscriberPackageVersionId?: string;
  branch?: string;
  tag?: string;
  versionNumber?: string;
  errors: string[];
  createdDate?: string;
  codeCoverage?: number;
  hasPassedCodeCoverageCheck?: boolean;
}

function errorList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(e => (typeof e === 'string' ? e : s(o(e).message) ?? JSON.stringify(e))).filter(Boolean);
  }
  return typeof v === 'string' && v ? [v] : [];
}

/** Coverage appears as {apexCodeCoveragePercentage: 80}, a number, or a "80%" string depending on the command. */
export function parseCoverage(v: unknown): number | undefined {
  return n(o(v).apexCodeCoveragePercentage) ?? n(v);
}

export function parseCreateRequest(raw: unknown): CreateRequest | undefined {
  const r = o(Array.isArray(raw) ? raw[0] : raw);
  const requestId = s(r.Id) ?? s(r.id);
  if (!requestId) {
    return undefined;
  }
  return {
    requestId, status: s(r.Status) ?? s(r.status) ?? 'Unknown',
    packageId: s(r.Package2Id), packageVersionId: s(r.Package2VersionId),
    subscriberPackageVersionId: s(r.SubscriberPackageVersionId),
    branch: s(r.Branch), tag: s(r.Tag), versionNumber: s(r.VersionNumber),
    errors: errorList(r.Error), createdDate: s(r.CreatedDate),
    codeCoverage: parseCoverage(r.CodeCoverage),
    hasPassedCodeCoverageCheck: typeof r.HasPassedCodeCoverageCheck === 'boolean' ? r.HasPassedCodeCoverageCheck : undefined
  };
}

export function parseCreateRequestList(raw: unknown): CreateRequest[] {
  return (Array.isArray(raw) ? raw : []).flatMap(x => {
    const r = parseCreateRequest(x);
    return r ? [r] : [];
  });
}

export interface VersionReport {
  subscriberPackageVersionId?: string;
  packageId?: string;
  version?: string;
  branch?: string;
  tag?: string;
  ancestorId?: string;
  ancestorVersion?: string;
  isReleased: boolean;
  validationSkipped: boolean;
  validatedAsync: boolean;
  codeCoverage?: number;
  hasPassedCodeCoverageCheck?: boolean;
  packageType?: string;
}

export function parseVersionReport(raw: unknown): VersionReport | undefined {
  const r = o(Array.isArray(raw) ? raw[0] : raw);
  if (!s(r.SubscriberPackageVersionId) && !s(r.Id)) {
    return undefined;
  }
  return {
    subscriberPackageVersionId: s(r.SubscriberPackageVersionId), packageId: s(r.Package2Id),
    version: s(r.Version), branch: s(r.Branch), tag: s(r.Tag),
    ancestorId: s(r.AncestorId), ancestorVersion: s(r.AncestorVersion),
    isReleased: r.IsReleased === true, validationSkipped: r.ValidationSkipped === true, validatedAsync: r.ValidatedAsync === true,
    codeCoverage: parseCoverage(r.CodeCoverage),
    hasPassedCodeCoverageCheck: typeof r.HasPassedCodeCoverageCheck === 'boolean' ? r.HasPassedCodeCoverageCheck : undefined,
    packageType: s(r.PackageType)
  };
}

export interface ExistingVersion {
  subscriberPackageVersionId?: string;
  /** The 05i package version id (what AncestorId refers to). */
  packageVersionId?: string;
  ancestorId?: string;
  passwordProtected?: boolean;
  version: string;
  isReleased: boolean;
  branch?: string;
}

export function parseVersionList(raw: unknown): ExistingVersion[] {
  return (Array.isArray(raw) ? raw : []).flatMap(x => {
    const r = o(x);
    const version = s(r.Version);
    return version ? [{ version, subscriberPackageVersionId: s(r.SubscriberPackageVersionId), packageVersionId: s(r.Id), ancestorId: s(r.AncestorId), passwordProtected: typeof r.IsPasswordProtected === 'boolean' ? r.IsPasswordProtected : undefined, isReleased: r.IsReleased === true, branch: s(r.Branch) }] : [];
  });
}
