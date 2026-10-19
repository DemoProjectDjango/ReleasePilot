import { SfCli, SfError, assertAlias, assertSalesforceId } from '../adapters/sfCli';
import { CreateRequest, ExistingVersion, TERMINAL, VersionReport, parseCreateRequest, parseCreateRequestList, parseVersionList, parseVersionReport } from './parsers';

export interface BuildPlan {
  packageId: string;
  devHub: string;
  /** Exactly one of installationKey / bypassKey must be set. */
  installationKey?: string;
  bypassKey?: boolean;
  branch?: string;
  tag?: string;
}

const KEY_RE = /^[^\s\u0000-\u001f]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,100}$/;
const TAG_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Builds the `sf package version create` arguments. Deliberately has no way to add --skip-validation,
 * --skip-ancestor-check or --async-validation: release candidates are always fully validated with code coverage.
 * No --wait is used so the 08c request id is returned (and persisted) immediately and then polled.
 */
export function buildCreateArgs(plan: BuildPlan): string[] {
  assertSalesforceId(plan.packageId, '0Ho');
  const args = ['package', 'version', 'create', '--package', plan.packageId, '--target-dev-hub', assertAlias(plan.devHub, 'Dev Hub'), '--code-coverage'];
  if (!!plan.installationKey === !!plan.bypassKey) {
    throw new SfError('INVALID_ARGUMENT', 'Choose either an installation key or an explicit key bypass.');
  }
  if (plan.installationKey) {
    if (!KEY_RE.test(plan.installationKey)) {
      throw new SfError('INVALID_ARGUMENT', 'The installation key must be 1-100 characters without spaces or control characters.');
    }
    // "=" form so a key that begins with "-" cannot be read as a flag.
    args.push(`--installation-key=${plan.installationKey}`);
  } else {
    args.push('--installation-key-bypass');
  }
  if (plan.branch) {
    if (!BRANCH_RE.test(plan.branch)) {
      throw new SfError('INVALID_ARGUMENT', 'Invalid branch name.');
    }
    args.push('--branch', plan.branch);
  }
  if (plan.tag) {
    if (!TAG_RE.test(plan.tag)) {
      throw new SfError('INVALID_ARGUMENT', 'Invalid tag.');
    }
    args.push('--tag', plan.tag);
  }
  return args;
}

interface Ctx {
  root: string;
  signal?: AbortSignal;
}

/** Starts the build. If the CLI errors after the request was registered, the 08c is recovered from the error payload. */
export async function startBuild(sf: SfCli, plan: BuildPlan, ctx: Ctx): Promise<CreateRequest> {
  try {
    const { result } = await sf.json(buildCreateArgs(plan), { cwd: ctx.root, signal: ctx.signal, timeoutMs: 10 * 60_000 });
    const req = parseCreateRequest(result);
    if (!req) {
      throw new SfError('NO_REQUEST_ID', 'Salesforce CLI did not return a package version create request ID.',
        'Check the Dev Hub for a new request before retrying, to avoid a duplicate build.');
    }
    return req;
  } catch (e) {
    const recovered = e instanceof SfError ? parseCreateRequest(e.result) : undefined;
    if (recovered) {
      return recovered;
    }
    throw e;
  }
}

export async function fetchRequest(sf: SfCli, devHub: string, requestId: string, ctx: Ctx): Promise<CreateRequest> {
  assertSalesforceId(requestId, '08c');
  const { result } = await sf.json(['package', 'version', 'create', 'report', '--package-create-request-id', requestId, '--target-dev-hub', assertAlias(devHub, 'Dev Hub')],
    { cwd: ctx.root, signal: ctx.signal, timeoutMs: 180_000 });
  const req = parseCreateRequest(result);
  if (!req) {
    throw new SfError('BAD_REPORT', `Could not read the status of request ${requestId}.`);
  }
  return req;
}

export async function listRecentRequests(sf: SfCli, devHub: string, ctx: Ctx): Promise<CreateRequest[]> {
  const { result } = await sf.json(['package', 'version', 'create', 'list', '--target-dev-hub', assertAlias(devHub, 'Dev Hub'), '--created-last-days', '3'],
    { cwd: ctx.root, signal: ctx.signal, timeoutMs: 180_000 });
  return parseCreateRequestList(result);
}

export async function fetchVersionReport(sf: SfCli, devHub: string, versionId: string, ctx: Ctx): Promise<VersionReport> {
  assertSalesforceId(versionId, '04t');
  const { result } = await sf.json(['package', 'version', 'report', '--package', versionId, '--target-dev-hub', assertAlias(devHub, 'Dev Hub')],
    { cwd: ctx.root, signal: ctx.signal, timeoutMs: 180_000 });
  const report = parseVersionReport(result);
  if (!report) {
    throw new SfError('BAD_REPORT', `Could not read the report for ${versionId}.`);
  }
  return report;
}

export async function listAllVersions(sf: SfCli, devHub: string, packageId: string, ctx: Ctx): Promise<ExistingVersion[]> {
  assertSalesforceId(packageId, '0Ho');
  const { result } = await sf.json(['package', 'version', 'list', '--target-dev-hub', assertAlias(devHub, 'Dev Hub'), '--packages', packageId, '--concise'],
    { cwd: ctx.root, signal: ctx.signal, timeoutMs: 300_000 });
  return parseVersionList(result);
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onUpdate?: (req: CreateRequest) => void;
}

/** Polls a create request until it is terminal. A local timeout is reported as timedOut, never as failure. */
export async function pollRequest(sf: SfCli, devHub: string, requestId: string, ctx: Ctx, opts: PollOptions): Promise<{ request: CreateRequest; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const request = await fetchRequest(sf, devHub, requestId, ctx);
    opts.onUpdate?.(request);
    if (TERMINAL.includes(request.status)) {
      return { request, timedOut: false };
    }
    if (Date.now() + opts.intervalMs > deadline) {
      return { request, timedOut: true };
    }
    await opts.sleep(opts.intervalMs, opts.signal);
    if (opts.signal?.aborted) {
      throw new SfError('CANCELLED', 'Polling was cancelled locally. The build continues on Salesforce.');
    }
  }
}

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
