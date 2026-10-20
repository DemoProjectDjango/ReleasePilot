import { ExistingVersion } from '../packaging/parsers';

export interface UpgradePath {
  /** 'not-applicable' = new product (nothing released yet); 'unsupported' = blocked with an explanation. */
  state: 'supported' | 'not-applicable' | 'unsupported';
  baseline?: ExistingVersion;
  reason: string;
  /** What the user can do instead when the path is blocked. */
  alternative?: string;
}

/**
 * Decides whether "previous released version -> candidate" is a path Salesforce supports, using the facts from
 * the official 2GP upgrade rules: a subscriber can be upgraded TO a beta (in a scratch org or sandbox) but never
 * FROM a beta, betas cannot be ancestors, and the new version must be a direct descendant of the installed one.
 */
export function evaluateUpgradePath(versions: ExistingVersion[], targetVersionId: string): UpgradePath {
  const target = versions.find(v => v.subscriberPackageVersionId === targetVersionId);
  if (!target) {
    return { state: 'unsupported', reason: `The candidate ${targetVersionId} was not found among the package's versions in the Dev Hub.`, alternative: 'Run Package Readiness again and rebuild if needed.' };
  }
  if (!versions.some(v => v.isReleased)) {
    return { state: 'not-applicable', reason: 'No version of this package has been released yet, so there is nothing to upgrade from (new product).' };
  }
  if (target.isReleased) {
    return { state: 'unsupported', reason: 'The candidate is already released; an upgrade test is meant for an unreleased candidate.', alternative: 'Test the next candidate instead.' };
  }
  if (!target.ancestorId) {
    return {
      state: 'unsupported', reason: 'The candidate has no ancestor, so Salesforce defines no upgrade path from earlier released versions.',
      alternative: 'Set ancestorId (e.g. HIGHEST) in sfdx-project.json and build a new candidate.'
    };
  }
  const ancestor = versions.find(v => v.packageVersionId === target.ancestorId || v.subscriberPackageVersionId === target.ancestorId);
  if (!ancestor) {
    return { state: 'unsupported', reason: 'The candidate\'s ancestor could not be resolved in the Dev Hub.', alternative: 'Check the ancestor in sfdx-project.json and rebuild.' };
  }
  if (!ancestor.isReleased) {
    return {
      state: 'unsupported', reason: `The candidate's ancestor ${ancestor.version} is a beta. Salesforce does not allow upgrading from a beta version.`,
      alternative: 'Use a released version as the ancestor (ancestorId: HIGHEST), or test the fresh-install path only.'
    };
  }
  if (!ancestor.subscriberPackageVersionId) {
    return { state: 'unsupported', reason: 'The ancestor has no installable 04t id.' };
  }
  return { state: 'supported', baseline: ancestor, reason: `Upgrade ${ancestor.version} (released) -> ${target.version} (beta) in a scratch org.` };
}

/** Hard guard used before any install: a beta may never be the baseline of an upgrade test. */
export function assertBaselineReleased(v: ExistingVersion): void {
  if (!v.isReleased) {
    throw new Error(`Refusing to use beta version ${v.version} as an upgrade baseline: installed betas cannot be upgraded.`);
  }
}
