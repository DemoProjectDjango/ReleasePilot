/* Preview harness: renders media/dashboard.js outside VS Code with mock data and VS Code theme variables.
 * Usage (headless screenshot):  msedge --headless --screenshot=out.png --window-size=1400,1000 "file:///.../tools/preview/preview.html#tab=quality&theme=dark"
 * Not shipped in the extension (see .vscodeignore). */
(function () {
  const params = new URLSearchParams(location.hash.slice(1));
  const tab = params.get('tab') || 'pipeline';
  const theme = params.get('theme') || 'dark';
  const scenario = params.get('scenario') || 'busy-project';

  const THEMES = {
    dark: {
      'editor-background': '#1e1e1e', foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'panel-border': '#80808059',
      'button-background': '#0e639c', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#3a3d41', 'button-secondaryForeground': '#ffffff',
      focusBorder: '#007fd4', 'input-background': '#3c3c3c', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'dropdown-background': '#3c3c3c',
      'dropdown-foreground': '#f0f0f0', 'dropdown-border': '#3c3c3c', errorForeground: '#f48771', 'editorWarning-foreground': '#cca700',
      'testing-iconPassed': '#73c991', 'testing-iconFailed': '#f14c4c', 'charts-green': '#89d185', 'charts-red': '#f14c4c', 'charts-yellow': '#cca700',
      'charts-blue': '#3794ff', 'charts-orange': '#d18616', 'charts-purple': '#b180d7', 'editor-font-family': 'Consolas, monospace'
    },
    light: {
      'editor-background': '#ffffff', foreground: '#3b3b3b', descriptionForeground: '#717171', 'panel-border': '#c8c8c8',
      'button-background': '#007acc', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#5f6a79', 'button-secondaryForeground': '#ffffff',
      focusBorder: '#0090f1', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece', 'dropdown-background': '#ffffff',
      'dropdown-foreground': '#3b3b3b', 'dropdown-border': '#cecece', errorForeground: '#e51400', 'editorWarning-foreground': '#bf8803',
      'testing-iconPassed': '#388a34', 'testing-iconFailed': '#e51400', 'charts-green': '#388a34', 'charts-red': '#e51400', 'charts-yellow': '#bf8803',
      'charts-blue': '#1a85ff', 'charts-orange': '#d18616', 'charts-purple': '#652d90', 'editor-font-family': 'Consolas, monospace'
    }
  };
  const vars = Object.entries(THEMES[theme]).map(([k, v]) => `--vscode-${k}:${v}`).join(';');
  const style = document.createElement('style');
  style.textContent = `:root{${vars};--vscode-font-family:"Segoe UI",system-ui,sans-serif;--vscode-font-size:13px}`;
  document.head.append(style);

  window.acquireVsCodeApi = () => ({ getState: () => ({ tab }), setState() {}, postMessage(m) { (window.__sent = window.__sent || []).push(m); } });

  const iso = (mins) => new Date(Date.UTC(2026, 9, 22, 10, 0) - mins * 60000).toISOString();
  const ev = (kind, label) => ({ id: kind, kind, label, ref: 'C:\\Users\\dev\\reports\\' + kind + '.json', createdAt: iso(5) });
  const defs = [
    ['preflight', 'Discover & Preflight', 'Verify the Salesforce DX project, CLI tooling, authenticated orgs, Dev Hub and package ownership (read-only).', [], false, false],
    ['source', 'Source Ready', 'Confirm the local Git working tree is the authoritative source and snapshot its fingerprint.', ['preflight'], false, false],
    ['analysis', 'Static Analysis', 'Run Salesforce Code Analyzer and triage findings.', ['source'], false, false],
    ['tests', 'Pre-package Tests', 'Run Apex (and LWC Jest when configured) tests in a validation org and evaluate coverage targets.', ['analysis'], false, false],
    ['package-readiness', 'Package Readiness', 'Validate package ID, Dev Hub, namespace, dependencies, version plan and ancestry.', ['tests'], false, false],
    ['package-build', 'Create Beta Package', 'Create a validated beta package version (08c request, then 04t) with code coverage, tracked to completion.', ['package-readiness'], false, false],
    ['clean-install-qa', 'Clean-install QA', 'Create a clean scratch org, install the exact 04t, assign permissions, smoke test and record manual QA.', ['package-build'], false, false],
    ['upgrade-qa', 'Upgrade QA', 'Existing products only: previous released version to candidate upgrade verification.', ['clean-install-qa'], true, false],
    ['release-review', 'Release Readiness', 'Re-verify every gate against the exact candidate and produce the consolidated readiness report.', ['clean-install-qa', 'upgrade-qa'], false, false],
    ['promotion', 'Approve & Promote', 'Irreversible. Requires explicit confirmation of package, Dev Hub and 04t; verifies Released status afterwards.', ['release-review'], false, true]
  ].map(([id, title, description, dependsOn, optional, requiresApproval]) => ({ id, title, description, dependsOn, optional, requiresApproval, plannedSlice: 1, requirements: ['FR-01', 'FR-02'], hasExecutor: true }));

  const SCENARIOS = {
    'busy-project': { preflight: 'passed', source: 'passed', analysis: 'needs-review', tests: 'pending' },
    'mid-release': { preflight: 'passed', source: 'passed', analysis: 'passed', tests: 'passed', 'package-readiness': 'passed', 'package-build': 'passed', 'clean-install-qa': 'needs-review' },
    'failed-start': { preflight: 'failed' },
    fresh: {}
  };
  const st = SCENARIOS[scenario] || SCENARIOS['busy-project'];
  const steps = {};
  defs.forEach(d => {
    const status = st[d.id] || 'pending';
    steps[d.id] = { id: d.id, status, attempt: status === 'pending' ? 0 : 1, evidence: status === 'pending' ? [] : [ev(d.id + '-report', d.title + ' report')],
      startedAt: iso(30), endedAt: iso(29), message: status === 'passed' ? 'All checks passed.' : undefined };
  });
  steps.analysis.message = '8 finding(s): 0 critical, 2 high, 2 moderate, 4 low. 2 untriaged finding(s) at or above high.';
  steps.analysis.failure = { code: 'ANALYSIS_BLOCKERS', message: '2 finding(s) at or above high severity block the pipeline.', remediation: 'Fix them in source and rescan, or triage each with a justification in the Quality tab.', at: iso(29) };
  steps.analysis.fingerprint = '9f3a1c07b2d84e56aa10';
  if (scenario === 'failed-start') {
    steps.preflight.failure = { code: 'PREFLIGHT_FAILED', message: 'No package directory declares a "package".', remediation: 'Add a "package" and a versionNumber to a packageDirectories entry.', at: iso(1),
      detail: 'Package configuration: No package directory declares a "package". -> Add a "package" and a versionNumber to a packageDirectories entry.\nDev Hub: No Dev Hub org is selected. -> Select an authenticated Dev Hub org in the dashboard.' };
    steps.preflight.message = '2 preflight check(s) failed: Package configuration, Dev Hub.';
  }

  const orgs = [
    { alias: 'acme-devhub', username: 'admin@acme.com', orgId: '00D5g000008XyZaEAK', isDevHub: true, isScratch: false, isSandbox: false, isDefaultDevHub: true, isDefaultOrg: false, expired: false },
    { alias: 'acme-uat', username: 'admin@acme.com.uat', orgId: '00D5g000008AbCdEAK', isDevHub: false, isScratch: false, isSandbox: true, isDefaultDevHub: false, isDefaultOrg: true, expired: false },
    { alias: 'rp-qa-1', username: 'test-x9k@example.com', orgId: '00D5g000009QwErEAK', isDevHub: false, isScratch: true, isSandbox: false, isDefaultDevHub: false, isDefaultOrg: false, expired: false },
    { username: 'old@acme.com', orgId: '00D5g000001OldEEAK', isDevHub: false, isScratch: false, isSandbox: false, isDefaultDevHub: false, isDefaultOrg: false, expired: true }
  ];
  const findings = [
    ['ApexSOQLInjection', 'pmd', 2, 'High', 'force-app/main/default/classes/MassDeleter.cls', 18, 'Avoid unescaped user controlled content in dynamic SOQL.'],
    ['EmptyCatchBlock', 'pmd', 2, 'High', 'force-app/main/default/classes/MassDeleter.cls', 24, 'Avoid empty catch blocks.'],
    ['ApexSharingViolations', 'pmd', 3, 'Moderate', 'force-app/main/default/classes/MassDeleter.cls', 1, 'Apex classes should declare a sharing model if DML or SOQL/SOSL is used.'],
    ['UnusedLocalVariable', 'pmd', 3, 'Moderate', 'force-app/main/default/classes/MassDeleter.cls', 20, 'Variable is declared but not used.'],
    ['ApexDoc', 'pmd', 4, 'Low', 'force-app/main/default/classes/MassDeleter.cls', 1, 'Missing ApexDoc comment.'],
    ['AvoidDebugStatements', 'pmd', 4, 'Low', 'force-app/main/default/classes/Helper.cls', 9, 'Avoid debug statements.']
  ].map(([rule, engine, severity, severityLabel, file, line, message], i) => ({ key: rule + i, rule, engine, severity, severityLabel, file, line, column: 3, message, tags: [], resources: [], suggestions: [], triaged: i === 3 }));

  const state = {
    type: 'state', busy: scenario === 'busy-project' ? undefined : undefined, notice: scenario === 'failed-start' ? { level: 'error', text: 'Discovery runs external tools and requires a trusted workspace.' } : undefined,
    cliAvailable: true, selectedRoot: 'D:\\Product\\Mass_Delete',
    workspace: { trusted: true, folders: [{ name: 'Mass_Delete', path: 'D:\\Product\\Mass_Delete' }] },
    definitions: defs,
    state: { schemaVersion: 1, run: { id: '492608a7-1111-2222-3333-444444444444', startedAt: iso(60), steps }, history: [{ id: 'aa11bb22cc33', startedAt: iso(9000), endedAt: iso(8900), passedSteps: ['preflight', 'source', 'analysis'], outcome: { failed: 1 } }],
      artifacts: [ev('retrieve-preview', 'Retrieve preview from acme-uat')],
      logs: [
        { at: iso(3), level: 'info', scope: 'engine', message: 'Started Static Analysis (attempt 1)' },
        { at: iso(2), level: 'warn', scope: 'analysis', message: 'Code Analyzer printed 1 warning block(s); the scan may be incomplete.' },
        { at: iso(1), level: 'error', scope: 'extension', message: 'Rerun failed: The validation org must not be the Dev Hub.' },
        { at: iso(1), level: 'info', scope: 'engine', message: 'Static Analysis finished: needs-review' }
      ] },
    settings: { coverageTargetPercent: 80, logRetentionEntries: 2000, stepTimeoutMinutes: 60, allowDirtySource: false, deployBeforeTests: true, severityGate: 'high', testLevel: 'RunLocalTests', testWaitMinutes: 60,
      ruleSelectors: ['Recommended'], installationKeyPolicy: 'require', buildWaitMinutes: 90, buildPollSeconds: 15, qaOrgDurationDays: 7, qaWaitMinutes: 30, qaSecurityType: 'AdminsOnly', openOrgAfterInstall: true },
    discovery: {
      root: 'D:\\Product\\Mass_Delete', discoveredAt: iso(2), orgs, devHub: scenario === 'failed-start' ? undefined : orgs[0], devOrg: orgs[1], validationOrg: orgs[2],
      project: { root: 'D:\\Product\\Mass_Delete', sourceApiVersion: '67.0', namespace: 'acme', warnings: scenario === 'failed-start' ? ['No package directory declares a "package": this project is not configured for 2GP packaging.'] : [],
        packageDirectories: [{ path: 'force-app', exists: true, package: scenario === 'failed-start' ? undefined : 'MassDelete', packageId: scenario === 'failed-start' ? undefined : '0Ho5g000000ABCDCA0', versionNumber: '1.3.0.NEXT', ancestorId: 'HIGHEST', dependencies: [] }] },
      tooling: { sf: '@salesforce/cli/2.150.6 win32-x64 node-v24.11.1', node: 'v24.11.1', codeAnalyzer: { name: 'code-analyzer', version: '5.15.0' } },
      git: { isRepo: true, version: 'git version 2.52.0', branch: 'main', head: '0abec4b1c2d3', files: [{ path: 'a.cls', status: ' M' }], fingerprint: '44136fa355b3678a99' },
      packages: [{ id: '0Ho5g000000ABCDCA0', name: 'MassDelete', namespacePrefix: 'acme' }, { id: '0Ho5g000000EFGHCA0', name: 'Other', namespacePrefix: 'oth' }],
      selectedPackage: { id: '0Ho5g000000ABCDCA0', name: 'MassDelete', namespacePrefix: 'acme' },
      versions: [{ subscriberPackageVersionId: '04t5g000000TgHiAAK', version: '1.2.0.4', branch: 'main', isReleased: true, codeCoverage: '82%', createdDate: iso(20000) }, { subscriberPackageVersionId: '04t5g000000TgHjAAK', version: '1.3.0.1', branch: 'main', isReleased: false, codeCoverage: '80%', createdDate: iso(300) }],
      errors: scenario === 'failed-start' ? [{ scope: 'orgs', code: 'NOT_DEV_HUB', message: '"acme-uat" is not a Dev Hub org.' }] : [],
      commands: [{ at: iso(2), display: 'sf org list --skip-connection-status --json', outcome: 'ok', exitCode: 0, durationMs: 3600 }, { at: iso(2), display: 'git status --porcelain=v1 -z -uall', outcome: 'ok', exitCode: 0, durationMs: 140 }]
    },
    retrieval: undefined,
    quality: {
      gate: 'high', coverageTarget: 80, triage: [{ key: 'UnusedLocalVariable3', owner: 'dev', at: iso(10), reason: 'Variable kept for readability in a debug build.' }],
      analysis: { at: iso(4), selectors: ['Recommended'], versions: { 'code-analyzer': '0.52.0', pmd: '0.45.0' }, jsonPath: 'C:\\reports\\code-analyzer.json', counts: { total: 6, Critical: 0, High: 2, Moderate: 2, Low: 2, Info: 0 }, blockers: 2, outdated: false, truncated: false, warnings: [], findings },
      apex: { at: iso(20), orgLabel: 'rp-qa-1 (00D5g000009QwErEAK)', testLevel: 'RunLocalTests', outcome: 'Failed', total: 14, passed: 13, failed: 1, skipped: 0, deployedLocalSource: true, outdated: false,
        gate: { coverageLabel: '84% org-wide (validation org; not package-version coverage)', problems: ['1 Apex test(s) failed.'], sourceUnverified: false },
        tests: [{ fullName: 'MassDeleterTest.deletesBatch', outcome: 'Fail', message: 'System.AssertException: Assertion Failed: expected 5, actual 4', stackTrace: 'Class.MassDeleterTest.deletesBatch: line 31' }, { fullName: 'MassDeleterTest.preview', outcome: 'Pass' }],
        classes: [{ name: 'MassDeleter', coveredLines: 70, totalLines: 100, percent: 70 }, { name: 'Helper', coveredLines: 19, totalLines: 20, percent: 95 }], rawPath: 'C:\\reports\\apex.json' },
      lwc: { configured: false, reason: 'No package.json: LWC Jest is not configured.' }
    },
    packaging: {
      package: { id: '0Ho5g000000ABCDCA0', name: 'MassDelete' }, devHub: { alias: 'acme-devhub', orgId: '00D5g000008XyZaEAK' }, versionNumber: '1.3.0.NEXT',
      readiness: { at: iso(15), sourceFingerprint: '44136fa355b3678a', checks: [{ name: 'Package type', status: 'pass', detail: 'MassDelete is a managed package.' }, { name: 'Ancestry', status: 'pass', detail: 'Ancestor is HIGHEST.' }, { name: 'Source snapshot', status: 'warn', detail: '1 uncommitted change will be packaged (allowed by setting).' }] },
      candidates: [{ packageName: 'MassDelete', versionNumber: '1.3.0.NEXT', status: 'Success', devHubAlias: 'acme-devhub', devHubOrgId: '00D5g000008XyZaEAK', requestId: '08c5g000000AAAAAA0', subscriberPackageVersionId: '04t5g000000TgHjAAK', coveragePercent: 80, hasPassedCodeCoverageCheck: true, isReleased: false, branch: 'main', tag: '0abec4b1c2d3', keyMode: 'key', sourceFingerprint: '44136fa355b3678a', createdAt: iso(300), errors: [] }]
    },
    qa: {
      definitionFile: 'config/project-scratch-def.json', definition: [{ name: 'Definition file', status: 'pass', detail: 'config/project-scratch-def.json parsed.' }, { name: 'Edition', status: 'pass', detail: 'Developer' }, { name: 'Features', status: 'warn', detail: 'No features declared.' }],
      envs: [{ id: 'env-1', kind: 'fresh-install', alias: 'rp-massdelete-qa-202610221015-a1b2', status: 'ready', orgId: '00D5g000009QwErEAK', username: 'test-x9k@example.com', devHubAlias: 'acme-devhub', devHubOrgId: '00D5g000008XyZaEAK', targetVersion: '1.3.0.1', targetVersionId: '04t5g000000TgHjAAK',
        verifiedInstalledVersion: '1.3.0.1', createdAt: iso(60), expiresAt: iso(-10000), installRequestId: '0Hf5g000000BBBBAA0', failure: undefined,
        phases: { definition: { status: 'done' }, create: { status: 'done', detail: '00D5g000009QwErEAK' }, dependencies: { status: 'done', detail: 'none' }, install: { status: 'done' }, verify: { status: 'done', detail: 'Installed 1.3.0.1' }, permsets: { status: 'done' }, scripts: { status: 'done' }, smoke: { status: 'done' } },
        smoke: [{ name: 'Installed version', status: 'pass', detail: '1.3.0.1 is installed.' }], logRefs: ['C:\\reports\\install-log.json'],
        checklist: [{ id: 'c1', text: 'Log in to the QA org as an administrator (Open Org).', state: 'pass', by: 'dev', at: iso(5) }, { id: 'c2', text: 'Setup > Installed Packages shows the expected package version.', state: 'pending' }, { id: 'c3', text: 'The main user flows changed in this release work end to end.', state: 'pending' }] }]
    },
    release: { history: [], report: {
      generatedAt: iso(1), ready: false, evidenceHash: 'abc123def4567890abc123def4567890', sourceFingerprint: '44136fa355b3678a', package: { id: '0Ho5g000000ABCDCA0', name: 'MassDelete' }, devHub: { alias: 'acme-devhub', orgId: '00D5g000008XyZaEAK' },
      candidate: { versionId: '04t5g000000TgHjAAK', version: '1.3.0.1' }, summary: { analysis: '6 finding(s); 2 blocking', tests: '13/14 passed in rp-qa-1', coverage: '84% org-wide (validation org, not package coverage)', packageCoverage: '80% (Salesforce check passed)' },
      hardBlockers: ['Static analysis (Code Analyzer v5): 2 untriaged finding(s) at or above high.', 'Clean-install QA (automation + signed manual checklist): needs-review'], warnings: ['Installation key: ok'],
      gates: [{ id: 'candidate', title: 'Candidate package version', kind: 'hard', status: 'pass', detail: 'MassDelete 1.3.0.1 = 04t5g000000TgHjAAK on acme-devhub.' },
        { id: 'package-coverage', title: 'Package-version code coverage (Salesforce minimum 75%)', kind: 'hard', status: 'pass', detail: '80% and Salesforce\u2019s coverage check passed.' },
        { id: 'analysis', title: 'Static analysis (Code Analyzer v5)', kind: 'hard', status: 'fail', detail: '2 untriaged finding(s) at or above high.', remediation: 'Fix or justify the findings and rescan.' },
        { id: 'org-coverage', title: 'Internal org-wide coverage target (80%)', kind: 'policy', status: 'fail', detail: '70% org-wide in the validation org.', remediation: 'Add tests, or override with a justification.' },
        { id: 'lwc', title: 'LWC Jest tests', kind: 'policy', status: 'na', detail: 'Not configured for this project.' },
        { id: 'install-key', title: 'Installation key', kind: 'advisory', status: 'pass', detail: 'The version is protected by an installation key.' }] } }
  };

  window.addEventListener('load', () => window.postMessage(state, '*'));
})();
