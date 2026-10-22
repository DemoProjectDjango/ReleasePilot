import * as fs from 'fs';
import * as path from 'path';

export interface PackageDependency {
  package: string;
  versionNumber?: string;
  subscriberPackageVersionId?: string;
}

export interface PackageDirectory {
  path: string;
  exists: boolean;
  isDefault: boolean;
  package?: string;
  /** Resolved 0Ho id when the alias is present in packageAliases. */
  packageId?: string;
  versionName?: string;
  versionNumber?: string;
  versionDescription?: string;
  ancestorId?: string;
  ancestorVersion?: string;
  dependencies: PackageDependency[];
}

export interface ProjectInfo {
  root: string;
  file: string;
  /** "name" from sfdx-project.json, if any. */
  name?: string;
  sourceApiVersion?: string;
  namespace?: string;
  packageDirectories: PackageDirectory[];
  packageAliases: Record<string, string>;
  /** Non-fatal observations (shown to the user, never silently dropped). */
  warnings: string[];
}

export class ProjectError extends Error {
  constructor(readonly code: 'NO_SFDX_PROJECT' | 'INVALID_SFDX_PROJECT', message: string) {
    super(message);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function parseProject(root: string, text: string, dirExists: (p: string) => boolean): ProjectInfo {
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be an object');
    }
    json = parsed as Record<string, unknown>;
  } catch (e) {
    throw new ProjectError('INVALID_SFDX_PROJECT', `sfdx-project.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const warnings: string[] = [];
  const aliasesRaw = json.packageAliases && typeof json.packageAliases === 'object' ? json.packageAliases as Record<string, unknown> : {};
  const packageAliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(aliasesRaw)) {
    if (typeof v === 'string') {
      packageAliases[k] = v;
    }
  }
  const dirsRaw = Array.isArray(json.packageDirectories) ? json.packageDirectories : [];
  if (dirsRaw.length === 0) {
    throw new ProjectError('INVALID_SFDX_PROJECT', 'sfdx-project.json has no packageDirectories.');
  }
  const packageDirectories: PackageDirectory[] = dirsRaw.map((raw: unknown) => {
    const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const dirPath = str(d.path) ?? '';
    const pkg = str(d.package);
    const resolved = pkg ? (pkg.startsWith('0Ho') ? pkg : packageAliases[pkg]) : undefined;
    const deps = Array.isArray(d.dependencies) ? d.dependencies : [];
    const out: PackageDirectory = {
      path: dirPath,
      exists: !!dirPath && dirExists(path.join(root, dirPath)),
      isDefault: d.default === true,
      package: pkg,
      packageId: resolved && resolved.startsWith('0Ho') ? resolved : undefined,
      versionName: str(d.versionName),
      versionNumber: str(d.versionNumber),
      versionDescription: str(d.versionDescription),
      ancestorId: str(d.ancestorId),
      ancestorVersion: str(d.ancestorVersion),
      dependencies: deps.map((x: unknown) => {
        const dep = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return { package: str(dep.package) ?? '(unnamed)', versionNumber: str(dep.versionNumber), subscriberPackageVersionId: str(dep.subscriberPackageVersionId) };
      })
    };
    if (!dirPath) {
      warnings.push('A packageDirectories entry has no path.');
    } else if (!out.exists) {
      warnings.push(`Package directory "${dirPath}" does not exist on disk.`);
    }
    if (pkg && !out.packageId) {
      warnings.push(`Package "${pkg}" in "${dirPath}" has no 0Ho ID in packageAliases.`);
    }
    if (pkg && out.versionNumber && !/^\d+\.\d+\.\d+\.(\d+|NEXT)$/.test(out.versionNumber)) {
      warnings.push(`Package "${pkg}" versionNumber "${out.versionNumber}" should look like 1.2.0.NEXT.`);
    }
    return out;
  });
  if (!packageDirectories.some(p => p.package)) {
    warnings.push('No package directory declares a "package": this project is not configured for 2GP packaging.');
  }
  return {
    root, file: path.join(root, 'sfdx-project.json'),
    name: str(json.name), sourceApiVersion: str(json.sourceApiVersion), namespace: str(json.namespace),
    packageDirectories, packageAliases, warnings
  };
}

export function readProject(root: string): ProjectInfo {
  const file = path.join(root, 'sfdx-project.json');
  if (!fs.existsSync(file)) {
    throw new ProjectError('NO_SFDX_PROJECT', `No sfdx-project.json found in "${root}". Open the root folder of a Salesforce DX project.`);
  }
  return parseProject(root, fs.readFileSync(file, 'utf8'), p => fs.existsSync(p) && fs.statSync(p).isDirectory());
}
