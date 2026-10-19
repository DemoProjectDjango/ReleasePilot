import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandHistory } from './adapters/commandHistory';
import { GitAdapter } from './adapters/git';
import { NodeProcessRunner } from './adapters/processRunner';
import { SfCli, SfError, resolveSfLauncher } from './adapters/sfCli';
import { SeverityGate, applyFix, gateBlockers } from './analysis/analyzer';
import { TriageStore } from './analysis/triage';
import { Logger } from './core/logger';
import { StepId } from './core/models';
import { DiscoveryService } from './discovery/discoveryService';
import { RetrievalService } from './discovery/retrieval';
import { FileStateStore } from './engine/stateStore';
import { WorkflowEngine } from './engine/workflowEngine';
import { createExecutors } from './executors/executors';
import { QualitySettings, createQualityExecutors } from './executors/quality';
import { ReportWriter } from './executors/reportWriter';
import { TestLevel, evaluateApex, runApexTests } from './testing/apex';
import { QualityStore } from './testing/qualityStore';
import { buildSummaryMarkdown } from './testing/summary';
import { DashboardPanel } from './ui/dashboardPanel';
import { WebviewMessage } from './ui/messages';
import { PipelineTree, StepItem } from './ui/pipelineTree';

const FIX_SCHEME = 'releasepilot-fix';

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('releasepilot');
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const reportsDir = path.join(storageDir, 'reports');
  const store = new FileStateStore(path.join(storageDir, 'workflow-state.json'));
  const reports = new ReportWriter(reportsDir);
  const quality = new QualityStore(path.join(storageDir, 'quality-state.json'));
  const triage = new TriageStore(path.join(storageDir, 'triage.json'));

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

  const qualitySettings = (): QualitySettings => ({
    ruleSelectors: cfg().get<string[]>('ruleSelectors', ['Recommended']),
    severityGate: cfg().get<SeverityGate>('severityGate', 'high'),
    testLevel: cfg().get<TestLevel>('testLevel', 'RunLocalTests'),
    deployBeforeTests: cfg().get<boolean>('deployBeforeTests', true),
    waitMinutes: cfg().get<number>('testWaitMinutes', 60),
    coverageTargetPercent: cfg().get<number>('coverageTargetPercent', 80)
  });

  const confirmRemote = async (title: string, detail: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Continue')) === 'Continue';

  const engine = new WorkflowEngine({
    store,
    logger,
    executors: {
      ...createExecutors({ discovery, reports, getRoot, allowDirtySource: () => cfg().get<boolean>('allowDirtySource', false) }),
      ...createQualityExecutors({
        sf, runner, discovery, reports, reportsDir, quality, triage, getRoot,
        settings: qualitySettings, git: root => git.snapshot(root), confirm: confirmRemote
      })
    },
    canExecute: () => trusted() ? { allowed: true } : { allowed: false, reason: 'Running workflow steps requires a trusted workspace.' },
    stepTimeoutMs: cfg().get<number>('stepTimeoutMinutes', 60) * 60_000
  });
  logger.log('info', 'extension', `ReleasePilot activated. Salesforce CLI ${sf.available ? 'found' : 'NOT found'}.`);

  const tree = new PipelineTree(engine);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('releasepilot.pipeline', tree));

  // Read-only virtual documents used to show the proposed side of a fix diff.
  const proposed = new Map<string, string>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(FIX_SCHEME, {
    provideTextDocumentContent: uri => proposed.get(uri.toString()) ?? ''
  }));

  // ---- view model --------------------------------------------------------
  let busy: string | undefined;
  let notice: { level: 'info' | 'error'; text: string } | undefined;
  let lastFingerprint: string | undefined;
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

  const qualityView = () => {
    const q = quality.get();
    const settings = qualitySettings();
    const triaged = triage.keys();
    const outdated = (fp?: string) => !!fp && !!lastFingerprint && fp !== lastFingerprint;
    return {
      analysis: q.analysis && {
        ...q.analysis,
        findings: q.analysis.findings.slice(0, 3000).map(f => ({ ...f, absFile: undefined, triaged: triaged.has(f.key) })),
        truncated: q.analysis.findings.length > 3000,
        blockers: gateBlockers(q.analysis.findings, settings.severityGate, triaged).length,
        outdated: outdated(q.analysis.sourceFingerprint)
      },
      apex: q.apex && { ...q.apex, outdated: outdated(q.apex.sourceFingerprint), gate: evaluateApex(q.apex, settings.coverageTargetPercent) },
      lwc: q.lwc,
      rerun: q.rerun,
      triage: triage.list(),
      gate: settings.severityGate,
      coverageTarget: settings.coverageTargetPercent
    };
  };

  const view = () => ({
    discovery: discovery.snapshot,
    retrieval: retrieval.lastPreview,
    quality: qualityView(),
    busy,
    notice,
    selectedRoot: getRoot(),
    cliAvailable: sf.available
  });

  // ---- source-freshness monitor (FR-09 / NFR-06) -------------------------
  let monitorTimer: NodeJS.Timeout | undefined;
  const checkFreshness = async () => {
    const root = getRoot();
    if (!root || !trusted() || busy) {
      return;
    }
    const snap = await git.snapshot(root);
    lastFingerprint = snap.fingerprint ?? lastFingerprint;
    const source = engine.getState().run.steps.source;
    if (snap.fingerprint && source.fingerprint && source.status !== 'stale' && snap.fingerprint !== source.fingerprint) {
      engine.markStale('source', 'local source changed after the snapshot was taken');
    }
    DashboardPanel.refresh();
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
      lastFingerprint = snap.git?.fingerprint ?? lastFingerprint;
      if (before && snap.devHub?.orgId !== before) {
        engine.markStale('preflight', 'the selected Dev Hub changed');
      }
    });
  };

  // ---- helpers for quality actions ----------------------------------------
  const knownRefs = (): Set<string> => {
    const refs = new Set<string>();
    const st = engine.getState();
    Object.values(st.run.steps).forEach(s => s.evidence.forEach(e => refs.add(e.ref)));
    (st.artifacts ?? []).forEach(e => refs.add(e.ref));
    const q = quality.get();
    [q.analysis?.jsonPath, q.analysis?.htmlPath, q.apex?.rawPath, q.lwc?.rawPath, q.rerun?.rawPath].forEach(r => r && refs.add(r));
    return refs;
  };
  const isInside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const findFinding = (key: string) => quality.get().analysis?.findings.find(f => f.key === key);

  const openFinding = async (key: string) => {
    const root = getRoot();
    const f = findFinding(key);
    if (!root || !f || !f.absFile || !isInside(root, f.absFile) || !fs.existsSync(f.absFile)) {
      notice = { level: 'error', text: 'That file is not available in the current project. Rescan to refresh the findings.' };
      refreshUi();
      return;
    }
    const doc = await vscode.workspace.openTextDocument(f.absFile);
    const pos = new vscode.Position(Math.max(f.line - 1, 0), Math.max(f.column - 1, 0));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
  };

  const openReport = async (ref: string) => {
    if (!knownRefs().has(ref) || !fs.existsSync(ref)) {
      notice = { level: 'error', text: 'That report is not a known ReleasePilot artifact.' };
      refreshUi();
      return;
    }
    if (/\.html?$/i.test(ref)) {
      await vscode.env.openExternal(vscode.Uri.file(ref));
    } else {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(ref), { preview: true });
    }
  };

  const exportTo = async (suggested: string, write: (dest: string) => void) => {
    const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(getRoot() ?? os.homedir(), suggested)), saveLabel: 'Export' });
    if (dest) {
      write(dest.fsPath);
      notice = { level: 'info', text: `Exported to ${dest.fsPath}` };
    }
  };

  const triageFinding = async (key: string) => {
    const f = findFinding(key);
    if (!f) {
      return;
    }
    const reason = await vscode.window.showInputBox({
      title: `Triage ${f.rule} in ${f.file}:${f.line}`,
      prompt: 'Why is this a false positive or accepted risk? (min. 10 characters; recorded with your name and the time)',
      validateInput: v => (v.trim().length < 10 ? 'Please give a justification of at least 10 characters.' : undefined)
    });
    if (reason) {
      triage.add(key, reason, os.userInfo().username);
      logger.log('warn', 'analysis', `Finding triaged: ${f.rule} ${f.file}:${f.line} (${reason.slice(0, 80)})`);
      engine.markStale('analysis', 'triage decisions changed');
    }
  };

  const reviewAndApplyFix = async (key: string) => {
    const root = getRoot();
    const q = quality.get().analysis;
    const f = findFinding(key);
    if (!root || !q || !f?.fix || !f.absFile || !isInside(root, f.absFile)) {
      notice = { level: 'error', text: 'No applicable analyzer fix is available for that finding.' };
      return;
    }
    const current = await git.snapshot(root);
    if (current.fingerprint !== q.sourceFingerprint) {
      notice = { level: 'error', text: 'The source changed since the scan. Rescan before applying fixes.' };
      return;
    }
    const uri = vscode.Uri.file(f.absFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    let next: string;
    try {
      next = applyFix(doc.getText(), f.fix);
    } catch (e) {
      notice = { level: 'error', text: e instanceof Error ? e.message : String(e) };
      return;
    }
    const left = uri;
    const right = vscode.Uri.parse(`${FIX_SCHEME}:/${path.basename(f.absFile)}?${encodeURIComponent(key)}`);
    proposed.set(right.toString(), next);
    await vscode.commands.executeCommand('vscode.diff', left, right, `Proposed fix: ${f.rule} (${f.file}:${f.line})`);
    const pick = await vscode.window.showWarningMessage(
      `Apply the analyzer's suggested fix for ${f.rule}?`,
      { modal: true, detail: `${f.message}\n\nReview the diff first. Fixes can change behaviour, especially for security rules; rescan and re-run tests afterwards.` },
      'Apply Fix');
    proposed.delete(right.toString());
    if (pick !== 'Apply Fix') {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
    if (await vscode.workspace.applyEdit(edit)) {
      await doc.save();
      logger.log('warn', 'analysis', `Applied analyzer fix for ${f.rule} at ${f.file}:${f.line}.`);
      notice = { level: 'info', text: 'Fix applied. Rescan to confirm; earlier results are now stale.' };
      scheduleFreshness();
    }
  };

  const rerunFailedTests = async () => {
    const root = getRoot();
    const org = discovery.snapshot.validationOrg;
    const apex = quality.get().apex;
    const failedNames = (apex?.tests ?? []).filter(t => t.outcome !== 'Pass' && t.outcome !== 'Skip').map(t => t.fullName);
    if (!root || !trusted() || !org || !failedNames.length) {
      notice = { level: 'error', text: !org ? 'Select a validation org first.' : 'There are no failed tests to rerun.' };
      refreshUi();
      return;
    }
    if (discovery.snapshot.devHub?.orgId === org.orgId) {
      notice = { level: 'error', text: 'The validation org must not be the Dev Hub.' };
      refreshUi();
      return;
    }
    const label = `${org.alias ?? org.username} (${org.orgId})`;
    if (!await confirmRemote(`Rerun ${failedNames.length} failed test(s) in ${label}?`,
      'Only the failed tests run, using whatever source is currently in that org. This is informational: the Pre-package Tests step must still pass as a full run.')) {
      return;
    }
    await withBusy('Re-running failed tests', async () => {
      const rerun = await runApexTests(sf, {
        root, org: org.alias ?? org.username, orgLabel: label, level: 'RunSpecifiedTests', tests: failedNames,
        waitMinutes: qualitySettings().waitMinutes, outputDir: reportsDir, deployedLocalSource: false, signal: undefined
      });
      quality.update({ rerun });
      engine.addArtifact(reports.write('apex-rerun', `Rerun of ${failedNames.length} failed test(s)`, { org: label, failedBefore: failedNames, result: { total: rerun.total, passed: rerun.passed, failed: rerun.failed } }));
      notice = { level: rerun.failed ? 'error' : 'info', text: `Rerun finished: ${rerun.passed}/${rerun.total} passed. Run the Pre-package Tests step again for a full, gate-eligible result.` };
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
      case 'selectPackage':
      case 'selectValidationOrg': {
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
          } else if (msg.type === 'selectValidationOrg') {
            await discovery.selectValidationOrg(value);
            engine.markStale('tests', 'the validation org changed');
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
          engine.addArtifact(reports.write('retrieve-preview', `Retrieve preview from ${out.orgLabel}`, out));
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
      case 'openFile':
        await openFinding(msg.key);
        break;
      case 'openReport':
        await openReport(msg.ref);
        break;
      case 'exportReport':
        if (knownRefs().has(msg.ref) && fs.existsSync(msg.ref)) {
          await exportTo(path.basename(msg.ref), dest => fs.copyFileSync(msg.ref, dest));
        }
        break;
      case 'exportSummary':
        await exportTo('releasepilot-quality-summary.md', dest => fs.writeFileSync(dest, buildSummaryMarkdown({
          project: getRoot(), generatedAt: new Date().toISOString(), quality: quality.get(), triage: triage.list(),
          gate: qualitySettings().severityGate, coverageTarget: qualitySettings().coverageTargetPercent, steps: engine.getState().run.steps
        }), 'utf8'));
        break;
      case 'triage':
        await triageFinding(msg.key);
        break;
      case 'untriage':
        triage.remove(msg.key);
        engine.markStale('analysis', 'triage decisions changed');
        break;
      case 'applyFix':
        await reviewAndApplyFix(msg.key);
        break;
      case 'rerunFailed':
        await rerunFailedTests();
        break;
      case 'setSetting': {
        const map: Record<string, string> = { testWaitMinutes: 'testWaitMinutes' };
        await cfg().update(map[msg.key] ?? msg.key, msg.value, vscode.ConfigurationTarget.Workspace);
        break;
      }
      default:
        break;
    }
    refreshUi();
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
