import { SfCli, SfError, assertAlias, assertSalesforceId } from '../adapters/sfCli';

/** The only promote command ReleasePilot can build: exactly one 04t on one Dev Hub, no prompt (approval was already collected). */
export function buildPromoteArgs(versionId: string, devHub: string): string[] {
  return ['package', 'version', 'promote', '--package', assertSalesforceId(versionId, '04t'), '--target-dev-hub', assertAlias(devHub, 'Dev Hub'), '--no-prompt'];
}

export interface PromoteOutcome {
  /** What the CLI claimed. Never trusted on its own: Salesforce is re-queried afterwards. */
  cliSuccess: boolean;
  message?: string;
}

/**
 * Runs the promotion. A CLI error is returned rather than thrown so the caller can re-query Salesforce, because a
 * timeout or dropped connection after the request was sent does not prove the promotion did not happen.
 */
export async function promoteVersion(sf: SfCli, versionId: string, devHub: string, ctx: { root: string; signal?: AbortSignal }): Promise<PromoteOutcome> {
  try {
    const { result } = await sf.json<Record<string, unknown>>(buildPromoteArgs(versionId, devHub), { cwd: ctx.root, signal: ctx.signal, timeoutMs: 10 * 60_000 });
    const success = !(result && typeof result === 'object' && (result as Record<string, unknown>).success === false);
    return { cliSuccess: success, message: success ? undefined : 'The CLI reported success=false.' };
  } catch (e) {
    if (e instanceof SfError) {
      return { cliSuccess: false, message: `${e.code}: ${e.message}` };
    }
    throw e;
  }
}

/** Official install URLs for a released version (production and sandbox). */
export function installLinks(versionId: string): { production: string; sandbox: string } {
  assertSalesforceId(versionId, '04t');
  return {
    production: `https://login.salesforce.com/packaging/installPackage.apexp?p0=${versionId}`,
    sandbox: `https://test.salesforce.com/packaging/installPackage.apexp?p0=${versionId}`
  };
}

/** Guidance for what happens after promotion (Partner Console and AppExchange are outside ReleasePilot). */
export function nextSteps(versionId: string, hasKey: boolean): string[] {
  const links = installLinks(versionId);
  return [
    `Install link (production): ${links.production}`,
    `Install link (sandbox): ${links.sandbox}`,
    hasKey ? 'Share the installation key only through a secure channel.' : 'This version has no installation key; consider protecting released versions with a hard-to-guess key.',
    'In Partner Console, associate this package version with your AppExchange listing/offering and complete any required security review. ReleasePilot does not perform these steps.',
    'Begin the next development cycle on a higher version number: a released major.minor.patch cannot be reused.'
  ];
}
