import * as fs from 'fs';
import * as path from 'path';

export type QaKind = 'fresh-install' | 'upgrade';
export type PhaseName = 'definition' | 'create' | 'dependencies' | 'baseline' | 'seed' | 'install' | 'verify' | 'permsets' | 'scripts' | 'smoke' | 'open';

export interface Phase {
  status: 'pending' | 'done' | 'failed';
  at?: string;
  detail?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  state: 'pending' | 'pass' | 'fail';
  note?: string;
  by?: string;
  at?: string;
}

export interface SmokeCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface QaEnvironment {
  id: string;
  kind: QaKind;
  alias: string;
  username?: string;
  orgId?: string;
  devHubOrgId: string;
  devHubAlias: string;
  packageId: string;
  packageName: string;
  /** The candidate (target) subscriber package version under test. */
  targetVersionId: string;
  targetVersion?: string;
  /** Upgrade tests only: the released version installed first. */
  baselineVersionId?: string;
  baselineVersion?: string;
  sourceFingerprint: string;
  status: 'creating' | 'ready' | 'failed' | 'deleted';
  failedPhase?: PhaseName;
  failure?: string;
  createdAt: string;
  expiresAt?: string;
  durationDays: number;
  definitionFile: string;
  installRequestId?: string;
  baselineRequestId?: string;
  /** Install request ids for package dependencies, keyed by the dependency 04t. */
  dependencyInstalls?: Record<string, string>;
  installStatus?: string;
  verifiedInstalledVersion?: string;
  permsets: string[];
  phases: Partial<Record<PhaseName, Phase>>;
  smoke: SmokeCheck[];
  logRefs: string[];
  checklist: ChecklistItem[];
  signoff?: { approver: string; at: string; note?: string };
}

/** Persists QA environments the moment they are requested so a restart can reconcile instead of duplicating. */
export class QaStore {
  private envs: QaEnvironment[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        this.envs = parsed as QaEnvironment[];
      }
    } catch {
      this.envs = [];
    }
  }

  list(): QaEnvironment[] {
    return [...this.envs];
  }

  get(id: string): QaEnvironment | undefined {
    return this.envs.find(e => e.id === id);
  }

  save(env: QaEnvironment): void {
    this.envs = [env, ...this.envs.filter(e => e.id !== env.id)].slice(0, 60);
    this.persist();
  }

  /** The newest environment for a version and kind that can still be continued (not failed or deleted). */
  resumable(kind: QaKind, targetVersionId: string, devHubOrgId: string): QaEnvironment | undefined {
    return this.envs.find(e => e.kind === kind && e.targetVersionId === targetVersionId && e.devHubOrgId === devHubOrgId && (e.status === 'creating' || e.status === 'ready') && !e.signoff);
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.envs, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

export const DEFAULT_QA_CHECKLIST = [
  'Log in to the QA org as an administrator (Open Org).',
  'Setup > Installed Packages shows the expected package version.',
  'The main user flows changed in this release work end to end.',
  'The assigned permission sets give the expected access; a non-admin user can use the app.',
  'No unexpected errors appear in Setup > Apex Jobs, Debug Logs or the browser console.',
  'Pages and components render correctly in Lightning Experience.'
];

export const DEFAULT_UPGRADE_CHECKLIST = [
  'Data created before the upgrade (records, configuration, subscriber edits) is intact after the upgrade.',
  'Features that worked in the previous released version still work after the upgrade.',
  'Permissions, settings and layouts customized by the subscriber were preserved.',
  'Any post-install/migration behaviour ran as expected and left no errors.',
  'New functionality in this version works for an upgraded org, not only for a fresh install.'
];

export function makeChecklist(texts: string[]): ChecklistItem[] {
  return texts.map((text, i) => ({ id: `c${i + 1}`, text, state: 'pending' as const }));
}

/** Manual QA passes only when every item is explicitly marked pass. */
export function checklistStatus(items: ChecklistItem[]): 'pass' | 'fail' | 'pending' {
  if (items.some(i => i.state === 'fail')) {
    return 'fail';
  }
  return items.length > 0 && items.every(i => i.state === 'pass') ? 'pass' : 'pending';
}
