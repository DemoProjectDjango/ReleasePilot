import * as fs from 'fs';
import * as path from 'path';

export interface PackageCandidate {
  requestId: string;
  packageId: string;
  packageName: string;
  devHubOrgId: string;
  devHubAlias: string;
  versionNumber: string;
  branch?: string;
  tag?: string;
  status: string;
  subscriberPackageVersionId?: string;
  packageVersionId?: string;
  errors: string[];
  coveragePercent?: number;
  hasPassedCodeCoverageCheck?: boolean;
  ancestorId?: string;
  validationSkipped?: boolean;
  isReleased?: boolean;
  /** Source fingerprint the package was created from; binds the 04t to the validated source. */
  sourceFingerprint: string;
  keyMode: 'key' | 'bypass';
  createdAt: string;
  completedAt?: string;
  lastPolledAt?: string;
}

export interface ReadinessRecord {
  at: string;
  fingerprint: string;
  /** Git fingerprint of the source the checks were evaluated against. */
  sourceFingerprint?: string;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; detail: string; remediation?: string }>;
  packageId?: string;
}

interface Data {
  candidates: PackageCandidate[];
  readiness?: ReadinessRecord;
}

const IN_FLIGHT = ['Queued', 'InProgress', 'Verifying'];

/** Persists build requests the moment they exist so a restart can resume tracking instead of creating a duplicate. */
export class PackagingStore {
  private data: Data = { candidates: [] };

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Data).candidates)) {
        this.data = parsed as Data;
      }
    } catch {
      this.data = { candidates: [] };
    }
  }

  candidates(): PackageCandidate[] {
    return [...this.data.candidates];
  }

  readiness(): ReadinessRecord | undefined {
    return this.data.readiness;
  }

  setReadiness(r: ReadinessRecord): void {
    this.data.readiness = r;
    this.save();
  }

  upsert(c: PackageCandidate): void {
    const rest = this.data.candidates.filter(x => x.requestId !== c.requestId);
    this.data.candidates = [c, ...rest].slice(0, 100);
    this.save();
  }

  get(requestId: string): PackageCandidate | undefined {
    return this.data.candidates.find(c => c.requestId === requestId);
  }

  /** A request we started that has not reached a terminal state. */
  inFlight(packageId: string, devHubOrgId: string): PackageCandidate | undefined {
    return this.data.candidates.find(c => c.packageId === packageId && c.devHubOrgId === devHubOrgId && IN_FLIGHT.includes(c.status));
  }

  /** A successful build of exactly this source for this package and Dev Hub (prevents duplicate builds on retry). */
  successFor(packageId: string, devHubOrgId: string, sourceFingerprint: string, versionNumber: string): PackageCandidate | undefined {
    return this.data.candidates.find(c => c.packageId === packageId && c.devHubOrgId === devHubOrgId &&
      c.sourceFingerprint === sourceFingerprint && c.versionNumber === versionNumber && c.status === 'Success' && !!c.subscriberPackageVersionId);
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
