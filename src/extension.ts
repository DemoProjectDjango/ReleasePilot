import * as path from 'path';
import * as vscode from 'vscode';
import { CommandHistory } from './adapters/commandHistory';
import { GitAdapter } from './adapters/git';
import { NodeProcessRunner } from './adapters/processRunner';
import { SfCli, SfError, resolveSfLauncher } from './adapters/sfCli';
import { Logger } from './core/logger';
import { StepId } from './core/models';
import { DiscoveryService } from './discovery/discoveryService';
import { RetrievalService } from './discovery/retrieval';
import { FileStateStore } from './engine/stateStore';
import { WorkflowEngine } from './engine/workflowEngine';
import { createExecutors } from './executors/executors';
import { ReportWriter } from './executors/reportWriter';
import { DashboardPanel } from './ui/dashboardPanel';
import { WebviewMessage } from './ui/messages';
import { PipelineTree, StepItem } from './ui/pipelineTree';

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('releasepilot');
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const store = new FileStateStore(path.join(storageDir, 'workflow-state.json'));
  const reports = new ReportWriter(path.join(storageDir, 'reports'));

  const output = vscode.window.createOutputChannel('ReleasePilot');
  context.subscriptions.push(output);

  const persisted = store.load();
  const logger = new Logger(cfg().get<number>('logRetentionEntries', 2000), persisted?.logs ?? []);
  logger.addSink(e => output.appendLine(`${e.at} [${e.level.toUpperCase()}] ${e.scope}: ${e.message}`));

  // Adapters: every external process goes through the runner (shell:false, argument arrays).
  const runner = new NodeProcessRunner();
  const history = new CommandHistory();
  const sf = new SfCli(runner, history, resolveSfLauncher());
  const git = new GitAdapter(runner, history);
  const discovery = new DiscoveryService(sf, git);
  const retrieval = new RetrievalService(sf, git);

  const folders = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const getRoot = (): string | undefined => {
    const saved = context.workspaceState.get<string>('releasepilot.root');
    return saved && folders().includes(saved) ? saved : folders()[0];
  };

  const trusted = () => vscode.workspace.isTrusted;
  const engine = new WorkflowEngine({
    store,
    logger,
    executors: createExecutors({ discovery, reports, getRoot, allowDirtySource: () => cfg().get<boolean>('allowDirtySource', false) }),
    canExecute: () => trusted() ? { allowed: true } : { allowed: false, reason: 'Running workflow steps requires a trusted workspace.' },
    stepTimeoutMs: cfg().get<number>('stepTimeoutMinutes', 60) * 60_000
  });
  logger.log('info', 'extension', `ReleasePilot activated. Salesforce CLI ${sf.available ? 'found' : 'NOT found'}.`);

  const tree = new PipelineTree(engine);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('releasepilot.pipeline', tree));

  // ---- view model --------------------------------------------------------
  let busy: string | undefined;
  let notice: { level: 'info' | 'error'; text: string } | undefined;
  const refreshUi = () => { tree.refresh(); DashboardPanel.refresh(); };

  const withBusy = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) {
      void vscode.window.showWarningMessage(`ReleasePilot: "${busy}" is still in progress.`);
      return undefined;
    }
    busy = label;
    notice = undefined;
    refreshUi();
    try {
      return await fn();
    } catch (e) {
      const text = e instanceof SfError
        ? `${e.message}${e.remediation ? ` ${e.remediation}` : ''}`
        : (e instanceof Error ? e.message : String(e));
      notice = { level: 'error', text };
      logger.log('error', 'extension', `${label} failed: ${text}`);
      return undefined;
    } finally {
      busy = undefined;
      refreshUi();
    }
  };

  const view = () => ({
    discovery: discovery.snapshot,
    retrieval: retrieval.lastPreview,
    busy,
    notice,
    selectedRoot: getRoot(),
    cliAvailable: sf.available
  });

  // ---- source-freshness monitor (FR-09 / NFR-06) -------------------------
  let monitorTimer: NodeJS.Timeout | undefined;
  const checkFreshness = async () => {
    const root = getRoot();
    const source = engine.getState().run.steps.source;
    if (!root || !trusted() || !source.fingerprint || source.status === 'stale' || busy) {
      return;
    }
    const snap = await git.snapshot(root);
    if (snap.fingerprint && snap.fingerprint !== source.fingerprint) {
      engine.markStale('source', 'local source changed after the snapshot was taken');
    }
  };
  const scheduleFreshness = () => {
    clearTimeout(monitorTimer);
    monitorTimer = setTimeout(() => { void checkFreshness(); }, 1500);
  };

  const runDiscovery = async () => {
    const root = getRoot();
    if (!root) {
      notice = { level: 'error', text: 'Open a folder containing a Salesforce DX project.' };
      return;
    }
    if (!trusted()) {
      notice = { level: 'error', text: 'Discovery runs external tools and requires a trusted workspace.' };
      return;
    }
    await withBusy('Discovering project and orgs', async () => {
      const before = discovery.snapshot.devHub?.orgId;
      const snap = await discovery.discover(root);
      if (before && snap.devHub?.orgId !== before) {
        engine.markStale('preflight', 'the selected Dev Hub changed');
      }
    });
  };

  const handleAction = async (msg: WebviewMessage): Promise<void> => {
    const say = (res: { ok: boolean; message?: string }) => {
      if (!res.ok && res.message) {
        void vscode.window.showWarningMessage(`ReleasePilot: ${res.message}`);
      }
    };
    switch (msg.type) {
      case 'run':
      case 'retry':
        say(await engine.runStep(msg.stepId));
        void checkFreshness();
        break;
      case 'resume':
        say(await engine.resume());
        break;
      case 'cancel':
        engine.cancel(msg.stepId);
        break;
      case 'newRun': {
        const pick = await vscode.window.showWarningMessage(
          'Start a new release run? The current run is archived to history and all step results reset.',
          { modal: true }, 'Start New Run');
        if (pick === 'Start New Run' && !engine.startNewRun()) {
          void vscode.window.showWarningMessage('ReleasePilot: cannot start a new run while a step is running.');
        }
        break;
      }
      case 'showLogs':
        output.show(true);
        break;
      case 'refresh':
      case 'discover':
        await runDiscovery();
        break;
      case 'selectFolder':
        if (folders().includes(msg.path)) {
          await context.workspaceState.update('releasepilot.root', msg.path);
          engine.markStale('preflight', 'the selected project changed');
          await runDiscovery();
        }
        break;
      case 'selectDevHub':
      case 'selectDevOrg':
      case 'selectPackage': {
        const known = discovery.snapshot.orgs;
        const valid = msg.alias === '' || msg.type === 'selectPackage' ||
          known.some(o => o.alias === msg.alias || o.username === msg.alias);
        if (!valid) {
          void vscode.window.showWarningMessage('ReleasePilot: that org is not among the authenticated orgs.');
          break;
        }
        await withBusy('Updating selection', async () => {
          const value = msg.alias || undefined;
          if (msg.type === 'selectDevHub') {
            await discovery.selectDevHub(value);
            engine.markStale('preflight', 'the selected Dev Hub changed');
          } else if (msg.type === 'selectDevOrg') {
            await discovery.selectDevOrg(value);
          } else {
            await discovery.selectPackage(value);
            engine.markStale('preflight', 'the selected package changed');
          }
        });
        break;
      }
      case 'retrievePreview': {
        const root = getRoot();
        const org = discovery.snapshot.devOrg;
        if (!root || !trusted() || !org) {
          notice = { level: 'error', text: !org ? 'Select a development org first.' : 'A trusted workspace is required.' };
          refreshUi();
          break;
        }
        await withBusy('Previewing org changes', async () => {
          const out = await retrieval.preview(root, org);
          const ev = reports.write('retrieve-preview', `Retrieve preview from ${out.orgLabel}`, out);
          engine.addArtifact(ev);
          logger.log('info', 'retrieve', `Preview: ${out.preview.toRetrieve.length} to retrieve, ${out.preview.conflicts.length} conflict(s), ${out.overlap.length} overlapping local edit(s).`);
        });
        break;
      }
      case 'retrieveApply': {
        const root = getRoot();
        const org = discovery.snapshot.devOrg;
        const preview = retrieval.lastPreview;
        if (!root || !trusted() || !org || !preview) {
          notice = { level: 'error', text: 'Run a retrieval preview for the selected development org first.' };
          refreshUi();
          break;
        }
        const ok = await vscode.window.showWarningMessage(
          `Retrieve ${preview.preview.toRetrieve.length} component(s) from ${preview.orgLabel} into the local project? This changes files in your working tree.`,
          { modal: true, detail: 'No conflicts exist and none of your uncommitted edits will be overwritten. Review the result with Git afterwards.' }, 'Retrieve');
        if (ok !== 'Retrieve') {
          break;
        }
        await withBusy('Retrieving source from org', async () => {
          let res = await retrieval.apply(root, org, { confirmedDirty: false });
          if (!res.ok && res.needsConfirmation) {
            const again = await vscode.window.showWarningMessage(res.message + ' Continue with the retrieval?', { modal: true }, 'Continue');
            if (again === 'Continue') {
              res = await retrieval.apply(root, org, { confirmedDirty: true });
            }
          }
          if (res.ok) {
            engine.addArtifact(reports.write('retrieve-result', `Retrieved ${res.retrieved} component(s) from ${res.orgLabel}`, res));
            logger.log('info', 'retrieve', `Retrieved ${res.retrieved} component(s); ${res.changedFiles.length} file(s) changed.`);
            notice = { level: 'info', text: `Retrieved ${res.retrieved} component(s). Review changes with Git. Prior validation results are now stale.` };
            await checkFreshness();
          } else if (res.code !== 'CONFIRMATION_REQUIRED') {
            notice = { level: 'error', text: res.message };
          }
        });
        break;
      }
      case 'setSetting':
        await cfg().update(msg.key, msg.value, vscode.ConfigurationTarget.Workspace);
        break;
      default:
        break;
    }
  };

  const host = { extensionUri: context.extensionUri, engine, handleAction, extra: view };
  const stepOf = (item?: StepItem): StepId | undefined => item?.def.id;

  context.subscriptions.push(
    vscode.commands.registerCommand('releasepilot.openDashboard', () => DashboardPanel.show(host)),
    vscode.commands.registerCommand('releasepilot.refresh', () => handleAction({ type: 'discover' })),
    vscode.commands.registerCommand('releasepilot.runStep', (i?: StepItem) => { const id = stepOf(i); return id && handleAction({ type: 'run', stepId: id }); }),
    vscode.commands.registerCommand('releasepilot.retryStep', (i?: StepItem) => { const id = stepOf(i); return id && handleAction({ type: 'retry', stepId: id }); }),
    vscode.commands.registerCommand('releasepilot.cancelStep', (i?: StepItem) => { const id = stepOf(i); return id && handleAction({ type: 'cancel', stepId: id }); }),
    vscode.commands.registerCommand('releasepilot.resumePipeline', () => handleAction({ type: 'resume' })),
    vscode.commands.registerCommand('releasepilot.newRun', () => handleAction({ type: 'newRun' })),
    vscode.commands.registerCommand('releasepilot.showLogs', () => output.show(true)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('releasepilot')) {
        logger.setMax(cfg().get<number>('logRetentionEntries', 2000));
        DashboardPanel.refresh();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { refreshUi(); void runDiscovery(); }),
    vscode.workspace.onDidSaveTextDocument(scheduleFreshness),
    vscode.workspace.onDidCreateFiles(scheduleFreshness),
    vscode.workspace.onDidDeleteFiles(scheduleFreshness),
    { dispose: () => clearTimeout(monitorTimer) }
  );

  if (trusted()) {
    void runDiscovery();
  }
}

export function deactivate(): void {
  // State is persisted on every transition; nothing to flush.
}
