import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface ViewState {
  type: string;
  selectedRoot?: string;
  busy?: string;
  notice?: { text: string };
  definitions: unknown[];
  projects: { items: Array<{ path: string; source: string }> };
  state: { history: unknown[]; run: { id: string; steps: Record<string, { status: string; evidence: unknown[] }> } };
}

/**
 * Integration test of the real extension entry point against a stub of the VS Code API. It proves activation works
 * and exercises project switching (per-project isolation, trust prompt, decline, bad folder) end to end.
 * It is NOT a test inside a real VS Code window.
 */
const h = vi.hoisted(() => ({
  commands: new Map<string, (...a: unknown[]) => unknown>(),
  posted: [] as ViewState[],
  handler: undefined as undefined | ((m: unknown) => Promise<void>),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  warning: [] as Array<string | undefined>,
  warningsShown: [] as string[],
  openDialog: [] as Array<string[] | undefined>,
  inputs: [] as Array<string | undefined>
}));

vi.mock('vscode', () => {
  class Emitter { private ls: Array<(e: unknown) => void> = []; event = (l: (e: unknown) => void) => { this.ls.push(l); return { dispose: () => undefined }; }; fire(e?: unknown) { this.ls.forEach(l => l(e)); } }
  const disposable = { dispose: () => undefined };
  const uri = (p: string) => ({ fsPath: p, toString: () => `file:${p}` });
  return {
    EventEmitter: Emitter,
    ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
    ThemeColor: class { constructor(public id: string) {} },
    TreeItem: class { id?: string; description?: string; iconPath?: unknown; tooltip?: unknown; contextValue?: string; command?: unknown; constructor(public label: string, public collapsibleState?: number) {} },
    TreeItemCollapsibleState: { None: 0 },
    MarkdownString: class { constructor(public value: string) {} },
    ViewColumn: { One: 1 },
    ConfigurationTarget: { Workspace: 2 },
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    WorkspaceEdit: class { replace() {} },
    Uri: { file: uri, joinPath: (b: { fsPath: string }, ...p: string[]) => uri(path.join(b.fsPath, ...p)), parse: (s: string) => uri(s) },
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
      registerTreeDataProvider: () => disposable,
      createWebviewPanel: () => ({
        webview: {
          html: '', cspSource: 'csp', asWebviewUri: (u: unknown) => u,
          onDidReceiveMessage: (cb: (m: unknown) => Promise<void>) => { h.handler = cb; return disposable; },
          postMessage: async (m: ViewState) => { h.posted.push(m); return true; }
        },
        reveal: () => undefined, onDidDispose: () => disposable, dispose: () => undefined
      }),
      showWarningMessage: async (msg: string, opts?: { detail?: string }) => { h.warningsShown.push(msg + ' ' + (opts?.detail ?? '')); return h.warning.shift(); },
      showInputBox: async () => h.inputs.shift(),
      showOpenDialog: async () => (h.openDialog.shift() ?? undefined)?.map(uri),
      showSaveDialog: async () => undefined,
      showTextDocument: async () => undefined
    },
    workspace: {
      get workspaceFolders() { return h.workspaceFolders; },
      isTrusted: true,
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => undefined }),
      onDidChangeConfiguration: () => disposable, onDidGrantWorkspaceTrust: () => disposable, onDidSaveTextDocument: () => disposable,
      onDidCreateFiles: () => disposable, onDidDeleteFiles: () => disposable, registerTextDocumentContentProvider: () => disposable,
      openTextDocument: async () => ({}), applyEdit: async () => true
    },
    commands: { registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => { h.commands.set(id, fn); return disposable; }, executeCommand: async () => undefined },
    env: { clipboard: { writeText: async () => undefined }, openExternal: async () => true }
  };
});

const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-ext-${n}-`));
const dx = (n: string) => { const d = tmp(n); fs.writeFileSync(path.join(d, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] })); return d; };

let projectA: string;
let projectB: string;
let storage: string;
let notDx: string;
const oldPath = process.env.PATH;
const state = () => h.posted.filter(p => p.type === 'state').at(-1) as ViewState;
const send = async (m: unknown) => { await h.handler!(m); };
/** Discovery starts at activation; wait until the extension reports idle (switching while busy is refused by design). */
const idle = async () => {
  for (let i = 0; i < 100; i++) {
    await send({ type: 'ready' });
    if (!state().busy) { return; }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('extension never became idle');
};

beforeAll(async () => {
  // No sf or git on PATH: discovery fails fast and nothing touches a real org.
  process.env.PATH = '';
  projectA = dx('a');
  projectB = dx('b');
  notDx = tmp('plain');
  storage = tmp('storage');
  h.workspaceFolders = [{ uri: { fsPath: projectA } }];
  const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => { m.set(k, v); } }; };
  const ctx = { subscriptions: [] as unknown[], extensionUri: { fsPath: path.resolve('.') }, storageUri: { fsPath: storage }, globalStorageUri: { fsPath: storage }, workspaceState: memento(), globalState: memento() };
  const ext = await import('../extension');
  ext.activate(ctx as never);
  await (h.commands.get('releasepilot.openDashboard') as () => unknown)();
  await send({ type: 'ready' });
});

afterAll(() => { process.env.PATH = oldPath; });

describe('extension host (stubbed VS Code API)', () => {
  it('activates, registers its commands and posts a complete view model', () => {
    for (const id of ['releasepilot.openDashboard', 'releasepilot.runStep', 'releasepilot.resumePipeline', 'releasepilot.newRun']) {
      expect(h.commands.has(id)).toBe(true);
    }
    const s = state();
    expect(s.selectedRoot).toBe(projectA);
    expect(s.definitions).toHaveLength(10);
    expect(s.projects.items.map((p) => p.path)).toEqual([projectA]);
    expect(Object.keys(s.state.run.steps)).toHaveLength(10);
  });

  it('keeps run state separate for each project', async () => {
    await idle();
    h.warning.push('Start New Run');
    await send({ type: 'newRun' });
    expect(state().state.history).toHaveLength(1);
    const runA = state().state.run.id as string;

    // switch to a project outside the workspace: needs an explicit trust decision
    h.openDialog.push([projectB]);
    h.warning.push('Trust this folder');
    await send({ type: 'browseProject' });
    expect(h.warningsShown.at(-1)).toMatch(/outside your open VS Code workspace/);
    expect(state().selectedRoot).toBe(projectB);
    expect(state().state.history).toHaveLength(0);
    expect(state().state.run.id).not.toBe(runA);
    expect(state().projects.items.map((p) => `${p.source}`).sort()).toEqual(['recent', 'workspace']);

    // a change in B is stored in B's own folder, never in A's
    h.warning.push('Start New Run');
    await send({ type: 'newRun' });
    expect(state().state.history).toHaveLength(1);
    const runB = state().state.run.id as string;
    expect(runB).not.toBe(runA);

    // each project has its own storage folder
    const dirs = fs.readdirSync(path.join(storage, 'projects'));
    expect(dirs).toHaveLength(2);

    // back to A: its history is still there
    await send({ type: 'selectFolder', path: projectA });
    expect(state().selectedRoot).toBe(projectA);
    expect(state().state.history).toHaveLength(1);
    expect(state().state.run.id).toBe(runA);
  });

  it('does not ask again for a project it already trusted', async () => {
    const asked = h.warningsShown.length;
    await send({ type: 'selectFolder', path: projectB });
    expect(state().selectedRoot).toBe(projectB);
    expect(h.warningsShown.length).toBe(asked);
    await send({ type: 'selectFolder', path: projectA });
  });

  it('refuses a folder that is not a DX project, and respects a declined trust prompt', async () => {
    h.openDialog.push([notDx]);
    await send({ type: 'browseProject' });
    expect(state().selectedRoot).toBe(projectA);
    expect(state().notice?.text).toMatch(/not a Salesforce DX project/);

    const other = dx('declined');
    h.openDialog.push([other]);
    h.warning.push(undefined);
    await send({ type: 'browseProject' });
    expect(state().selectedRoot).toBe(projectA);
    expect(state().projects.items.some((p) => p.path === path.resolve(other))).toBe(false);
  });

  it('refuses to switch projects while an operation is running', async () => {
    await idle();
    const running = send({ type: 'discover' });
    h.openDialog.push([projectB]);
    await send({ type: 'browseProject' });
    expect(state().notice?.text).toMatch(/Finish or cancel the running operation/);
    expect(state().selectedRoot).toBe(projectA);
    await running;
  });

  it('ignores a switch to a path that is not an offered choice', async () => {
    await send({ type: 'selectFolder', path: notDx });
    expect(state().selectedRoot).toBe(projectA);
  });

  it('never runs a workflow step without an executor path it was given: Run on a blocked step is refused', async () => {
    await send({ type: 'run', stepId: 'promotion' });
    const steps = state().state.run.steps;
    expect(steps.promotion.status).toBe('pending');
    expect(steps.promotion.evidence).toEqual([]);
  });
});
