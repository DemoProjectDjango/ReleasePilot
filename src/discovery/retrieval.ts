import * as path from 'path';
import { GitAdapter, GitSnapshot } from '../adapters/git';
import { SfCli, SfError, assertAlias } from '../adapters/sfCli';
import { OrgInfo, RetrievePreview, parseRetrievePreview } from './parsers';

export interface PreviewOutcome {
  orgId: string;
  orgLabel: string;
  at: string;
  preview: RetrievePreview;
  dirtyFiles: string[];
  /** Locally modified files that the retrieval would also overwrite. */
  overlap: string[];
  blockers: string[];
}

export type ApplyOutcome =
  | { ok: true; retrieved: number; changedFiles: string[]; orgLabel: string; at: string }
  | { ok: false; code: string; message: string; needsConfirmation?: boolean };

const norm = (p: string) => path.normalize(p).replace(/\\/g, '/');

/**
 * Conflict-safe retrieval. Never passes --ignore-conflicts; never runs without a fresh preview of the
 * same org against the same working tree; refuses when the retrieval would overwrite local edits.
 */
export class RetrievalService {
  private last?: PreviewOutcome & { gitFingerprint?: string };

  constructor(private readonly sf: SfCli, private readonly git: GitAdapter) {}

  get lastPreview(): PreviewOutcome | undefined {
    return this.last;
  }

  async preview(root: string, org: OrgInfo, signal?: AbortSignal): Promise<PreviewOutcome> {
    const target = assertAlias(org.alias ?? org.username);
    if (!org.tracksSource) {
      throw new SfError('NO_SOURCE_TRACKING', `"${target}" does not use source tracking, so changes cannot be previewed safely.`,
        'Use a sandbox, scratch or source-tracking developer org. Manifest-based retrieval is not yet supported.');
    }
    const [{ result }, gitSnap] = await Promise.all([
      this.sf.json(['project', 'retrieve', 'preview', '--target-org', target], { cwd: root, signal, timeoutMs: 300_000 }),
      this.git.snapshot(root)
    ]);
    const preview = parseRetrievePreview(result);
    const dirty = gitSnap.files.map(f => norm(f.path));
    const overlap = preview.toRetrieve.flatMap(c => (c.path && dirty.includes(norm(c.path)) ? [norm(c.path)] : []));
    const blockers: string[] = [];
    if (!gitSnap.isRepo) {
      blockers.push('The project is not in a Git repository, so overwritten files could not be recovered.');
    }
    if (preview.conflicts.length) {
      blockers.push(`${preview.conflicts.length} conflict(s) between the org and local source must be resolved first.`);
    }
    if (overlap.length) {
      blockers.push(`${overlap.length} file(s) have uncommitted local changes that retrieval would overwrite. Commit or stash them first.`);
    }
    const outcome: PreviewOutcome = {
      orgId: org.orgId, orgLabel: `${target} (${org.orgId})`, at: new Date().toISOString(), preview,
      dirtyFiles: dirty, overlap, blockers
    };
    this.last = { ...outcome, gitFingerprint: gitSnap.fingerprint };
    return outcome;
  }

  async apply(root: string, org: OrgInfo, opts: { confirmedDirty: boolean }, signal?: AbortSignal): Promise<ApplyOutcome> {
    const last = this.last;
    if (!last || last.orgId !== org.orgId) {
      return { ok: false, code: 'PREVIEW_REQUIRED', message: 'Run a retrieval preview for this org first.' };
    }
    const before: GitSnapshot = await this.git.snapshot(root);
    if (before.fingerprint !== last.gitFingerprint) {
      return { ok: false, code: 'PREVIEW_STALE', message: 'Local source changed since the preview. Run the preview again.' };
    }
    if (last.blockers.length) {
      return { ok: false, code: 'BLOCKED', message: last.blockers.join(' ') };
    }
    if (last.preview.toRetrieve.length === 0) {
      return { ok: false, code: 'NOTHING_TO_RETRIEVE', message: 'The org has no changes to retrieve.' };
    }
    if (before.files.length > 0 && !opts.confirmedDirty) {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', needsConfirmation: true,
        message: `${before.files.length} uncommitted local file(s) exist (none overlap with the retrieval).` };
    }
    const target = assertAlias(org.alias ?? org.username);
    await this.sf.json(['project', 'retrieve', 'start', '--target-org', target], { cwd: root, signal, timeoutMs: 30 * 60_000 });
    const after = await this.git.snapshot(root);
    const prev = new Map(before.files.map(f => [f.path, f.status]));
    const changed = after.files.filter(f => prev.get(f.path) !== f.status).map(f => f.path);
    this.last = undefined;
    return { ok: true, retrieved: last.preview.toRetrieve.length, changedFiles: changed, orgLabel: last.orgLabel, at: new Date().toISOString() };
  }
}
