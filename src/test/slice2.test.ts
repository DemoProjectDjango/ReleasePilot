import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../adapters/commandHistory';
import { GitAdapter, parsePorcelainZ } from '../adapters/git';
import { NodeProcessRunner, ProcessRunner, RunRequest, RunResult } from '../adapters/processRunner';
import { SfCli, SfError, assertAlias, explainError, extractJson, resolveSfLauncher } from '../adapters/sfCli';
import { DiscoverySnapshot } from '../discovery/discoveryService';
import { OrgInfo, parseOrgList, parsePackageList, parsePluginsText, parseRetrievePreview } from '../discovery/parsers';
import { parseProject } from '../discovery/project';
import { parseConfig, readConfig, writeConfig } from '../discovery/projectConfig';
import { RetrievalService } from '../discovery/retrieval';
import { evaluatePreflight } from '../executors/executors';
import { parseMessage } from '../ui/messages';

const ok = (stdout = '', exitCode: number | null = 0, stderr = ''): RunResult =>
  ({ exitCode, stdout, stderr, durationMs: 1, timedOut: false, aborted: false, truncated: false });

class FakeRunner implements ProcessRunner {
  calls: RunRequest[] = [];
  constructor(private handler: (req: RunRequest) => RunResult) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    return this.handler(req);
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp2-'));

// ---------------------------------------------------------------- process runner (local integration)
describe('NodeProcessRunner (local integration)', () => {
  const runner = new NodeProcessRunner();
  const node = process.execPath;

  it('captures output and streams lines', async () => {
    const lines: string[] = [];
    const res = await runner.run({ command: node, args: ['-e', 'console.log("a");console.log("b")'], cwd: os.tmpdir(), onLine: (_s, l) => lines.push(l) });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().split(/\r?\n/)).toEqual(['a', 'b']);
    expect(lines).toEqual(['a', 'b']);
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    const evil = 'x & echo INJECTED | calc ; $(whoami) `id`';
    const res = await runner.run({ command: node, args: ['-e', 'console.log(process.argv[1])', evil], cwd: os.tmpdir() });
    expect(res.stdout.trim()).toBe(evil);
    expect(res.stdout).not.toMatch(/^INJECTED/m);
  });

  it('times out and aborts', async () => {
    const t = await runner.run({ command: node, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: os.tmpdir(), timeoutMs: 200 });
    expect(t.timedOut).toBe(true);
    const ac = new AbortController();
    const p = runner.run({ command: node, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: os.tmpdir(), signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await p).aborted).toBe(true);
  });

  it('reports spawn failures and rejects unsafe arguments', async () => {
    const res = await runner.run({ command: 'definitely-not-a-real-binary-xyz', args: [], cwd: os.tmpdir() });
    expect(res.spawnError).toBeTruthy();
    await expect(Promise.resolve().then(() => runner.run({ command: node, args: ['a\nb'], cwd: os.tmpdir() }))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- launcher resolution
describe('resolveSfLauncher', () => {
  it('uses node + run.js for npm shims on Windows', () => {
    const dir = path.join('C:', 'npm');
    const files = new Set([path.join(dir, 'sf.cmd'), path.join(dir, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js'), path.join('C:', 'node', 'node.exe')]);
    const l = resolveSfLauncher({ PATH: [dir, path.join('C:', 'node')].join(path.delimiter) }, 'win32', p => files.has(p));
    expect(l?.command).toBe(path.join('C:', 'node', 'node.exe'));
    expect(l?.prefixArgs.at(-1)).toContain('run.js');
  });
  it('returns undefined when sf is absent', () => {
    expect(resolveSfLauncher({ PATH: 'C:\\x' }, 'win32', () => false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- parsers & secrets
describe('parsers', () => {
  const raw = {
    nonScratchOrgs: [{ username: 'a@x.com', orgId: '00D000000000001', alias: 'dev', accessToken: 'SECRET-TOKEN-1', isDevHub: false, tracksSource: true }],
    devHubs: [{ username: 'hub@x.com', orgId: '00D000000000002', alias: 'hub', accessToken: 'SECRET-TOKEN-2', isDevHub: true, isDefaultDevHubUsername: true }],
    other: [{ username: 'a@x.com', orgId: '00D000000000001', accessToken: 'SECRET-TOKEN-1' }]
  };
  it('never carries access tokens and de-duplicates orgs', () => {
    const orgs = parseOrgList(raw);
    expect(orgs).toHaveLength(2);
    expect(JSON.stringify(orgs)).not.toContain('SECRET-TOKEN');
    expect(orgs.find(o => o.alias === 'hub')?.isDevHub).toBe(true);
    expect(orgs.find(o => o.alias === 'dev')?.alias).toBe('dev');
  });
  it('parses real `sf plugins` text and ignores uninstalled JIT plugins', () => {
    const text = '@salesforce/sfdx-scanner 4.12.0\ncode-analyzer 5.15.0\n\nUninstalled JIT Plugins:\nflow 2.0.0\n';
    const plugins = parsePluginsText(text);
    expect(plugins.map(p => p.name)).toEqual(['@salesforce/sfdx-scanner', 'code-analyzer']);
    expect(plugins[1].version).toBe('5.15.0');
  });
  it('parses packages and retrieve previews defensively', () => {
    expect(parsePackageList([{ Id: '0Ho000000000001AAA', Name: 'P', NamespacePrefix: 'ns' }, { bogus: 1 }])).toHaveLength(1);
    expect(parsePackageList('nope')).toEqual([]);
    const p = parseRetrievePreview({ toRetrieve: [{ type: 'ApexClass', fullName: 'A', projectRelativePath: 'force-app/A.cls' }], conflicts: [{ fullName: 'B' }] });
    expect(p.toRetrieve[0].path).toBe('force-app/A.cls');
    expect(p.conflicts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- sf cli adapter (mocked runner)
describe('SfCli (mocked runner)', () => {
  const launcher = { command: 'node', prefixArgs: ['run.js'] };
  const make = (h: (r: RunRequest) => RunResult) => {
    const runner = new FakeRunner(h);
    const history = new CommandHistory();
    return { sf: new SfCli(runner, history, launcher), runner, history };
  };

  it('parses JSON results and appends --json', async () => {
    const { sf, runner } = make(() => ok(JSON.stringify({ status: 0, result: { x: 1 } })));
    const r = await sf.json<{ x: number }>(['org', 'list'], { cwd: '.' });
    expect(r.result.x).toBe(1);
    expect(runner.calls[0].args).toEqual(['run.js', 'org', 'list', '--json']);
  });

  it('turns CLI errors into actionable SfError', async () => {
    const { sf } = make(() => ok(JSON.stringify({ status: 1, name: 'NamedOrgNotFoundError', message: 'No authorization information found for x' }), 1));
    await expect(sf.json(['x'], { cwd: '.' })).rejects.toMatchObject({ code: 'ORG_NOT_FOUND' });
  });

  it('reports a missing CLI clearly', async () => {
    const sf = new SfCli(new FakeRunner(() => ok()), new CommandHistory(), undefined);
    await expect(sf.json(['x'], { cwd: '.' })).rejects.toMatchObject({ code: 'SF_NOT_FOUND' });
  });

  it('records redacted command history without the node bootstrap', async () => {
    const { sf, history } = make(() => ok(JSON.stringify({ status: 0, result: {} })));
    await sf.json(['package', 'install', '--installation-key', 'hunter2'], { cwd: '.' });
    const rec = history.list()[0];
    expect(rec.display.startsWith('sf package install')).toBe(true);
    expect(rec.display).not.toContain('hunter2');
  });

  it('maps timeouts to TIMEOUT', async () => {
    const { sf } = make(() => ({ ...ok('', null), timedOut: true }));
    await expect(sf.json(['x'], { cwd: '.' })).rejects.toBeInstanceOf(SfError);
  });

  it('validates aliases and error text', () => {
    expect(() => assertAlias('--target-org')).toThrow();
    expect(() => assertAlias('a b')).toThrow();
    expect(assertAlias('me@x.com')).toBe('me@x.com');
    expect(explainError(undefined, 'invalid_grant: expired access/refresh token').code).toBe('AUTH_EXPIRED');
    expect(extractJson('noise {"status":0} trailing')?.status).toBe(0);
    const noisy = "Error Plugin: x {\n name: 'y',\n type: dev\n}\nWarning {again}\n" + JSON.stringify({ status: 0, result: [1] });
    expect(extractJson(noisy)?.result).toEqual([1]);
    expect(extractJson('{ not json } and { also }')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- project parsing & config
describe('project discovery', () => {
  const json = JSON.stringify({
    namespace: 'ns', sourceApiVersion: '62.0',
    packageDirectories: [{ path: 'force-app', default: true, package: 'MyPkg', versionNumber: '1.2.0.NEXT', ancestorId: 'HIGHEST', dependencies: [{ package: 'Dep', versionNumber: '1.0.0.LATEST' }] }],
    packageAliases: { MyPkg: '0Ho000000000001AAA' }
  });
  it('reads packages, aliases and dependencies', () => {
    const p = parseProject('/proj', json, () => true);
    expect(p.packageDirectories[0].packageId).toBe('0Ho000000000001AAA');
    expect(p.packageDirectories[0].dependencies).toHaveLength(1);
    expect(p.warnings).toEqual([]);
  });
  it('warns on missing directories, unresolved aliases and bad versions', () => {
    const p = parseProject('/proj', JSON.stringify({ packageDirectories: [{ path: 'nope', package: 'X', versionNumber: '1.0' }] }), () => false);
    expect(p.warnings.length).toBeGreaterThanOrEqual(3);
  });
  it('rejects invalid files', () => {
    expect(() => parseProject('/p', '{bad', () => true)).toThrow(/not valid JSON/);
    expect(() => parseProject('/p', '{"packageDirectories": []}', () => true)).toThrow(/no packageDirectories/);
  });
  it('config round-trips and drops unsafe values', () => {
    const dir = tmp();
    writeConfig(dir, { schemaVersion: '1.0', devHubAlias: 'hub', devOrgAlias: '--evil flag' });
    const c = readConfig(dir);
    expect(c.devHubAlias).toBe('hub');
    expect(c.devOrgAlias).toBeUndefined();
    expect(parseConfig('garbage').schemaVersion).toBe('1.0');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- git (local integration, real git)
describe('GitAdapter (local integration, real git)', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const setup = () => {
    const dir = tmp();
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.t');
    git(dir, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    return dir;
  };
  const adapter = () => new GitAdapter(new NodeProcessRunner(), new CommandHistory());

  it('detects clean, modified and untracked states and changes the fingerprint', async () => {
    const dir = setup();
    const a = adapter();
    const clean = await a.snapshot(dir);
    expect(clean.isRepo).toBe(true);
    expect(clean.files).toEqual([]);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
    const mod = await a.snapshot(dir);
    expect(mod.files).toHaveLength(1);
    expect(mod.fingerprint).not.toBe(clean.fingerprint);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    const unt = await a.snapshot(dir);
    expect(unt.files.map(f => f.status).sort()).toEqual([' M', '??']);
    expect(unt.fingerprint).not.toBe(mod.fingerprint);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'y');
    expect((await a.snapshot(dir)).fingerprint).not.toBe(unt.fingerprint);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores ReleasePilot config changes and reports non-repos', async () => {
    const dir = setup();
    const a = adapter();
    const before = await a.snapshot(dir);
    fs.writeFileSync(path.join(dir, '.releasepilot.json'), '{}');
    const after = await a.snapshot(dir);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.files).toEqual([]);
    const plain = tmp();
    expect((await a.snapshot(plain)).isRepo).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it('parses porcelain -z output including renames', () => {
    const files = parsePorcelainZ(' M a.txt\0R  new.txt\0old.txt\0?? c.txt\0');
    expect(files.map(f => f.path)).toEqual(['a.txt', 'new.txt', 'c.txt']);
  });
});

// ---------------------------------------------------------------- retrieval safety (mocked)
describe('RetrievalService safety (mocked sf, real git)', () => {
  const org: OrgInfo = { orgId: '00D000000000009', username: 'dev@x.com', alias: 'dev', isDevHub: false, isScratch: false, isSandbox: true, tracksSource: true, isDefaultDevHub: false, isDefaultOrg: false, expired: false };
  const repo = () => {
    const dir = tmp();
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'force-app'));
    fs.writeFileSync(path.join(dir, 'force-app', 'A.cls'), 'v1');
    g('add', '.'); g('commit', '-qm', 'i');
    return dir;
  };
  const build = (preview: unknown) => {
    const runner = new FakeRunner(req => {
      const a = req.args.join(' ');
      if (a.includes('git')) { return ok(); }
      if (req.command === 'git') {
        return new NodeProcessRunner().run(req) as unknown as RunResult;
      }
      return ok(JSON.stringify({ status: 0, result: a.includes('preview') ? preview : {} }));
    });
    // Git must be real; route git to the real runner and sf to the fake.
    const real = new NodeProcessRunner();
    const router: ProcessRunner = { run: req => (req.command === 'git' ? real.run(req) : runner.run(req)) };
    const history = new CommandHistory();
    const sf = new SfCli(router, history, { command: 'sf', prefixArgs: [] });
    return { svc: new RetrievalService(sf, new GitAdapter(router, history)), runner };
  };

  it('refuses orgs without source tracking', async () => {
    const { svc } = build({});
    await expect(svc.preview(repo(), { ...org, tracksSource: false })).rejects.toMatchObject({ code: 'NO_SOURCE_TRACKING' });
  });

  it('requires a preview before retrieving', async () => {
    const { svc } = build({});
    expect(await svc.apply(repo(), org, { confirmedDirty: false })).toMatchObject({ ok: false, code: 'PREVIEW_REQUIRED' });
  });

  it('blocks on conflicts and never passes --ignore-conflicts', async () => {
    const dir = repo();
    const { svc, runner } = build({ toRetrieve: [{ type: 'ApexClass', fullName: 'A', projectRelativePath: 'force-app/A.cls' }], conflicts: [{ type: 'ApexClass', fullName: 'A' }] });
    const p = await svc.preview(dir, org);
    expect(p.blockers.join()).toMatch(/conflict/);
    expect(await svc.apply(dir, org, { confirmedDirty: true })).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(runner.calls.some(c => c.args.includes('start'))).toBe(false);
    expect(runner.calls.every(c => !c.args.includes('--ignore-conflicts') && !c.args.includes('-c'))).toBe(true);
  });

  it('blocks when retrieval would overwrite uncommitted local edits', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'force-app', 'A.cls'), 'local edit');
    const { svc } = build({ toRetrieve: [{ type: 'ApexClass', fullName: 'A', projectRelativePath: 'force-app/A.cls' }] });
    const p = await svc.preview(dir, org);
    expect(p.overlap).toEqual(['force-app/A.cls']);
    expect(await svc.apply(dir, org, { confirmedDirty: true })).toMatchObject({ ok: false, code: 'BLOCKED' });
  });

  it('asks for confirmation when unrelated edits exist, then retrieves; rejects a stale preview', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'wip');
    const { svc, runner } = build({ toRetrieve: [{ type: 'ApexClass', fullName: 'A', projectRelativePath: 'force-app/A.cls' }] });
    await svc.preview(dir, org);
    expect(await svc.apply(dir, org, { confirmedDirty: false })).toMatchObject({ ok: false, needsConfirmation: true });
    fs.writeFileSync(path.join(dir, 'more.txt'), 'changed after preview');
    expect(await svc.apply(dir, org, { confirmedDirty: true })).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    await svc.preview(dir, org);
    const done = await svc.apply(dir, org, { confirmedDirty: true });
    expect(done.ok).toBe(true);
    expect(runner.calls.some(c => c.args.includes('start'))).toBe(true);
  });
});

// ---------------------------------------------------------------- preflight evaluation
describe('evaluatePreflight', () => {
  const orgDev: OrgInfo = { orgId: '00D1', username: 'hub@x.com', alias: 'hub', isDevHub: true, isScratch: false, isSandbox: false, tracksSource: false, isDefaultDevHub: true, isDefaultOrg: false, expired: false };
  const base = (): DiscoverySnapshot => ({
    root: '/p', config: { schemaVersion: '1.0' }, orgs: [orgDev], packages: [], versions: [], errors: [], commands: [],
    project: parseProject('/p', JSON.stringify({ namespace: 'ns', packageDirectories: [{ path: 'force-app', package: 'P', versionNumber: '1.0.0.NEXT' }], packageAliases: { P: '0Ho000000000001AAA' } }), () => true),
    tooling: { node: 'v', sf: '@salesforce/cli/2', codeAnalyzer: { name: 'code-analyzer', version: '5.0.0' } },
    git: { isRepo: true, version: 'git 2', branch: 'main', files: [] },
    devHub: orgDev, selectedPackage: { id: '0Ho000000000001AAA', name: 'P', namespacePrefix: 'ns', containerOptions: 'Managed' }
  });
  const fails = (s: DiscoverySnapshot) => evaluatePreflight(s).filter(c => c.status === 'fail').map(c => c.name);

  it('passes a fully valid environment', () => expect(fails(base())).toEqual([]));
  it('fails without a Dev Hub', () => expect(fails({ ...base(), devHub: undefined, selectedPackage: undefined })).toContain('Dev Hub'));
  it('fails when the Dev Hub does not own the package', () => expect(fails({ ...base(), selectedPackage: undefined })).toContain('Package ownership'));
  it('fails on namespace mismatch', () => {
    const s = base();
    s.selectedPackage = { ...s.selectedPackage!, namespacePrefix: 'other' };
    expect(fails(s)).toContain('Namespace');
  });
  it('fails without Code Analyzer v5 or a Git repo', () => {
    const s = base();
    s.tooling = { node: 'v', sf: '2' };
    s.git = { isRepo: false, files: [], error: 'no git' };
    expect(fails(s)).toEqual(expect.arrayContaining(['Code Analyzer v5', 'Git']));
  });
  it('fails when the project is missing', () => {
    const s = { ...base(), project: undefined, errors: [{ scope: 'project', code: 'NO_SFDX_PROJECT', message: 'none' }] };
    expect(fails(s)).toContain('Salesforce DX project');
  });
});

// ---------------------------------------------------------------- webview message validation
describe('slice 2 message validation', () => {
  it('validates selection and folder messages', () => {
    expect(parseMessage({ type: 'selectDevHub', alias: 'my-hub' })).toBeDefined();
    expect(parseMessage({ type: 'selectDevHub', alias: '' })).toBeDefined();
    expect(parseMessage({ type: 'selectDevHub', alias: '--target-org' })).toBeUndefined();
    expect(parseMessage({ type: 'selectDevHub', alias: 'a b; rm' })).toBeUndefined();
    expect(parseMessage({ type: 'selectFolder', path: 'C:\\proj\nx' })).toBeUndefined();
    expect(parseMessage({ type: 'setSetting', key: 'allowDirtySource', value: true })).toBeDefined();
    expect(parseMessage({ type: 'setSetting', key: 'allowDirtySource', value: 1 })).toBeUndefined();
    expect(parseMessage({ type: 'retrieveApply' })).toBeDefined();
  });
});

// ---------------------------------------------------------------- live CLI (read-only, local)
describe('installed Salesforce CLI (local integration, read-only)', () => {
  const launcher = resolveSfLauncher();
  it.skipIf(!launcher)('reports its version through the adapter without a shell', async () => {
    const sf = new SfCli(new NodeProcessRunner(), new CommandHistory(), launcher);
    const v = await sf.text(['--version'], { cwd: os.tmpdir(), timeoutMs: 60_000 });
    expect(v).toMatch(/@salesforce\/cli/);
  }, 90_000);
});
