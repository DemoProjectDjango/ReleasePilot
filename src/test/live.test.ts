import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { GitAdapter } from '../adapters/git';
import { NodeProcessRunner } from '../adapters/processRunner';
import { SfCli, resolveSfLauncher } from '../adapters/sfCli';
import { DiscoveryService } from '../discovery/discoveryService';
import { evaluatePreflight } from '../executors/executors';

/**
 * LIVE tests: read-only queries (org list, package list, package version list) against the orgs
 * already authenticated in the local Salesforce CLI. Nothing is created, changed or deleted.
 * Enabled only with RP_LIVE=1 so the default suite stays hermetic.
 */
const live = process.env.RP_LIVE === '1' && !!resolveSfLauncher();

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A lingering sf child process can briefly hold the directory on Windows; temp dirs are harmless.
  }
}

function fixture(sfdxProject: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-live-'));
  fs.mkdirSync(path.join(dir, 'force-app'));
  fs.writeFileSync(path.join(dir, 'sfdx-project.json'), JSON.stringify(sfdxProject));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  g('add', '.'); g('commit', '-qm', 'i');
  return dir;
}

describe.skipIf(!live)('LIVE read-only discovery', () => {
  const runner = new NodeProcessRunner();
  const history = new CommandHistory();
  const svc = new DiscoveryService(new SfCli(runner, history, resolveSfLauncher()), new GitAdapter(runner, history));

  it('discovers orgs and Dev Hub packages, never exposing tokens', async () => {
    const dir = fixture({ packageDirectories: [{ path: 'force-app', default: true }] });
    const snap = await svc.discover(dir);
    console.log('LIVE errors: ' + JSON.stringify(snap.errors));
    console.log(`LIVE: orgs=${snap.orgs.length} devHubs=${snap.orgs.filter(o => o.isDevHub).length} defaultHub=${snap.devHub ? 'yes' : 'no'} packages=${snap.packages.length} errors=${snap.errors.map(e => e.code).join(',') || 'none'} sf=${snap.tooling?.sf} codeAnalyzer=${snap.tooling?.codeAnalyzer?.version}`);
    expect(snap.orgs.length).toBeGreaterThan(0);
    expect(JSON.stringify(snap)).not.toMatch(/accessToken/i);
    expect(snap.commands.every(c => !/--json.*token/i.test(c.display))).toBe(true);
    cleanup(dir);
  }, 240_000);

  it('preflight passes for a project whose package is owned by the Dev Hub, and fails for an unknown one', async () => {
    const probeDir = fixture({ packageDirectories: [{ path: 'force-app', default: true }] });
    const first = await svc.discover(probeDir);
    let hubAlias: string | undefined;
    let probe = first;
    for (const hub of first.orgs.filter(o => o.isDevHub)) {
      const alias = hub.alias ?? hub.username;
      probe = await svc.selectDevHub(alias);
      console.log('LIVE hub candidate: packages=' + probe.packages.length + ' errors=' + probe.errors.map(e => e.scope + ':' + e.code).join(',') );
      if (probe.packages.length) { hubAlias = alias; break; }
    }
    expect(hubAlias, 'at least one authenticated Dev Hub must own a package').toBeDefined();
    const pkg = probe.packages[0];

    const good = fixture({
      namespace: pkg.namespacePrefix,
      packageDirectories: [{ path: 'force-app', default: true, package: 'LivePkg', versionNumber: '1.0.0.NEXT' }],
      packageAliases: { LivePkg: pkg.id }
    });
    fs.writeFileSync(path.join(good, '.releasepilot.json'), JSON.stringify({ schemaVersion: '1.0', devHubAlias: hubAlias }));
    const goodSnap = await svc.discover(good);
    const goodChecks = evaluatePreflight(goodSnap);
    console.log('LIVE preflight (owned package): ' + goodChecks.map(c => `${c.status}:${c.name}`).join(' | '));
    expect(goodSnap.selectedPackage?.id).toBe(pkg.id);
    expect(goodChecks.filter(c => c.status === 'fail').map(c => c.name)).toEqual([]);

    const bad = fixture({
      packageDirectories: [{ path: 'force-app', default: true, package: 'Ghost', versionNumber: '1.0.0.NEXT' }],
      packageAliases: { Ghost: '0Ho000000000000AAA' }
    });
    fs.writeFileSync(path.join(bad, '.releasepilot.json'), JSON.stringify({ schemaVersion: '1.0', devHubAlias: hubAlias }));
    const badChecks = evaluatePreflight(await svc.discover(bad));
    console.log('LIVE preflight (unknown package): ' + badChecks.filter(c => c.status === 'fail').map(c => c.name).join(', '));
    expect(badChecks.some(c => c.name === 'Package ownership' && c.status === 'fail')).toBe(true);
    [probeDir, good, bad].forEach(d => cleanup(d));
  }, 480_000);
});
