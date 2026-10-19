import * as fs from 'fs';
import * as path from 'path';
import { ProcessRunner } from '../adapters/processRunner';

export interface LwcRun {
  at: string;
  configured: boolean;
  /** Why Jest was not run (NOT_CONFIGURED is not a failure; FR-12). */
  reason?: string;
  installMissing?: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ file: string; test: string; message: string }>;
  rawPath?: string;
}

export interface LwcDetection {
  configured: boolean;
  reason?: string;
  bin?: string;
  /** True when Jest is declared but dependencies are missing: needs attention rather than silent skip. */
  installMissing?: boolean;
}

/** Jest is "configured" when the project declares @salesforce/sfdx-lwc-jest and has a jest config. */
export function detectLwcJest(root: string): LwcDetection {
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    return { configured: false, reason: 'No package.json: LWC Jest is not configured.' };
  }
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as typeof pkg;
  } catch {
    return { configured: false, reason: 'package.json is not valid JSON.' };
  }
  const declared = !!(pkg.devDependencies?.['@salesforce/sfdx-lwc-jest'] ?? pkg.dependencies?.['@salesforce/sfdx-lwc-jest']);
  const hasConfig = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json'].some(f => fs.existsSync(path.join(root, f)));
  if (!declared || !hasConfig) {
    return { configured: false, reason: 'LWC Jest is not configured (needs @salesforce/sfdx-lwc-jest and a jest config).' };
  }
  const bin = path.join(root, 'node_modules', '@salesforce', 'sfdx-lwc-jest', 'bin', 'sfdx-lwc-jest');
  if (!fs.existsSync(bin)) {
    return { configured: true, installMissing: true, reason: 'LWC Jest is configured but dependencies are not installed. Run "npm install" in the project.' };
  }
  return { configured: true, bin };
}

export function parseJestJson(text: string): Pick<LwcRun, 'total' | 'passed' | 'failed' | 'failures'> {
  const j = JSON.parse(text) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const failures: LwcRun['failures'] = [];
  for (const suite of Array.isArray(j.testResults) ? j.testResults as Array<Record<string, unknown>> : []) {
    const file = typeof suite.name === 'string' ? suite.name : '(unknown)';
    for (const a of Array.isArray(suite.assertionResults) ? suite.assertionResults as Array<Record<string, unknown>> : []) {
      if (a.status === 'failed') {
        const msgs = Array.isArray(a.failureMessages) ? a.failureMessages.filter((m): m is string => typeof m === 'string') : [];
        failures.push({ file, test: String(a.fullName ?? a.title ?? ''), message: msgs.join('\n').slice(0, 4000) });
      }
    }
    if (suite.status === 'failed' && !failures.some(f => f.file === file) && typeof suite.message === 'string' && suite.message) {
      failures.push({ file, test: '(suite failed to run)', message: suite.message.slice(0, 4000) });
    }
  }
  return { total: num(j.numTotalTests), passed: num(j.numPassedTests), failed: num(j.numFailedTests) + (failures.some(f => f.test === '(suite failed to run)') ? 1 : 0), failures };
}

/** Runs the project's own Jest through node (no shell). Requires a trusted workspace: it executes project dependencies. */
export async function runLwcJest(runner: ProcessRunner, root: string, outputDir: string, signal?: AbortSignal): Promise<LwcRun> {
  const at = new Date().toISOString();
  const det = detectLwcJest(root);
  if (!det.configured || !det.bin) {
    return { at, configured: det.configured, installMissing: det.installMissing, reason: det.reason, total: 0, passed: 0, failed: 0, failures: [] };
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const rawPath = path.join(outputDir, `lwc-jest-${at.replace(/[:.]/g, '-')}.json`);
  const res = await runner.run({
    command: process.execPath, args: [det.bin, '--json', `--outputFile=${rawPath}`, '--ci'],
    cwd: root, timeoutMs: 15 * 60_000, signal, env: { ELECTRON_RUN_AS_NODE: '1' }
  });
  if (res.aborted) {
    throw new Error('LWC Jest was cancelled.');
  }
  if (!fs.existsSync(rawPath)) {
    return { at, configured: true, reason: `Jest produced no results (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400)}`, total: 0, passed: 0, failed: 1, failures: [{ file: '(jest)', test: '(runner)', message: 'Jest did not produce a results file.' }] };
  }
  return { at, configured: true, rawPath, ...parseJestJson(fs.readFileSync(rawPath, 'utf8')) };
}
