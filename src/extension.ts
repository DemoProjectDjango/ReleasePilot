import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './core/logger';
import { StepId } from './core/models';
import { FileStateStore } from './engine/stateStore';
import { WorkflowEngine } from './engine/workflowEngine';
import { DashboardPanel } from './ui/dashboardPanel';
import { WebviewMessage } from './ui/messages';
import { PipelineTree, StepItem } from './ui/pipelineTree';

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('releasepilot');
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const store = new FileStateStore(path.join(storageDir, 'workflow-state.json'));

  const output = vscode.window.createOutputChannel('ReleasePilot');
  context.subscriptions.push(output);

  const persisted = store.load();
  const logger = new Logger(cfg().get<number>('logRetentionEntries', 2000), persisted?.logs ?? []);
  logger.addSink(e => output.appendLine(`${e.at} [${e.level.toUpperCase()}] ${e.scope}: ${e.message}`));

  // Slice 1 ships no executors: real Salesforce integrations arrive in later slices.
  // Steps therefore cannot be "run" and can never show a fabricated success.
  const engine = new WorkflowEngine({
    store,
    logger,
    executors: {},
    canExecute: () => vscode.workspace.isTrusted
      ? { allowed: true }
      : { allowed: false, reason: 'Running workflow steps requires a trusted workspace.' },
    stepTimeoutMs: cfg().get<number>('stepTimeoutMinutes', 60) * 60_000
  });
  logger.log('info', 'extension', 'ReleasePilot activated.');

  const tree = new PipelineTree(engine);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('releasepilot.pipeline', tree));

  const notifyRefusal = (res: { ok: boolean; message?: string }) => {
    if (!res.ok && res.message) {
      void vscode.window.showWarningMessage(`ReleasePilot: ${res.message}`);
    }
  };

  const handleAction = async (msg: WebviewMessage): Promise<void> => {
    switch (msg.type) {
      case 'run':
      case 'retry':
        notifyRefusal(await engine.runStep(msg.stepId));
        break;
      case 'resume':
        notifyRefusal(await engine.resume());
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
        tree.refresh();
        break;
      case 'setSetting':
        await cfg().update(msg.key, msg.value, vscode.ConfigurationTarget.Workspace);
        break;
      default:
        break;
    }
  };

  const host = { extensionUri: context.extensionUri, engine, handleAction };
  const stepOf = (item?: StepItem): StepId | undefined => item?.def.id;

  context.subscriptions.push(
    vscode.commands.registerCommand('releasepilot.openDashboard', () => DashboardPanel.show(host)),
    vscode.commands.registerCommand('releasepilot.refresh', () => { tree.refresh(); DashboardPanel.refresh(); }),
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
    vscode.workspace.onDidGrantWorkspaceTrust(() => { tree.refresh(); DashboardPanel.refresh(); })
  );
}

export function deactivate(): void {
  // State is persisted on every transition; nothing to flush.
}
