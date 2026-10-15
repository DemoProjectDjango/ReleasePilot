import * as vscode from 'vscode';
import { StepDefinition, StepStatus } from '../core/models';
import { WorkflowEngine } from '../engine/workflowEngine';

export const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', blocked: 'Blocked',
  'needs-review': 'Needs Review', stale: 'Stale', skipped: 'Skipped', cancelled: 'Cancelled'
};

const ICON: Record<StepStatus, vscode.ThemeIcon> = {
  pending: new vscode.ThemeIcon('circle-outline'),
  running: new vscode.ThemeIcon('sync~spin'),
  passed: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
  blocked: new vscode.ThemeIcon('lock'),
  'needs-review': new vscode.ThemeIcon('eye', new vscode.ThemeColor('list.warningForeground')),
  stale: new vscode.ThemeIcon('history', new vscode.ThemeColor('list.warningForeground')),
  skipped: new vscode.ThemeIcon('debug-step-over'),
  cancelled: new vscode.ThemeIcon('circle-slash')
};

export class StepItem extends vscode.TreeItem {
  constructor(readonly def: StepDefinition, status: StepStatus, runnable: boolean, message?: string) {
    super(def.title, vscode.TreeItemCollapsibleState.None);
    this.id = def.id;
    this.description = STATUS_LABEL[status];
    this.iconPath = ICON[status];
    this.tooltip = new vscode.MarkdownString(`**${def.title}** - ${STATUS_LABEL[status]}\n\n${def.description}${message ? `\n\n_${message}_` : ''}`);
    this.contextValue = status === 'running' ? 'step-running'
      : runnable ? (status === 'pending' ? 'step-runnable' : 'step-retryable')
        : 'step-idle';
    this.command = { command: 'releasepilot.openDashboard', title: 'Open Dashboard' };
  }
}

export class PipelineTree implements vscode.TreeDataProvider<StepItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly engine: WorkflowEngine) {
    engine.onChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(el: StepItem): vscode.TreeItem {
    return el;
  }

  getChildren(): StepItem[] {
    const state = this.engine.getState();
    return this.engine.getDefinitions().map(def => {
      const s = state.run.steps[def.id];
      return new StepItem(def, s.status, !this.engine.blockReason(def.id), s.message);
    });
  }
}
