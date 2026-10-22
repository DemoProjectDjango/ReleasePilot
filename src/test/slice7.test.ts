import { describe, expect, it } from 'vitest';
import { AnalysisReport, Finding } from '../analysis/analyzer';
import { OrgInfo } from '../discovery/parsers';
import { parseProject } from '../discovery/project';
import { buildSetup, setupCommand } from '../discovery/setup';
import { findInReports, pickAnalysis } from '../testing/analysisView';
import { parseMessage } from '../ui/messages';

const org = (o: Partial<OrgInfo> = {}): OrgInfo => ({ orgId: '00D000000000001', username: 'hub@x.com', alias: 'hub', isDevHub: true, isScratch: false, isSandbox: false, tracksSource: false, isDefaultDevHub: true, isDefaultOrg: false, expired: false, ...o });
const project = (dir: object, aliases: Record<string, string> = {}, extra: object = {}) =>
  parseProject('/p', JSON.stringify({ packageDirectories: [{ path: 'force-app', ...dir }], packageAliases: aliases, ...extra }), () => true);

const healthy = () => ({
  project: project({ package: 'MassDelete', versionNumber: '1.0.0.NEXT' }, { MassDelete: '0Ho000000000001AAA' }, { name: 'big-archiver' }),
  tooling: { node: 'v24', sf: '@salesforce/cli/2.150.6 win32-x64', codeAnalyzer: { name: 'code-analyzer', version: '5.15.0' } },
  git: { isRepo: true, files: [], branch: 'main' },
  orgs: [org()], devHub: org(), selectedPackage: { id: '0Ho000000000001AAA', name: 'MassDelete' }, validationOrg: org({ alias: 'qa', isDevHub: false, isScratch: true, orgId: '00D000000000009' })
});
const byId = (items: ReturnType<typeof buildSetup>, id: string) => items.find(i => i.id === id)!;

describe('buildSetup', () => {
  it('has nothing left to do for a ready project', () => {
    const items = buildSetup(healthy());
    expect(items.filter(i => i.state === 'todo')).toEqual([]);
    expect(items.every(i => i.state === 'ok')).toBe(true);
  });

  it('explains a project that declares no package, without offering to create anything itself', () => {
    const s = { ...healthy(), project: project({}), selectedPackage: undefined, devHub: undefined };
    const items = buildSetup(s);
    const pkg = byId(items, 'package');
    expect(pkg.state).toBe('todo');
    expect(pkg.detail).toMatch(/nothing to release/);
    expect(pkg.detail).toMatch(/ReleasePilot never does for you/);
    expect(pkg.actions.map(a => a.kind)).toEqual(['openProject', 'copyCmd']);
    // every action is a button for the user: none runs a command
    expect(JSON.stringify(pkg.actions)).not.toMatch(/run|execute/i);
    expect(byId(items, 'ownership').state).toBe('info');
  });

  it('flags a package alias without a 0Ho id, and a Dev Hub that does not own the package', () => {
    const noId = buildSetup({ ...healthy(), project: project({ package: 'P' }), selectedPackage: undefined });
    expect(byId(noId, 'package').state).toBe('todo');
    expect(byId(noId, 'package').detail).toMatch(/no 0Ho package ID/);
    const notOwned = buildSetup({ ...healthy(), selectedPackage: undefined });
    expect(byId(notOwned, 'ownership').state).toBe('todo');
    expect(byId(notOwned, 'ownership').detail).toMatch(/does not list that package/);
  });

  it('guides tooling and Dev Hub problems', () => {
    const noCli = buildSetup({ ...healthy(), tooling: { node: 'v24' } });
    expect(byId(noCli, 'cli').state).toBe('todo');
    expect(byId(noCli, 'cli').actions[0]).toMatchObject({ kind: 'copyCmd', id: 'install-cli' });
    expect(byId(noCli, 'analyzer').state).toBe('info');
    const noAnalyzer = buildSetup({ ...healthy(), tooling: { node: 'v24', sf: '@salesforce/cli/2' } });
    expect(byId(noAnalyzer, 'analyzer').state).toBe('todo');
    expect(byId(noAnalyzer, 'analyzer').detail).toMatch(/Java/);
    const pickHub = buildSetup({ ...healthy(), devHub: undefined, selectedPackage: undefined });
    expect(byId(pickHub, 'devhub').detail).toMatch(/Choose your Dev Hub/);
    expect(byId(pickHub, 'devhub').actions).toEqual([]);
    const noHubs = buildSetup({ ...healthy(), devHub: undefined, orgs: [org({ isDevHub: false })], selectedPackage: undefined });
    expect(byId(noHubs, 'devhub').actions[0]).toMatchObject({ id: 'login-devhub' });
  });

  it('treats the validation org and a non-project folder sensibly', () => {
    expect(byId(buildSetup({ ...healthy(), validationOrg: undefined }), 'validation').state).toBe('info');
    const none = buildSetup({ ...healthy(), project: undefined, git: { isRepo: false, files: [], error: 'not a repo' } });
    expect(byId(none, 'project').state).toBe('todo');
    expect(byId(none, 'git').detail).toBe('not a repo');
    expect(byId(none, 'package').state).toBe('info');
  });
});

describe('setupCommand', () => {
  it('only produces known commands', () => {
    const s = healthy();
    expect(setupCommand('install-cli', s)).toBe('npm install --global @salesforce/cli');
    expect(setupCommand('install-analyzer', s)).toBe('sf plugins install code-analyzer');
    expect(setupCommand('login-devhub', s)).toMatch(/^sf org login web/);
    expect(setupCommand('rm-rf', s)).toBeUndefined();
    expect(setupCommand('', s)).toBeUndefined();
  });

  it('builds a create-package command from the project, with a sanitized name and the chosen Dev Hub', () => {
    expect(setupCommand('create-package', healthy())).toBe('sf package create --name "big-archiver" --package-type Managed --path force-app --target-dev-hub hub');
    const hostile = { project: project({ path: 'src/app' }, {}, { name: 'x"; rm -rf / #$(whoami)' }), devHub: undefined };
    const cmd = setupCommand('create-package', hostile)!;
    expect(cmd).toContain('--path src/app');
    expect(cmd).toContain('--target-dev-hub <devhub-alias>');
    expect(cmd).not.toMatch(/[;$`]|rm -rf \//);
    expect(cmd.match(/"/g)).toHaveLength(2);
  });
});

describe('project name', () => {
  it('is read from sfdx-project.json', () => {
    expect(project({}, {}, { name: 'big-archiver' }).name).toBe('big-archiver');
    expect(project({}).name).toBeUndefined();
  });
});

describe('quick scan vs pipeline analysis', () => {
  const f = (key: string): Finding => ({ key, rule: 'R', engine: 'pmd', severity: 2, severityLabel: 'High', file: 'a.cls', absFile: '/p/a.cls', line: 1, column: 1, message: 'm', tags: [], resources: [], suggestions: [] });
  const report = (at: string, keys: string[], fp: string): AnalysisReport => ({ at, workspace: '/p', selectors: ['Recommended'], versions: {}, sourceFingerprint: fp, findings: keys.map(f), counts: { total: keys.length }, jsonPath: `${fp}.json`, warnings: [] });

  it('shows the newest scan and always flags a quick scan as ad hoc', () => {
    const pipeline = report('2026-10-22T10:00:00Z', ['a'], 'fp1');
    const quick = report('2026-10-22T11:00:00Z', ['b'], 'fp2');
    expect(pickAnalysis({})).toEqual({ report: undefined, adHoc: false });
    expect(pickAnalysis({ analysis: pipeline })).toEqual({ report: pipeline, adHoc: false });
    expect(pickAnalysis({ quick })).toEqual({ report: quick, adHoc: true });
    expect(pickAnalysis({ analysis: pipeline, quick })).toEqual({ report: quick, adHoc: true });
    expect(pickAnalysis({ analysis: report('2026-10-22T12:00:00Z', ['a'], 'fp3'), quick })).toMatchObject({ adHoc: false });
  });

  it('finds a finding in either scan together with the scan it came from', () => {
    const q = { analysis: report('2026-10-22T10:00:00Z', ['a'], 'fp1'), quick: report('2026-10-22T11:00:00Z', ['b'], 'fp2') };
    expect(findInReports(q, 'a')).toMatchObject({ adHoc: false, report: { sourceFingerprint: 'fp1' } });
    expect(findInReports(q, 'b')).toMatchObject({ adHoc: true, report: { sourceFingerprint: 'fp2' } });
    expect(findInReports(q, 'zzz')).toBeUndefined();
  });
});

describe('slice 7 message validation', () => {
  it('validates the new actions', () => {
    expect(parseMessage({ type: 'quickScan' })).toBeDefined();
    expect(parseMessage({ type: 'openProject' })).toBeDefined();
    expect(parseMessage({ type: 'copyCmd', id: 'create-package' })).toEqual({ type: 'copyCmd', id: 'create-package' });
    expect(parseMessage({ type: 'copyCmd', id: 'rm -rf /' })).toBeUndefined();
    expect(parseMessage({ type: 'copyCmd', id: 'A;B' })).toBeUndefined();
    expect(parseMessage({ type: 'copyCmd' })).toBeUndefined();
  });
});
