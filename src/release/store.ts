import * as fs from 'fs';
import * as path from 'path';
import type { ReadinessReport } from './gates';

export interface Override {
  gateId: string;
  /** The candidate and source the override applies to; it lapses if either changes. */
  versionId: string;
  sourceFingerprint: string;
  reason: string;
  owner: string;
  at: string;
}

export interface PromotionRecord {
  versionId: string;
  packageId: string;
  devHubOrgId: string;
  devHubAlias: string;
  /** attempting = the promote command was about to run / may have run; always re-query before trusting. */
  status: 'attempting' | 'released' | 'failed';
  approver: string;
  evidenceHash: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ReleaseEntry {
  at: string;
  packageName: string;
  packageId: string;
  devHubAlias: string;
  devHubOrgId: string;
  versionId: string;
  version?: string;
  approver: string;
  evidenceHash: string;
  sourceFingerprint: string;
  coverage?: number;
  overrides: Override[];
  receiptRef: string;
  /** True when Salesforce already showed the version as released and ReleasePilot only verified it. */
  verifiedOnly: boolean;
}

interface Data {
  overrides: Override[];
  promotions: PromotionRecord[];
  history: ReleaseEntry[];
  lastReport?: ReadinessReport;
}

/** Audit trail for release decisions: overrides, promotion attempts and completed releases. */
export class ReleaseStore {
  private data: Data = { overrides: [], promotions: [], history: [] };

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const d = parsed as Partial<Data>;
        this.data = { overrides: d.overrides ?? [], promotions: d.promotions ?? [], history: d.history ?? [], lastReport: d.lastReport };
      }
    } catch {
      this.data = { overrides: [], promotions: [], history: [] };
    }
  }

  overrides(): Override[] {
    return [...this.data.overrides];
  }

  addOverride(o: Override): void {
    if (o.reason.trim().length < 15) {
      throw new Error('An override needs a justification of at least 15 characters.');
    }
    if (!o.owner.trim()) {
      throw new Error('An override needs an owner.');
    }
    this.data.overrides = [...this.data.overrides.filter(x => !(x.gateId === o.gateId && x.versionId === o.versionId)), o];
    this.save();
  }

  removeOverride(gateId: string, versionId: string): void {
    this.data.overrides = this.data.overrides.filter(x => !(x.gateId === gateId && x.versionId === versionId));
    this.save();
  }

  promotion(versionId: string): PromotionRecord | undefined {
    return this.data.promotions.find(p => p.versionId === versionId);
  }

  setPromotion(p: PromotionRecord): void {
    this.data.promotions = [p, ...this.data.promotions.filter(x => x.versionId !== p.versionId)].slice(0, 100);
    this.save();
  }

  history(): ReleaseEntry[] {
    return [...this.data.history];
  }

  addHistory(e: ReleaseEntry): void {
    this.data.history = [e, ...this.data.history.filter(x => x.versionId !== e.versionId)].slice(0, 200);
    this.save();
  }

  lastReport(): ReadinessReport | undefined {
    return this.data.lastReport;
  }

  setLastReport(r: ReadinessReport): void {
    this.data.lastReport = r;
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
