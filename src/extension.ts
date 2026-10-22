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
import { StepId, StepStatus } from './core/models';
import { DiscoveryService } from './discovery/discoveryService';
import { RetrievalService } from './discovery/retrieval';
import { FileStateStore } from './engine/stateStore';
import { WorkflowEngine } from './engine/workflowEngine';
import { createExecutors } from './executors/executors';
import { QualitySettings, createQualityExecutors } from './executors/quality';
import { PackagingSettings, createPackagingExecutors } from './executors/packaging';
import { ReportWriter } from './executors/reportWriter';
import { abortableSleep, fetchRequest, fetchVersionReport } from './packaging/build';
import { PackagingStore } from './packaging/store';
import { QaSettings, createQaExecutors, summary as qaSummary } from './executors/qa';
import { deleteScratch, listScratchOrgs, openOrg } from './qa/ops';
import { validateScratchDefinition } from './qa/scratchDef';
import { signOffBlockers } from './qa/signoff';
import { QaStore } from './qa/store';
import { buildSetup, setupCommand } from './discovery/setup';
import { findInReports, pickAnalysis } from './testing/analysisView';
import { runCodeAnalyzer } from './analysis/analyzer';
import { ApprovalToken, createReleaseExecutors } from './executors/release';
import { installLinks, nextSteps } from './release/promote';
import { ReleaseStore } from './release/store';
import { TestLevel, evaluateApex, runApexTests } from './testing/apex';
import { QualityStore } from './testing/qualityStore';
import { buildSummaryMarkdown } from './testing/summary';
import { DashboardPanel } from './ui/dashboardPanel';
import { WebviewMessage } from './ui/messages';
import { PipelineTree, StepItem } from './ui/pipelineTree';
import { RecentProject, addRecent, projectChoices, projectKey, samePath } from './ui/projects';

const FIX_SCHEME = 'releasepilot-fix';

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('releasepilot');
  const baseStorage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const output = vscode.window.createOutputChannel('ReleasePilot');
  context.subscriptions.push(output);

  // Adapters are shared. Everything that holds per-project state lives in a "session" that is rebuilt (with its own
  // storage folder) whenever the active project changes, so two projects can never mix run state, reports or approvals.
  const runner = new NodeProcessRunner();
  const history = new CommandHistory();
  const sf = new SfCli(runner, history, resolveSfLauncher());
  const git = new GitAdapter(runner, history);

  let reportsDir = '';
  let reports!: ReportWriter;
  let quality!: QualityStore;
  let triage!: TriageStore;
  let packaging!: PackagingStore;
  let qa!: QaStore;
  let release!: ReleaseStore;
  let logger!: Logger;
  let discovery!: DiscoveryService;
  let retrieval!: RetrievalService;
  let engine!: WorkflowEngine;
  /** One-shot approval captured from a typed confirmation; it is consumed by the promotion step. */
  let approval: ApprovalToken | undefined;

  const folders = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const approvedProjects = () => context.globalState.get<string[]>('releasepilot.approvedProjects', []);
  /** The project chosen last time, if it still exists and is either an open workspace folder or one you explicitly trusted. */
  const initialRoot = (): string | undefined => {
    const saved = context.workspaceState.get<string>('releasepilot.root');
    if (saved && fs.existsSync(saved) && (folders().some(f => samePath(f, saved)) || approvedProjects().some(p => samePath(p, saved)))) {
      return saved;
    }
    return folders()[0];
  };
  let activeRoot: string | undefined = initialRoot();
  const getRoot = (): string | undefined => activeRoot;
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

  const packagingSettings = (): PackagingSettings => ({
    pollSeconds: cfg().get<number>('buildPollSeconds', 15),
    buildWaitMinutes: cfg().get<number>('buildWaitMinutes', 90),
    installationKeyPolicy: cfg().get<'require' | 'allow-bypass'>('installationKeyPolicy', 'require')
  });

  /** Asks for the installation key without storing it; empty means bypass only if policy allows and the user confirms. */
  const askInstallationKey = async (policy: PackagingSettings['installationKeyPolicy']): Promise<{ key?: string; bypass?: boolean } | undefined> => {
    const key = await vscode.window.showInputBox({
      title: 'Installation key for the new package version',
      prompt: policy === 'require'
        ? 'An installation key is required by policy. It is passed to the Salesforce CLI and never stored by ReleasePilot.'
        : 'Enter an installation key, or leave empty to create the version WITHOUT one (you will be asked to confirm).',
      password: true,
      ignoreFocusOut: true,
      validateInput: v => v && !/^[^\s\u0000-\u001f]{1,100}$/.test(v)
        ? 'Use 1-100 characters without spaces.'
        : (policy === 'require' && !v ? 'An installation key is required by policy.' : undefined)
    });
    if (key === undefined) {
      return undefined;
    }
    if (key) {
      return { key };
    }
    return (await confirmRemote('Create the package version WITHOUT an installation key?',
      'Anyone who has the install link for this beta version will be able to install it.')) ? { bypass: true } : undefined;
  };

  const qaSettings = (): QaSettings => ({
    definitionFile: cfg().get<string>('scratchDefinitionFile', 'config/project-scratch-def.json'),
    durationDays: cfg().get<number>('qaOrgDurationDays', 7),
    waitMinutes: cfg().get<number>('qaWaitMinutes', 30),
    pollSeconds: cfg().get<number>('buildPollSeconds', 15),
    securityType: cfg().get<'AdminsOnly' | 'AllUsers'>('qaSecurityType', 'AdminsOnly'),
    permissionSets: cfg().get<string[]>('qaPermissionSets', []),
    initScripts: cfg().get<string[]>('qaInitScripts', []),
    smokeScripts: cfg().get<string[]>('qaSmokeScripts', []),
    seedScripts: cfg().get<string[]>('upgradeSeedScripts', []),
    regressionScripts: cfg().get<string[]>('upgradeRegressionScripts', []),
    openOrgAfterInstall: cfg().get<boolean>('openOrgAfterInstall', true),
    checklist: cfg().get<string[]>('qaChecklist', []),
    upgradeChecklist: cfg().get<string[]>('upgradeChecklist', []),
    aliasPrefix: cfg().get<string>('qaAliasPrefix', 'rp')
  });

  const askQaKey = async (label: string): Promise<{ key?: string } | undefined> => {
    const key = await vscode.window.showInputBox({
      title: `Installation key for the ${label}`, prompt: 'Needed to install this package version into the QA org. Passed to the Salesforce CLI, never stored.',
      password: true, ignoreFocusOut: true,
      validateInput: v => (v && !/^[^\s\u0000-\u001f]{1,100}$/.test(v) ? 'Use 1-100 characters without spaces.' : (!v ? 'Enter the installation key.' : undefined))
    });
    return key ? { key } : undefined;
  };

  const LEGACY_FILES = ['workflow-state.json', 'quality-state.json', 'triage.json', 'packaging.json', 'qa.json', 'release.json'];
  /** Earlier versions kept one set of files per workspace; adopt them for the first workspace folder, once. */
  const migrateLegacy = (dir: string, root: string) => {
    try {
      const first = folders()[0];
      if (fs.existsSync(dir) || !first || !samePath(first, root) || !fs.existsSync(path.join(baseStorage, LEGACY_FILES[0]))) {
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      for (const f of LEGACY_FILES) {
        const src = path.join(baseStorage, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(dir, f));
        }
      }
    } catch {
      // best effort: a failed migration just starts the project fresh
    }
  };

  let tree: PipelineTree | undefined;

  const openSession = (root: string | undefined): void => {
    const dir = path.join(baseStorage, 'projects', root ? projectKey(root) : '_none');
    if (root) {
      migrateLegacy(dir, root);
    }
    reportsDir = path.join(dir, 'reports');
    const store = new FileStateStore(path.join(dir, 'workflow-state.json'));
    reports = new ReportWriter(reportsDir);
    quality = new QualityStore(path.join(dir, 'quality-state.json'));
    triage = new TriageStore(path.join(dir, 'triage.json'));
    packaging = new PackagingStore(path.join(dir, 'packaging.json'));
    qa = new QaStore(path.join(dir, 'qa.json'));
    release = new ReleaseStore(path.join(dir, 'release.json'));
    approval = undefined;
    const persisted = store.load();
    logger = new Logger(cfg().get<number>('logRetentionEntries', 2000), persisted?.logs ?? []);
    logger.addSink(e => output.appendLine(`${e.at} [${e.level.toUpperCase()}] ${e.scope}: ${e.message}`));
    discovery = new DiscoveryService(sf, git);
    retrieval = new RetrievalService(sf, git);

    const self: WorkflowEngine = new WorkflowEngine({
      store,
      logger,
      executors: {
        ...createExecutors({ discovery, reports, getRoot, allowDirtySource: () => cfg().get<boolean>('allowDirtySource', false) }),
        ...createQualityExecutors({
          sf, runner, discovery, reports, reportsDir, quality, triage, getRoot,
          settings: qualitySettings, git: r => git.snapshot(r), confirm: confirmRemote
        }),
        ...createPackagingExecutors({
          sf, discovery, reports, store: packaging, quality, getRoot, git: r => git.snapshot(r),
          allowDirty: () => cfg().get<boolean>('allowDirtySource', false),
          stepStatus: (id: StepId): StepStatus => self.getState().run.steps[id].status,
          confirm: confirmRemote, askInstallationKey, settings: packagingSettings, sleep: abortableSleep
        }),
        ...createQaExecutors({
          sf, discovery, reports, qa, packaging, getRoot, git: r => git.snapshot(r), settings: qaSettings,
          confirm: confirmRemote, askKey: askQaKey, sleep: abortableSleep
        }),
        ...createReleaseExecutors({
          sf, discovery, reports, reportsDir, quality, packaging, qa, release, triage, getRoot, git: r => git.snapshot(r),
          steps: () => self.getState().run.steps,
          settings: () => ({ severityGate: qualitySettings().severityGate, coverageTarget: qualitySettings().coverageTargetPercent, allowDirty: cfg().get<boolean>('allowDirtySource', false) }),
          takeApproval: () => { const a = approval; approval = undefined; return a; }
        })
      },
      canExecute: () => trusted() ? { allowed: true } : { allowed: false, reason: 'Running workflow steps requires a trusted workspace.' },
      stepTimeoutMs: cfg().get<number>('stepTimeoutMinutes', 60) * 60_000
    });
    engine = self;
    logger.log('info', 'extension', `ReleasePilot session for ${root ?? '(no project)'}. Salesforce CLI ${sf.available ? 'found' : 'NOT found'}.`);

    if (tree) {
      tree.bind(engine);
    } else {
      tree = new PipelineTree(engine);
      context.subscriptions.push(vscode.window.registerTreeDataProvider('releasepilot.pipeline', tree));
    }
  };
  openSession(activeRoot);

  // Read-only virtual documents used to show the proposed side of a fix diff.
  const proposed = new Map<string, string>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(FIX_SCHEME, {
    provideTextDocumentContent: uri => proposed.get(uri.toString()) ?? ''
  }));

  // ---- view model --------------------------------------------------------
  let busy: string | undefined;
  let notice: { level: 'info' | 'error'; text: string } | undefined;
  let lastFingerprint: string | undefined;
  const refreshUi = () => { tree?.refresh(); DashboardPanel.refresh(); };

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
    const shown = pickAnalysis(q);
    return {
      analysis: shown.report && {
        ...shown.report,
        adHoc: shown.adHoc,
        findings: shown.report.findings.slice(0, 3000).map(f => ({ ...f, absFile: undefined, triaged: triaged.has(f.key) })),
        truncated: shown.report.findings.length > 3000,
        blockers: gateBlockers(shown.report.findings, settings.severityGate, triaged).length,
        outdated: outdated(shown.report.sourceFingerprint)
      },
      apex: q.apex && { ...q.apex, outdated: outdated(q.apex.sourceFingerprint), gate: evaluateApex(q.apex, settings.coverageTargetPercent) },
      lwc: q.lwc,
      rerun: q.rerun,
      triage: triage.list(),
      gate: settings.severityGate,
      coverageTarget: settings.coverageTargetPercent
    };
  };

  const packagingView = () => {
    const snap = discovery.snapshot;
    const pkgId = snap.selectedPackage?.id;
    const all = packaging.candidates().filter(c => !pkgId || c.packageId === pkgId);
    return { candidates: all.slice(0, 20), readiness: packaging.readiness(), devHub: snap.devHub && { alias: snap.devHub.alias, username: snap.devHub.username, orgId: snap.devHub.orgId },
      package: snap.selectedPackage, versionNumber: snap.project?.packageDirectories.find(p => p.packageId && p.packageId === pkgId)?.versionNumber };
  };

  const releaseView = () => {
    const report = release.lastReport();
    const versionId = report?.candidate?.versionId;
    const promo = versionId ? release.promotion(versionId) : undefined;
    const released = promo?.status === 'released';
    return {
      report, history: release.history().slice(0, 30), promotion: promo,
      nextSteps: released && versionId ? nextSteps(versionId, report?.candidate?.keyMode === 'key') : [],
      links: released && versionId ? installLinks(versionId) : undefined
    };
  };

  const qaView = () => {
    const root = getRoot();
    const hubId = discovery.snapshot.devHub?.orgId;
    const envs = qa.list().filter(e => !hubId || e.devHubOrgId === hubId).slice(0, 8).map(e => ({ ...qaSummary(e), checklist: e.checklist, signoff: e.signoff, logRefs: e.logRefs, installRequestId: e.installRequestId }));
    return { envs, definition: root ? validateScratchDefinition(root, qaSettings().definitionFile).checks : [], definitionFile: qaSettings().definitionFile };
  };

  const view = () => ({
    discovery: discovery.snapshot,
    retrieval: retrieval.lastPreview,
    quality: qualityView(),
    packaging: packagingView(),
    qa: qaView(),
    setup: buildSetup(discovery.snapshot),
    release: releaseView(),
    busy,
    notice,
    selectedRoot: getRoot(),
    projects: { items: projectChoices(folders(), context.globalState.get<RecentProject[]>('releasepilot.recent', []), p => fs.existsSync(p)) },
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
    [q.analysis?.jsonPath, q.analysis?.htmlPath, q.quick?.jsonPath, q.quick?.htmlPath, q.apex?.rawPath, q.lwc?.rawPath, q.rerun?.rawPath].forEach(r => r && refs.add(r));
    return refs;
  };
  const isInside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const findFinding = (key: string) => findInReports(quality.get(), key)?.finding;

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
    const hit = findInReports(quality.get(), key);
    const q = hit?.report;
    const f = hit?.finding;
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

  const switchProject = async (target: string): Promise<void> => {
    if (busy || Object.values(engine.getState().run.steps).some(st => st.status === 'running')) {
      notice = { level: 'error', text: 'Finish or cancel the running operation before switching projects.' };
      refreshUi();
      return;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(target).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      notice = { level: 'error', text: `${target} no longer exists.` };
      refreshUi();
      return;
    }
    const approved = approvedProjects();
    if (!folders().some(f => samePath(f, target)) && !approved.some(p => samePath(p, target))) {
      const pick = await vscode.window.showWarningMessage(`Work in ${target}?`, {
        modal: true,
        detail: "This folder is outside your open VS Code workspace, so Workspace Trust does not cover it. ReleasePilot will read its files and run the Salesforce CLI, Git and the project's own tooling (for example Jest) inside it. Only continue for a project you trust."
      }, 'Trust this folder');
      if (pick !== 'Trust this folder') {
        return;
      }
      await context.globalState.update('releasepilot.approvedProjects', [...approved, target]);
    }
    activeRoot = target;
    await context.workspaceState.update('releasepilot.root', target);
    await context.globalState.update('releasepilot.recent', addRecent(context.globalState.get<RecentProject[]>('releasepilot.recent', []), target, new Date()));
    openSession(target);
    lastFingerprint = undefined;
    notice = undefined;
    DashboardPanel.rebind();
    refreshUi();
    logger.log('info', 'extension', `Switched project to ${target}`);
    await runDiscovery();
  };

  const browseProject = async (): Promise<void> => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open project',
      title: 'Choose the root folder of a Salesforce DX project', defaultUri: activeRoot ? vscode.Uri.file(path.dirname(activeRoot)) : undefined
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) {
      return;
    }
    if (!fs.existsSync(path.join(dir, 'sfdx-project.json'))) {
      notice = { level: 'error', text: `"${dir}" is not a Salesforce DX project (no sfdx-project.json). Choose the project's root folder.` };
      refreshUi();
      return;
    }
    await switchProject(dir);
  };

  const stepOfKind = (k: 'fresh-install' | 'upgrade'): StepId => (k === 'upgrade' ? 'upgrade-qa' : 'clean-install-qa');

  const overrideGate = async (gateId: string) => {
    const report = release.lastReport();
    const gate = report?.gates.find(g => g.id === gateId);
    if (!report?.candidate || !gate || gate.kind !== 'policy' || gate.status !== 'fail') {
      notice = { level: 'error', text: 'Only a failing local policy check can be overridden. Platform rules and required evidence cannot.' };
      return;
    }
    const reason = await vscode.window.showInputBox({
      title: `Override: ${gate.title}`,
      prompt: 'Why is it acceptable to release despite this? (min. 15 characters; recorded with your name, the version and the time, and shown in the report)',
      validateInput: v => (v.trim().length < 15 ? 'Please give a justification of at least 15 characters.' : undefined)
    });
    if (!reason) {
      return;
    }
    release.addOverride({ gateId, versionId: report.candidate.versionId, sourceFingerprint: report.sourceFingerprint ?? '', reason: reason.trim(), owner: os.userInfo().username, at: new Date().toISOString() });
    logger.log('warn', 'release', `Policy override recorded for "${gate.title}" on ${report.candidate.versionId}: ${reason.slice(0, 80)}`);
    engine.markStale('release-review', 'release overrides changed');
    notice = { level: 'info', text: 'Override recorded. Run Release Readiness again to apply it.' };
  };

  const promoteFlow = async () => {
    const root = getRoot();
    const report = release.lastReport();
    const snap = discovery.snapshot;
    const reviewStep = engine.getState().run.steps['release-review'];
    if (!root || !trusted() || !report?.candidate || !snap.devHub || reviewStep.status !== 'passed' || reviewStep.fingerprint !== report.evidenceHash || !report.ready) {
      notice = { level: 'error', text: 'Promotion needs a passed, current Release Readiness review. Run it first.' };
      return;
    }
    const hub = snap.devHub.alias ?? snap.devHub.username;
    const versionId = report.candidate.versionId;
    await withBusy('Promoting package version', async () => {
      // Read-only first: if Salesforce already shows it released, only verify (no approval for a no-op).
      const live = await fetchVersionReport(sf, hub, versionId, { root });
      if (live.isReleased) {
        const res = await engine.runStep('promotion', { approved: true });
        notice = { level: res.ok && res.status === 'passed' ? 'info' : 'error', text: res.ok ? 'The version is already released in Salesforce; verified and recorded without running promote.' : res.message };
        return;
      }
      const lines = [
        `Package: ${report.package.name} (${report.package.id})`,
        `Dev Hub: ${report.devHub.alias} (${report.devHub.orgId})`,
        `Version: ${report.candidate!.version ?? ''}   04t: ${versionId}`,
        `Source: ${(report.sourceFingerprint ?? '').slice(0, 12)}   Evidence: ${report.evidenceHash.slice(0, 12)}`,
        '',
        `Static analysis: ${report.summary.analysis ?? 'n/a'}`,
        `Tests: ${report.summary.tests ?? 'n/a'}`,
        `Org-wide coverage: ${report.summary.coverage ?? 'n/a'}`,
        `Package-version coverage: ${report.summary.packageCoverage ?? 'n/a'}`,
        `QA: signed fresh-install${report.gates.find(g => g.id === 'upgrade-qa')?.status === 'pass' ? ' and upgrade' : ''} checklists`,
        '',
        report.warnings.length ? 'Remaining warnings:' : 'No remaining warnings.',
        ...report.warnings.map(w => `  - ${w}`),
        '',
        'IMPACT: promotion is PERMANENT. The version becomes Released and installable in production orgs; it can never return to beta, and no other beta of this version number can be promoted.'
      ];
      const first = await vscode.window.showWarningMessage(`Promote ${report.package.name} ${report.candidate!.version ?? ''} to Released?`, { modal: true, detail: lines.join('\n') }, 'Continue to confirmation');
      if (first !== 'Continue to confirmation') {
        notice = { level: 'info', text: 'Promotion cancelled. Nothing was changed.' };
        return;
      }
      const typed = await vscode.window.showInputBox({
        title: 'Final confirmation', ignoreFocusOut: true,
        prompt: `Type the package version ID exactly to promote it on ${hub}: ${versionId}`,
        validateInput: v => (v.trim() === versionId ? undefined : 'The ID does not match.')
      });
      if (typed?.trim() !== versionId) {
        notice = { level: 'info', text: 'Promotion cancelled. Nothing was changed.' };
        return;
      }
      approval = { versionId, evidenceHash: report.evidenceHash, approver: os.userInfo().username, at: Date.now() };
      try {
        const res = await engine.runStep('promotion', { approved: true });
        notice = res.ok && res.status === 'passed'
          ? { level: 'info', text: `Salesforce confirms ${versionId} is Released.` }
          : { level: 'error', text: res.ok ? 'Promotion did not complete; see the Errors tab. It is safe to retry: Salesforce is re-queried first.' : res.message };
      } finally {
        approval = undefined;
      }
    });
  };

  const qaMark = async (envId: string, itemId: string, state: 'pass' | 'fail') => {
    const env = qa.get(envId);
    const item = env?.checklist.find(i => i.id === itemId);
    if (!env || !item || env.status !== 'ready' || env.signoff) {
      notice = { level: 'error', text: 'That QA environment is not open for checklist updates.' };
      return;
    }
    const note = await vscode.window.showInputBox({
      title: `${state === 'pass' ? 'Pass' : 'Fail'}: ${item.text}`,
      prompt: state === 'fail' ? 'Describe what failed (required). This is recorded with your name.' : 'Optional note or evidence reference (a ticket, screenshot path...).',
      validateInput: v => (state === 'fail' && v.trim().length < 5 ? 'Please describe the failure.' : undefined)
    });
    if (note === undefined) {
      return;
    }
    item.state = state;
    item.note = note.trim() || undefined;
    item.by = os.userInfo().username;
    item.at = new Date().toISOString();
    qa.save(env);
    logger.log(state === 'fail' ? 'warn' : 'info', 'qa', `Checklist "${item.text}" marked ${state} by ${item.by}`);
    if (state === 'fail') {
      const r = engine.applyManualResult(stepOfKind(env.kind), {
        status: 'failed', message: `Manual QA failed: ${item.text}`,
        failure: { code: 'QA_FAILED', message: item.note ?? 'A manual QA item failed.', remediation: 'Fix the defect, rebuild a candidate and run QA again in a new clean org.' }
      });
      if (!r.ok) {
        notice = { level: 'error', text: r.message };
      }
    }
  };

  const qaSignOff = async (envId: string) => {
    const env = qa.get(envId);
    const root = getRoot();
    if (!env || !root || !trusted() || env.status !== 'ready' || env.signoff) {
      notice = { level: 'error', text: 'That environment cannot be signed off.' };
      return;
    }
    const stepId = stepOfKind(env.kind);
    const blockers = signOffBlockers(env, (await git.snapshot(root)).fingerprint);
    if (blockers.length) {
      notice = { level: 'error', text: `Cannot sign off: ${blockers.join(' ')}` };
      return;
    }
    const approver = await vscode.window.showInputBox({ title: 'QA sign-off: approver name', value: os.userInfo().username, prompt: 'Recorded in the release audit trail.', validateInput: v => (v.trim().length < 2 ? 'Enter a name.' : undefined) });
    if (!approver) {
      return;
    }
    const ok = await confirmRemote(`Sign off ${env.kind === 'upgrade' ? 'upgrade' : 'fresh-install'} QA of ${env.targetVersion ?? env.targetVersionId}?`,
      `Org: ${env.alias} (${env.orgId})\nVersion: ${env.targetVersionId}\nApprover: ${approver.trim()}\nAll ${env.checklist.length} checklist items are marked Pass.\n\nThis records that you personally verified the functionality. It can be revoked only by rebuilding and re-testing.`);
    if (!ok) {
      return;
    }
    const signoff = { approver: approver.trim(), at: new Date().toISOString() };
    const evidence = reports.write('qa-signoff', `Signed QA result (${env.kind}) for ${env.targetVersionId}`, { environment: qaSummary(env), checklist: env.checklist, signoff });
    const res = engine.applyManualResult(stepId, { status: 'passed', evidence: [evidence], message: `Manual QA signed off by ${signoff.approver} for ${env.targetVersionId} in ${env.alias}.` });
    if (res.ok) {
      qa.save({ ...env, signoff });
      logger.log('info', 'qa', `QA signed off by ${signoff.approver} for ${env.targetVersionId}`);
    } else {
      notice = { level: 'error', text: res.message };
    }
  };

  const qaDelete = async (envId: string) => {
    const env = qa.get(envId);
    const root = getRoot();
    if (!env || !root || !trusted() || !env.orgId || env.status === 'deleted') {
      notice = { level: 'error', text: 'There is no live scratch org recorded for that environment.' };
      return;
    }
    await withBusy('Deleting scratch org', async () => {
      // Only an org this extension created, in this Dev Hub, that still exists with the same ID.
      const live = (await listScratchOrgs(sf, { root })).find(o => o.alias === env.alias && o.orgId === env.orgId);
      if (!live || (live.devHubOrgId && live.devHubOrgId !== env.devHubOrgId)) {
        notice = { level: 'info', text: 'That scratch org no longer exists (or is not the one ReleasePilot created). Nothing was deleted.' };
        qa.save({ ...env, status: 'deleted' });
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Permanently delete scratch org ${env.alias}?`,
        { modal: true, detail: `Org: ${env.alias} (${env.orgId}), user ${env.username}\nDev Hub: ${env.devHubAlias} (${env.devHubOrgId})\n\nThe org and everything in it will be lost. Reports and the install log are kept.` }, 'Delete Org');
      if (ok !== 'Delete Org') {
        return;
      }
      await deleteScratch(sf, env.alias, { root });
      qa.save({ ...env, status: 'deleted' });
      logger.log('warn', 'qa', `Deleted scratch org ${env.alias} (${env.orgId}) at the user's request.`);
      notice = { level: 'info', text: `Deleted ${env.alias}.` };
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
      case 'selectFolder': {
        const choice = projectChoices(folders(), context.globalState.get<RecentProject[]>('releasepilot.recent', []), p => fs.existsSync(p)).find(c => samePath(c.path, msg.path));
        if (choice && !(activeRoot && samePath(activeRoot, choice.path))) {
          await switchProject(choice.path);
        }
        break;
      }
      case 'browseProject':
        await browseProject();
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
      case 'refreshBuild': {
        const root = getRoot();
        const hubOrg = discovery.snapshot.devHub;
        const pkgId = discovery.snapshot.selectedPackage?.id;
        const live = pkgId && hubOrg ? packaging.inFlight(pkgId, hubOrg.orgId) : undefined;
        if (!root || !trusted() || !hubOrg || !live) {
          notice = { level: 'info', text: 'There is no in-flight package build to refresh.' };
          break;
        }
        await withBusy('Refreshing build status', async () => {
          const r = await fetchRequest(sf, hubOrg.alias ?? hubOrg.username, live.requestId, { root });
          packaging.upsert({ ...live, status: r.status, errors: r.errors, subscriberPackageVersionId: r.subscriberPackageVersionId ?? live.subscriberPackageVersionId, lastPolledAt: new Date().toISOString() });
          notice = { level: 'info', text: `Request ${live.requestId} is ${r.status}. Run the Create Beta Package step again to finish verification.` };
        });
        break;
      }
      case 'quickScan': {
        const root = getRoot();
        if (!root || !trusted() || !discovery.snapshot.project) {
          notice = { level: 'error', text: !discovery.snapshot.project ? 'Open a Salesforce DX project first.' : 'A trusted workspace is required.' };
          refreshUi();
          break;
        }
        await withBusy('Scanning with Code Analyzer', async () => {
          const report = await runCodeAnalyzer(sf, { root, outputDir: reportsDir, selectors: qualitySettings().ruleSelectors });
          report.sourceFingerprint = (await git.snapshot(root)).fingerprint;
          quality.update({ quick: report });
          logger.log('info', 'analysis', `Quick scan: ${report.counts.total} finding(s), ${report.warnings.length} warning(s). Not release evidence.`);
          notice = { level: report.warnings.length ? 'error' : 'info', text: report.warnings.length
            ? 'Quick scan finished with analyzer warnings, so it may be incomplete. See the Quality page.'
            : `Quick scan finished: ${report.counts.total} finding(s). This is ad hoc and not part of the release evidence.` };
        });
        break;
      }
      case 'openProject': {
        const file = discovery.snapshot.project?.file;
        if (file && fs.existsSync(file)) {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
        }
        break;
      }
      case 'copyCmd': {
        const text = setupCommand(msg.id, discovery.snapshot);
        if (text) {
          await vscode.env.clipboard.writeText(text);
          notice = { level: 'info', text: `Copied to clipboard: ${text}` };
        }
        break;
      }
      case 'overrideGate':
        await overrideGate(msg.gateId);
        break;
      case 'removeOverride': {
        const rep = release.lastReport();
        if (rep?.candidate) {
          release.removeOverride(msg.gateId, rep.candidate.versionId);
          engine.markStale('release-review', 'release overrides changed');
        }
        break;
      }
      case 'promote':
        await promoteFlow();
        break;
      case 'qaMark':
        await qaMark(msg.envId, msg.itemId, msg.state);
        break;
      case 'qaSignOff':
        await qaSignOff(msg.envId);
        break;
      case 'qaDelete':
        await qaDelete(msg.envId);
        break;
      case 'qaOpen': {
        const env = qa.get(msg.envId);
        const root = getRoot();
        if (env && root && trusted() && env.status === 'ready') {
          await withBusy('Opening QA org', () => openOrg(sf, env.alias, { root }));
        }
        break;
      }
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

  const host = { extensionUri: context.extensionUri, get engine() { return engine; }, handleAction, extra: view };
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
