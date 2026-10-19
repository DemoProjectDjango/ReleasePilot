import * as fs from 'fs';
import * as path from 'path';

/** Non-secret, project-specific selections stored in <project>/.releasepilot.json. */
export interface ProjectConfig {
  schemaVersion: '1.0';
  devHubAlias?: string;
  devOrgAlias?: string;
  packageAlias?: string;
}

export const CONFIG_FILE = '.releasepilot.json';
const SAFE = /^[A-Za-z0-9_.@+-]{1,128}$/;

function clean(v: unknown): string | undefined {
  return typeof v === 'string' && SAFE.test(v) ? v : undefined;
}

export function parseConfig(text: string): ProjectConfig {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return { schemaVersion: '1.0', devHubAlias: clean(j.devHubAlias), devOrgAlias: clean(j.devOrgAlias), packageAlias: clean(j.packageAlias) };
  } catch {
    return { schemaVersion: '1.0' };
  }
}

export function readConfig(root: string): ProjectConfig {
  const file = path.join(root, CONFIG_FILE);
  return fs.existsSync(file) ? parseConfig(fs.readFileSync(file, 'utf8')) : { schemaVersion: '1.0' };
}

export function writeConfig(root: string, config: ProjectConfig): void {
  const file = path.join(root, CONFIG_FILE);
  const clean1: ProjectConfig = { schemaVersion: '1.0', devHubAlias: clean(config.devHubAlias), devOrgAlias: clean(config.devOrgAlias), packageAlias: clean(config.packageAlias) };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean1, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
