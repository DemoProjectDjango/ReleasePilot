import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { WorkflowEngine } from '../engine/workflowEngine';
import { parseMessage, WebviewMessage } from './messages';

export interface DashboardHost {
  extensionUri: vscode.Uri;
  engine: WorkflowEngine;
  handleAction(msg: WebviewMessage): Promise<void>;
  /** Additional view-model data (discovery, retrieval, busy state). */
  extra(): Record<string, unknown>;
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(host: DashboardHost): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(host.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('releasepilot.dashboard', 'ReleasePilot', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot]
    });
    DashboardPanel.current = new DashboardPanel(panel, host);
  }

  static refresh(): void {
    DashboardPanel.current?.post();
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: DashboardHost) {
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage(async raw => {
      const msg = parseMessage(raw);
      if (!msg) {
        return;
      }
      if (msg.type === 'ready') {
        this.post();
        return;
      }
      await host.handleAction(msg);
      this.post();
    }, null, this.disposables);
    this.disposables.push({ dispose: host.engine.onChange(() => this.post()) });
    panel.onDidDispose(() => {
      DashboardPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);
  }

  private post(): void {
    const engine = this.host.engine;
    const cfg = vscode.workspace.getConfiguration('releasepilot');
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath }));
    void this.panel.webview.postMessage({
      type: 'state',
      ...this.host.extra(),
      state: engine.getState(),
      definitions: engine.getDefinitions().map(d => ({ ...d, hasExecutor: engine.hasExecutor(d.id) })),
      workspace: { trusted: vscode.workspace.isTrusted, folders },
      settings: {
        coverageTargetPercent: cfg.get<number>('coverageTargetPercent', 80),
        logRetentionEntries: cfg.get<number>('logRetentionEntries', 2000),
        stepTimeoutMinutes: cfg.get<number>('stepTimeoutMinutes', 60),
        allowDirtySource: cfg.get<boolean>('allowDirtySource', false)
      }
    });
  }

  private html(): string {
    const web = this.panel.webview;
    const media = (f: string) => web.asWebviewUri(vscode.Uri.joinPath(this.host.extensionUri, 'media', f));
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `style-src ${web.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${web.cspSource}`,
      `img-src ${web.cspSource} data:`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('dashboard.css')}">
<title>ReleasePilot</title>
</head>
<body>
<div id="app" role="application" aria-label="ReleasePilot dashboard"></div>
<script nonce="${nonce}" src="${media('dashboard.js')}"></script>
</body>
</html>`;
  }
}
