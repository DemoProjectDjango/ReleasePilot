import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { GitAdapter } from '../adapters/git';
import { NodeProcessRunner } from '../adapters/processRunner';
import { SfCli, resolveSfLauncher } from '../adapters/sfCli';
import { runCodeAnalyzer } from '../analysis/analyzer';
import { installedPackages, listScratchOrgs } from '../qa/ops';
import { parseOrgList } from '../discovery/parsers';
import { fetchRequest, fetchVersionReport, listAllVersions, listRecentRequests } from '../packaging/build';
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

/**
 * LOCAL tool test: runs the real Code Analyzer v5 plugin on a throwaway project. No org is contacted.
 */
// String.raw keeps the backslash-escaped quotes that make this valid (and injectable) Apex.
const APEX_BAD = String.raw`public class Bad {
  public void run(String name) {
    try {
      List<Account> a = Database.query('SELECT Id FROM Account WHERE Name = \'' + name + '\'');
    } catch (Exception e) {
    }
    System.debug('x');
  }
}
`;

describe.skipIf(!live)('LOCAL Code Analyzer (real plugin, no org)', () => {
  it('scans an Apex class and yields normalized findings', async () => {
    const dir = fixture({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' });
    const classes = path.join(dir, 'force-app', 'main', 'default', 'classes');
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(classes, 'Bad.cls'), APEX_BAD);
    fs.writeFileSync(path.join(classes, 'Bad.cls-meta.xml'), '<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>');
    const runner = new NodeProcessRunner();
    const sf = new SfCli(runner, new CommandHistory(), resolveSfLauncher());
    const out = path.join(dir, '.out');
    const report = await runCodeAnalyzer(sf, { root: dir, outputDir: out, selectors: ['Recommended'] });
    console.log(`LOCAL analyzer: ${report.counts.total} findings ${JSON.stringify(report.counts)} versions=${JSON.stringify(report.versions)} fixes=${report.findings.filter(f => f.fix).length} html=${!!report.htmlPath}`);
    const rawJson = JSON.parse(fs.readFileSync(report.jsonPath, 'utf8')) as { violations?: unknown[]; runDir?: string };
    console.log('LOCAL raw violations=' + rawJson.violations?.length + ' runDir=' + rawJson.runDir + ' cls=' + fs.existsSync(path.join(classes, 'Bad.cls')) + ' size=' + fs.statSync(path.join(classes, 'Bad.cls')).size);
    console.log('LOCAL sample: ' + report.findings.slice(0, 3).map(f => `${f.severityLabel}:${f.rule}@${f.file}:${f.line}`).join(' | '));
    expect(report.warnings).toEqual([]);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every(f => f.file === '(workspace)' || fs.existsSync(f.absFile))).toBe(true);
    expect(report.findings.some(f => f.file.endsWith('Bad.cls'))).toBe(true);
    expect(report.htmlPath && fs.existsSync(report.htmlPath)).toBeTruthy();
    cleanup(dir);
  }, 300_000);
});

describe.skipIf(!live)('LOCAL Code Analyzer incomplete-scan detection', () => {
  it('surfaces an engine parse failure as warnings instead of a silently clean scan', async () => {
    const dir = fixture({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' });
    const classes = path.join(dir, 'force-app', 'main', 'default', 'classes');
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(classes, 'Broken.cls'), 'public class Broken { public void run( { \n');
    const sf = new SfCli(new NodeProcessRunner(), new CommandHistory(), resolveSfLauncher());
    const report = await runCodeAnalyzer(sf, { root: dir, outputDir: path.join(dir, '.out'), selectors: ['Recommended'] });
    console.log('LOCAL broken-file: findings=' + report.counts.total + ' warnings=' + report.warnings.length + ' first=' + (report.warnings[0] ?? '').slice(0, 120));
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.join(' ')).toMatch(/pmd/i);
    cleanup(dir);
  }, 300_000);
});

/**
 * LIVE read-only packaging queries. Nothing is created: only list/report commands against an existing package.
 */
describe.skipIf(!live)('LIVE read-only packaging queries', () => {
  it('parses real version lists, build requests and version reports', async () => {
    const runner = new NodeProcessRunner();
    const history = new CommandHistory();
    const sf = new SfCli(runner, history, resolveSfLauncher());
    const svc = new DiscoveryService(sf, new GitAdapter(runner, history));
    const dir = fixture({ packageDirectories: [{ path: 'force-app', default: true }] });
    const first = await svc.discover(dir);
    let hubAlias: string | undefined;
    let pkgId: string | undefined;
    for (const hub of first.orgs.filter(o => o.isDevHub)) {
      const snap = await svc.selectDevHub(hub.alias ?? hub.username);
      if (snap.packages.length) { hubAlias = hub.alias ?? hub.username; pkgId = snap.packages[0].id; break; }
    }
    expect(hubAlias).toBeDefined();
    const c = { root: dir };
    const versions = await listAllVersions(sf, hubAlias!, pkgId!, c);
    const recent = await listRecentRequests(sf, hubAlias!, c);
    console.log(`LIVE packaging: versions=${versions.length} released=${versions.filter(v => v.isReleased).length} recentRequests=${recent.length}`);
    expect(versions.length).toBeGreaterThan(0);
    const v04t = versions.find(v => v.subscriberPackageVersionId)?.subscriberPackageVersionId;
    const report = await fetchVersionReport(sf, hubAlias!, v04t!, c);
    console.log(`LIVE report: version=${report.version} coverage=${report.codeCoverage} passed=${report.hasPassedCodeCoverageCheck} released=${report.isReleased} validationSkipped=${report.validationSkipped} ancestor=${report.ancestorId ? 'yes' : 'none'}`);
    expect(report.subscriberPackageVersionId).toBe(v04t);
    expect(report.packageId).toBe(pkgId);
    // An existing 08c request, found without a day limit.
    const all = await sf.json<unknown[]>(['package', 'version', 'create', 'list', '--target-dev-hub', hubAlias!], { cwd: dir, timeoutMs: 300_000 });
    const some = (all.result as Array<{ Id?: string; Package2Id?: string; Status?: string }>).find(r => r.Package2Id === pkgId && r.Id);
    expect(some).toBeDefined();
    const req = await fetchRequest(sf, hubAlias!, some!.Id!, c);
    console.log(`LIVE request: status=${req.status} has04t=${!!req.subscriberPackageVersionId} errors=${req.errors.length}`);
    expect(req.requestId).toBe(some!.Id);
    expect(req.status).toBe(some!.Status);
    // The command history must contain no create command: this test is read-only.
    expect(history.list().some(h => /package version create(?! (list|report))/.test(h.display))).toBe(false);
    cleanup(dir);
  }, 580_000);
});

/**
 * LIVE read-only QA parsing: existing scratch orgs and installed packages. Nothing is created, installed,
 * assigned, opened or deleted.
 */
describe.skipIf(!live)('LIVE read-only QA queries', () => {
  it('parses real scratch org lists and installed package lists without tokens', async () => {
    const runner = new NodeProcessRunner();
    const history = new CommandHistory();
    const sf = new SfCli(runner, history, resolveSfLauncher());
    const dir = fixture({ packageDirectories: [{ path: 'force-app', default: true }] });
    const scratch = await listScratchOrgs(sf, { root: dir });
    console.log(`LIVE qa: scratchOrgs=${scratch.length} withAlias=${scratch.filter(s => s.alias).length} withDevHub=${scratch.filter(s => s.devHubOrgId).length}`);
    expect(scratch.length).toBeGreaterThan(0);
    expect(scratch.every(s => /^00D/.test(s.orgId) && s.username.includes('@'))).toBe(true);
    expect(JSON.stringify(scratch)).not.toMatch(/accessToken/i);
    const { result } = await sf.json(['org', 'list', '--skip-connection-status'], { cwd: dir });
    const candidates = parseOrgList(result).filter(o => !o.isDevHub && !o.expired).slice(0, 5);
    let parsed = false;
    for (const o of candidates) {
      try {
        const pk = await installedPackages(sf, o.alias ?? o.username, { root: dir });
        if (pk.length) {
          console.log(`LIVE installed: ${pk.length} package(s), versionIds=${pk.every(p => /^04t/.test(p.versionId ?? ''))}, numbers=${pk.every(p => !!p.versionNumber)}`);
          expect(pk.every(p => /^04t/.test(p.versionId ?? ''))).toBe(true);
          parsed = true;
          break;
        }
      } catch {
        // an org with an expired session is skipped
      }
    }
    expect(parsed).toBe(true);
    const verbs = history.list().map(h => h.display);
    expect(verbs.some(v => /org create|package install(?!ed| report)|org delete|assign|org open/.test(v))).toBe(false);
    cleanup(dir);
  }, 580_000);
});
