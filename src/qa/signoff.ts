import { QaEnvironment, PhaseName, checklistStatus } from './store';

/** Phases that must be done before a person may sign off. Opening the org is convenience and not required. */
export function requiredPhases(kind: QaEnvironment['kind']): PhaseName[] {
  return kind === 'upgrade'
    ? ['create', 'dependencies', 'baseline', 'seed', 'install', 'verify', 'permsets', 'scripts', 'smoke']
    : ['create', 'dependencies', 'install', 'verify', 'permsets', 'scripts', 'smoke'];
}

/**
 * Reasons a QA sign-off must be refused. Empty means the environment is eligible. A sign-off asserts that a
 * person verified the exact candidate in this org, so every automated phase, every checklist item and the
 * unchanged source must hold.
 */
export function signOffBlockers(env: QaEnvironment, currentSourceFingerprint: string | undefined): string[] {
  const reasons: string[] = [];
  if (env.status !== 'ready') {
    reasons.push(`The environment is ${env.status}.`);
  }
  if (env.signoff) {
    reasons.push('It has already been signed off.');
  }
  const missing = requiredPhases(env.kind).filter(p => env.phases[p]?.status !== 'done');
  if (missing.length) {
    reasons.push(`Automation is incomplete (${missing.join(', ')}).`);
  }
  if (env.smoke.some(c => c.status === 'fail')) {
    reasons.push('An automated check failed.');
  }
  if (!env.verifiedInstalledVersion) {
    reasons.push('The installed version has not been verified.');
  }
  const list = checklistStatus(env.checklist);
  if (list !== 'pass') {
    reasons.push(list === 'fail' ? 'A checklist item is marked Fail.' : 'Every checklist item must be explicitly marked Pass.');
  }
  if (!currentSourceFingerprint || currentSourceFingerprint !== env.sourceFingerprint) {
    reasons.push('The source changed after this environment was tested, so a sign-off would not describe the current code.');
  }
  return reasons;
}
