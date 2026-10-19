import { SfCli, SfError, assertAlias, assertSalesforceId } from '../adapters/sfCli';
import { InstallResult, InstalledPackage, ScratchListEntry, ScratchOrgResult, parseInstallResult, parseInstalledList, parseQueryRecords, parseScratchCreate, parseScratchOrgs } from './parsers';

interface Ctx {
  root: string;
  signal?: AbortSignal;
}

const PERMSET_RE = /^[A-Za-z0-9_]{1,80}$/;
const USERNAME_RE = /^[A-Za-z0-9._%+@-]{3,128}$/;

export async function listScratchOrgs(sf: SfCli, c: Ctx): Promise<ScratchListEntry[]> {
  const { result } = await sf.json(['org', 'list', '--skip-connection-status'], { cwd: c.root, signal: c.signal });
  return parseScratchOrgs(result);
}

export interface CreateScratchOptions {
  hub: string;
  alias: string;
  definitionFile: string;
  durationDays: number;
  waitMinutes: number;
}

/**
 * Creates a clean scratch org. --no-namespace is mandatory for package QA: an org carrying the package's own
 * namespace cannot install that managed package. The org is never set as the default.
 */
export function buildCreateScratchArgs(o: CreateScratchOptions): string[] {
  const days = Math.min(Math.max(Math.floor(o.durationDays), 1), 30);
  const wait = Math.min(Math.max(Math.floor(o.waitMinutes), 1), 120);
  if (/[\0\r\n]/.test(o.definitionFile) || o.definitionFile.startsWith('-')) {
    throw new SfError('INVALID_ARGUMENT', 'Invalid scratch definition path.');
  }
  return ['org', 'create', 'scratch', '--definition-file', o.definitionFile, '--target-dev-hub', assertAlias(o.hub, 'Dev Hub'),
    '--alias', assertAlias(o.alias, 'scratch alias'), '--no-namespace', '--no-track-source', '--duration-days', String(days), '--wait', String(wait)];
}

export async function createScratch(sf: SfCli, o: CreateScratchOptions, c: Ctx): Promise<ScratchOrgResult> {
  const { result } = await sf.json(buildCreateScratchArgs(o), { cwd: c.root, signal: c.signal, timeoutMs: (o.waitMinutes + 5) * 60_000 });
  const parsed = parseScratchCreate(result);
  if (!parsed) {
    throw new SfError('NO_ORG_INFO', 'The scratch org was requested but the CLI returned no org ID or username.',
      'Check "sf org list" for the new alias before retrying so a duplicate is not created.');
  }
  return parsed;
}

export interface InstallOptions {
  org: string;
  versionId: string;
  key?: string;
  waitMinutes: number;
  securityType: 'AdminsOnly' | 'AllUsers';
}

export function buildInstallArgs(o: InstallOptions): string[] {
  const args = ['package', 'install', '--package', assertSalesforceId(o.versionId, '04t'), '--target-org', assertAlias(o.org, 'scratch org'),
    '--no-prompt', '--security-type', o.securityType === 'AllUsers' ? 'AllUsers' : 'AdminsOnly', '--apex-compile', 'package',
    '--wait', String(Math.min(Math.max(Math.floor(o.waitMinutes), 1), 240)), '--publish-wait', '10'];
  if (o.key) {
    if (!/^[^\s\u0000-\u001f]{1,100}$/.test(o.key)) {
      throw new SfError('INVALID_ARGUMENT', 'The installation key must be 1-100 characters without spaces.');
    }
    args.push(`--installation-key=${o.key}`);
  }
  return args;
}

/** Starts an install. If the wait elapses the CLI errors with the request in the payload; it is recovered so progress can be polled. */
export async function installPackage(sf: SfCli, o: InstallOptions, c: Ctx): Promise<InstallResult> {
  try {
    const { result } = await sf.json(buildInstallArgs(o), { cwd: c.root, signal: c.signal, timeoutMs: (o.waitMinutes + 15) * 60_000 });
    return parseInstallResult(result);
  } catch (e) {
    if (e instanceof SfError && e.result) {
      const recovered = parseInstallResult(e.result);
      if (recovered.requestId) {
        return recovered;
      }
    }
    throw e;
  }
}

export async function installReport(sf: SfCli, org: string, requestId: string, c: Ctx): Promise<InstallResult> {
  assertSalesforceId(requestId, '0Hf');
  const { result } = await sf.json(['package', 'install', 'report', '--request-id', requestId, '--target-org', assertAlias(org, 'scratch org')], { cwd: c.root, signal: c.signal });
  return parseInstallResult(result);
}

export async function pollInstall(sf: SfCli, org: string, requestId: string, c: Ctx, o: { intervalMs: number; timeoutMs: number; sleep: (ms: number, s?: AbortSignal) => Promise<void> }): Promise<{ result: InstallResult; timedOut: boolean }> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const result = await installReport(sf, org, requestId, c);
    if (result.status !== 'IN_PROGRESS' && result.status !== 'UNKNOWN') {
      return { result, timedOut: false };
    }
    if (Date.now() + o.intervalMs > deadline) {
      return { result, timedOut: true };
    }
    await o.sleep(o.intervalMs, c.signal);
    if (c.signal?.aborted) {
      throw new SfError('CANCELLED', 'Polling was cancelled locally; the installation may still be running in the org.');
    }
  }
}

export async function installedPackages(sf: SfCli, org: string, c: Ctx): Promise<InstalledPackage[]> {
  const { result } = await sf.json(['package', 'installed', 'list', '--target-org', assertAlias(org, 'scratch org')], { cwd: c.root, signal: c.signal });
  return parseInstalledList(result);
}

export async function assignPermsets(sf: SfCli, org: string, names: string[], c: Ctx): Promise<void> {
  if (!names.length) {
    return;
  }
  const args = ['org', 'assign', 'permset', '--target-org', assertAlias(org, 'scratch org')];
  for (const n of names) {
    if (!PERMSET_RE.test(n)) {
      throw new SfError('INVALID_ARGUMENT', `Invalid permission set name "${n}".`);
    }
    args.push('--name', n);
  }
  await sf.json(args, { cwd: c.root, signal: c.signal });
}

/** Names of permission sets assigned to the org's admin user (namespace prefixes are not part of PermissionSet.Name). */
export async function assignedPermsets(sf: SfCli, org: string, username: string, c: Ctx): Promise<string[]> {
  if (!USERNAME_RE.test(username)) {
    throw new SfError('INVALID_ARGUMENT', 'Unexpected username format.');
  }
  const { result } = await sf.json(['data', 'query', '--target-org', assertAlias(org, 'scratch org'), '--query',
    `SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE Assignee.Username = '${username}'`], { cwd: c.root, signal: c.signal });
  return parseQueryRecords(result).map(r => String((r.PermissionSet as Record<string, unknown> | undefined)?.Name ?? '')).filter(Boolean);
}

/** Runs a project-supplied anonymous Apex file in the QA org; a thrown exception or compile error fails. */
export async function runApexFile(sf: SfCli, org: string, file: string, c: Ctx): Promise<void> {
  if (/[\0\r\n]/.test(file) || file.startsWith('-')) {
    throw new SfError('INVALID_ARGUMENT', 'Invalid script path.');
  }
  const { result } = await sf.json<Record<string, unknown>>(['apex', 'run', '--file', file, '--target-org', assertAlias(org, 'scratch org')], { cwd: c.root, signal: c.signal, timeoutMs: 15 * 60_000 });
  if (result && (result.success === false || result.compiled === false)) {
    const msg = String(result.exceptionMessage || result.compileProblem || 'The script did not complete successfully.');
    throw new SfError('SCRIPT_FAILED', `${file}: ${msg}`);
  }
}

/** Opens the org in the browser through the CLI. Output is not logged: it may contain a session URL. */
export async function openOrg(sf: SfCli, org: string, c: Ctx): Promise<void> {
  await sf.text(['org', 'open', '--target-org', assertAlias(org, 'scratch org')], { cwd: c.root, signal: c.signal, timeoutMs: 60_000 });
}

export async function deleteScratch(sf: SfCli, org: string, c: Ctx): Promise<void> {
  await sf.json(['org', 'delete', 'scratch', '--target-org', assertAlias(org, 'scratch org'), '--no-prompt'], { cwd: c.root, signal: c.signal, timeoutMs: 5 * 60_000 });
}
