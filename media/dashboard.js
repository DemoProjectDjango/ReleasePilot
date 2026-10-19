(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const ICON = { pending: '○', running: '↻', passed: '✓', failed: '✕', blocked: '⛔', 'needs-review': '👁', stale: '⟳', skipped: '⤼', cancelled: '⊘' };
  const LABEL = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', blocked: 'Blocked', 'needs-review': 'Needs Review', stale: 'Stale', skipped: 'Skipped', cancelled: 'Cancelled' };
  const TABS = [['pipeline', 'Pipeline'], ['project', 'Project'], ['quality', 'Quality'], ['package', 'Package'], ['qa', 'QA'], ['logs', 'Logs'], ['errors', 'Errors'], ['reports', 'Reports & Artifacts'], ['history', 'Release History'], ['settings', 'Settings']];

  const saved = vscode.getState() || {};
  let tab = saved.tab || 'pipeline';
  let openSteps = new Set(saved.openSteps || []);
  let data = null;

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') { e.className = v; }
      else if (k.startsWith('on')) { e.addEventListener(k.slice(2), v); }
      else if (k === 'selected' || k === 'checked' || k === 'disabled' || k === 'open') { if (v) { e.setAttribute(k, ''); e[k] = true; } }
      else if (v === true) { e.setAttribute(k, ''); }
      else if (v !== false && v != null) { e.setAttribute(k, String(v)); }
    }
    for (const c of children.flat(2)) {
      if (c == null) { continue; }
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  const post = msg => vscode.postMessage(msg);
  const persistUi = () => vscode.setState({ tab, openSteps: [...openSteps] });
  const fmt = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } };

  function table(headers, rows, emptyText) {
    if (!rows.length) { return el('div', { class: 'empty' }, emptyText); }
    return el('table', {}, el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h)))), el('tbody', {}, rows));
  }

  function blockedReason(def, steps) {
    if (!def.hasExecutor) { return 'Not available in this build (delivered in Slice ' + def.plannedSlice + ').'; }
    if (!data.workspace.trusted) { return 'Workspace is not trusted.'; }
    if (data.busy) { return 'Another operation is in progress.'; }
    for (const dep of def.dependsOn) {
      const d = data.definitions.find(x => x.id === dep);
      const s = steps[dep].status;
      if (!(s === 'passed' || (s === 'skipped' && d.optional))) { return d.title + ' must pass first (currently ' + LABEL[s] + ').'; }
    }
    return null;
  }

  function stepPanel(def) {
    const step = data.state.run.steps[def.id];
    const reason = blockedReason(def, data.state.run.steps);
    const running = step.status === 'running';
    const retry = step.attempt > 0 && step.status !== 'pending';
    const details = el('details', { class: 'step', open: openSteps.has(def.id) },
      el('summary', {},
        el('strong', {}, def.title),
        el('span', { class: 'badge ' + step.status }, ICON[step.status] + ' ' + LABEL[step.status]),
        def.optional ? el('span', { class: 'muted' }, '(optional)') : null,
        el('span', { class: 'spacer' }),
        running
          ? el('button', { class: 'action secondary', onclick: ev => { ev.preventDefault(); post({ type: 'cancel', stepId: def.id }); } }, 'Cancel')
          : el('button', {
            class: 'action', disabled: !!reason, title: reason || '',
            onclick: ev => { ev.preventDefault(); post({ type: retry ? 'retry' : 'run', stepId: def.id }); }
          }, retry ? 'Retry' : 'Run')
      ),
      el('div', { class: 'body' },
        el('p', {}, def.description),
        reason ? el('p', { class: 'muted' }, 'Cannot run: ' + reason) : null,
        step.message ? el('p', {}, step.message) : null,
        step.failure ? el('div', { class: 'err' },
          el('strong', {}, step.failure.code + ': '), step.failure.message,
          step.failure.remediation ? el('div', { class: 'muted' }, 'Next: ' + step.failure.remediation) : null) : null,
        el('p', { class: 'muted' }, 'Requirements: ' + def.requirements.join(', ') + ' · Attempts: ' + step.attempt +
          (step.startedAt ? ' · Started: ' + fmt(step.startedAt) : '') + (step.endedAt ? ' · Ended: ' + fmt(step.endedAt) : '')),
        step.fingerprint ? el('p', { class: 'muted' }, 'Fingerprint: ' + step.fingerprint.slice(0, 16)) : null,
        step.evidence.length ? el('p', {}, 'Evidence: ' + step.evidence.map(e => e.label + ' (' + e.ref + ')').join(', ')) : null
      ));
    details.addEventListener('toggle', () => {
      if (details.open) { openSteps.add(def.id); } else { openSteps.delete(def.id); }
      persistUi();
    });
    return el('li', { class: 's-' + step.status }, el('span', { class: 'dot', 'aria-hidden': 'true' }, ICON[step.status]), details);
  }

  function pipelineTab() {
    const anyRunning = Object.values(data.state.run.steps).some(s => s.status === 'running');
    return el('div', {},
      el('div', { class: 'toolbar' },
        el('button', { class: 'action', disabled: anyRunning, onclick: () => post({ type: 'resume' }) }, 'Resume Pipeline'),
        el('button', { class: 'action secondary', disabled: anyRunning, onclick: () => post({ type: 'newRun' }) }, 'New Release Run')),
      el('p', { class: 'muted' }, 'Run ' + data.state.run.id.slice(0, 8) + ' · started ' + fmt(data.state.run.startedAt) +
        '. A step turns green only when an executor returns verifiable evidence.'),
      el('ol', { class: 'timeline', 'aria-label': 'Release pipeline' }, data.definitions.map(stepPanel)));
  }

  function commandRows(cmds) {
    return cmds.map(c => el('tr', {},
      el('td', {}, fmt(c.at)), el('td', {}, c.display),
      el('td', {}, c.outcome + (c.exitCode !== null && c.exitCode !== undefined ? ' (' + c.exitCode + ')' : '') + (c.summary ? ': ' + c.summary : '')),
      el('td', {}, c.durationMs + ' ms')));
  }

  function projectTab() {
    const d = data.discovery || {};
    const busy = !!data.busy;
    const p = d.project;
    const parts = [];
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action', disabled: busy, onclick: () => post({ type: 'discover' }) }, 'Re-run Discovery'),
      d.discoveredAt ? el('span', { class: 'muted' }, 'Last discovered ' + fmt(d.discoveredAt)) : null));

    parts.push(el('h2', {}, 'Salesforce project'));
    if (p) {
      parts.push(el('p', {}, p.root + ' · API ' + (p.sourceApiVersion || 'n/a') + ' · namespace ' + (p.namespace || '(none)')));
      p.warnings.forEach(w => parts.push(el('div', { class: 'banner' }, w)));
      parts.push(table(['Directory', 'Package', '0Ho ID', 'Version', 'Ancestor', 'Dependencies'], p.packageDirectories.map(x => el('tr', {},
        el('td', {}, x.path + (x.exists ? '' : ' (missing)')), el('td', {}, x.package || '-'), el('td', {}, x.packageId || '-'),
        el('td', {}, x.versionNumber || '-'), el('td', {}, x.ancestorId || x.ancestorVersion || '-'), el('td', {}, String(x.dependencies.length)))), 'No package directories.'));
    } else { parts.push(el('div', { class: 'empty' }, 'No Salesforce DX project detected in the selected folder.')); }

    parts.push(el('h2', {}, 'Tooling'));
    const t = d.tooling;
    parts.push(t ? el('p', {}, 'sf: ' + (t.sf || 'not found') + ' · code-analyzer: ' + (t.codeAnalyzer ? t.codeAnalyzer.version : 'not installed') +
      ' · node: ' + t.node + ' · git: ' + ((d.git && d.git.version) || 'not found')) : el('p', { class: 'muted' }, 'Not discovered yet.'));

    parts.push(el('h2', {}, 'Source control'));
    const g = d.git;
    parts.push(g && g.isRepo
      ? el('p', {}, 'Branch ' + g.branch + ' · HEAD ' + (g.head || '').slice(0, 8) + ' · ' + g.files.length + ' uncommitted change(s) · fingerprint ' + (g.fingerprint || '').slice(0, 12))
      : el('p', { class: 'muted' }, (g && g.error) || 'Not discovered yet.'));

    parts.push(el('h2', {}, 'Authenticated orgs'));
    parts.push(table(['Alias', 'Username', 'Org ID', 'Type', 'Roles'], (d.orgs || []).map(o => el('tr', {},
      el('td', {}, o.alias || '-'), el('td', {}, o.username), el('td', {}, o.orgId),
      el('td', {}, o.isScratch ? 'Scratch' : o.isSandbox ? 'Sandbox' : 'Production/Developer'),
      el('td', {}, [o.isDevHub ? 'Dev Hub' : '', o.isDefaultDevHub ? 'default Dev Hub' : '', o.isDefaultOrg ? 'default org' : '', o.expired ? 'EXPIRED' : ''].filter(Boolean).join(', ') || '-'))),
    'No authenticated orgs found. Run "sf org login web".'));

    parts.push(el('h2', {}, 'Dev Hub package'));
    if (d.devHub) {
      const pk = d.selectedPackage;
      parts.push(el('p', {}, 'Dev Hub ' + (d.devHub.alias || d.devHub.username) + ' (' + d.devHub.orgId + ') · ' +
        (pk ? 'package ' + pk.name + ' (' + pk.id + ')' + (pk.namespacePrefix ? ' ns ' + pk.namespacePrefix : '') : 'no matching package')));
      if (d.packages && d.packages.length) {
        const sel = el('select', { 'aria-label': 'Package', disabled: busy },
          d.packages.map(x => el('option', { value: x.id, selected: pk && pk.id === x.id }, x.name + ' (' + x.id + ')')));
        sel.addEventListener('change', () => post({ type: 'selectPackage', alias: sel.value }));
        parts.push(el('label', {}, 'Package ', sel));
      }
      parts.push(table(['04t', 'Version', 'Branch', 'Released', 'Coverage', 'Created'], (d.versions || []).map(v => el('tr', {},
        el('td', {}, v.subscriberPackageVersionId || '-'), el('td', {}, v.version || '-'), el('td', {}, v.branch || '-'),
        el('td', {}, v.isReleased ? 'Yes' : 'No (beta)'), el('td', {}, v.codeCoverage || '-'), el('td', {}, v.createdDate ? fmt(v.createdDate) : '-'))),
      'No package versions found.'));
    } else { parts.push(el('p', { class: 'muted' }, 'Select a Dev Hub to load package information.')); }

    parts.push(el('h2', {}, 'Retrieve from development org'));
    const r = data.retrieval;
    const org = d.devOrg;
    parts.push(el('p', { class: 'muted' }, 'Previews changes in the selected org and retrieves only when there are no conflicts and no overlap with your uncommitted edits. Local files are never overwritten silently.'));
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action', disabled: busy || !org, title: org ? '' : 'Select a development org', onclick: () => post({ type: 'retrievePreview' }) }, 'Preview Org Changes'),
      el('button', { class: 'action secondary', disabled: busy || !r || r.blockers.length > 0 || r.preview.toRetrieve.length === 0, onclick: () => post({ type: 'retrieveApply' }) }, 'Retrieve to Local Project')));
    if (r) {
      parts.push(el('p', {}, r.orgLabel + ' · ' + r.preview.toRetrieve.length + ' to retrieve · ' + r.preview.conflicts.length + ' conflict(s) · ' + r.overlap.length + ' overlapping local edit(s) · ' + fmt(r.at)));
      r.blockers.forEach(b => parts.push(el('div', { class: 'err' }, b)));
      const rows = list => list.slice(0, 200).map(c => el('tr', {}, el('td', {}, c.type), el('td', {}, c.fullName), el('td', {}, c.path || '-')));
      parts.push(table(['Type', 'Component', 'Path'], rows(r.preview.toRetrieve), 'Nothing to retrieve.'));
      if (r.preview.conflicts.length) {
        parts.push(el('h2', {}, 'Conflicts'));
        parts.push(table(['Type', 'Component', 'Path'], rows(r.preview.conflicts), ''));
      }
    }

    parts.push(el('h2', {}, 'Executed commands'));
    parts.push(table(['Time', 'Command', 'Result', 'Duration'], commandRows(d.commands || []), 'No commands executed yet.'));
    return el('div', {}, parts);
  }

  const CHECK_ICON = { pass: '\u2713 Pass', fail: '\u2715 Fail', warn: '\u26A0 Warning' };

  function packageTab() {
    const pk = data.packaging || { candidates: [] };
    const steps = data.state.run.steps;
    const busy = !!data.busy;
    const def = id => data.definitions.find(d => d.id === id);
    const why = id => blockedReason(def(id), steps);
    const parts = [];
    parts.push(el('h2', {}, 'Managed 2GP beta package'));
    parts.push(el('p', {}, pk.package
      ? pk.package.name + ' (' + pk.package.id + ') · Dev Hub ' + (pk.devHub ? (pk.devHub.alias || pk.devHub.username) + ' (' + pk.devHub.orgId + ')' : 'none') + ' · version ' + (pk.versionNumber || 'n/a')
      : 'No package selected. Run Discover & Preflight with a Dev Hub that owns your package.'));
    parts.push(el('p', { class: 'muted' }, 'Packaging uses your local source and the Dev Hub; nothing is deployed to the Dev Hub. Releasable builds always use full validation and code coverage, never skip ancestry checks, and are never promoted from here.'));
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action secondary', disabled: busy || !!why('package-readiness'), title: why('package-readiness') || '', onclick: () => post({ type: 'run', stepId: 'package-readiness' }) }, 'Check Readiness'),
      el('button', { class: 'action', disabled: busy || !!why('package-build'), title: why('package-build') || '', onclick: () => post({ type: 'run', stepId: 'package-build' }) },
        steps['package-build'].status === 'needs-review' || steps['package-build'].status === 'running' ? 'Continue Tracking Build' : 'Create Beta Package'),
      el('button', { class: 'action secondary', disabled: busy, onclick: () => post({ type: 'refreshBuild' }) }, 'Refresh Build Status')));
    const bw = why('package-build');
    if (bw) { parts.push(el('p', { class: 'muted' }, 'Create Beta Package is unavailable: ' + bw)); }

    parts.push(el('h2', {}, 'Readiness checks'));
    const r = pk.readiness;
    parts.push(r ? el('p', { class: 'muted' }, 'Evaluated ' + fmt(r.at) + ' for source ' + (r.sourceFingerprint || '').slice(0, 12)) : null);
    parts.push(table(['Check', 'Result', 'Detail'], ((r && r.checks) || []).map(c => el('tr', {}, el('td', {}, c.name), el('td', {}, CHECK_ICON[c.status] || c.status),
      el('td', {}, c.detail, c.remediation ? el('div', { class: 'muted' }, 'Next: ' + c.remediation) : null))), 'Not evaluated yet. Static Analysis and Pre-package Tests must pass first.'));

    parts.push(el('h2', {}, 'Package builds'));
    if (!pk.candidates.length) { parts.push(el('div', { class: 'empty' }, 'No builds recorded yet.')); }
    pk.candidates.forEach(c => {
      const cov = c.coveragePercent === undefined ? 'n/a' : c.coveragePercent + '%' + (c.hasPassedCodeCoverageCheck === true ? ' (check passed)' : c.hasPassedCodeCoverageCheck === false ? ' (check FAILED)' : '');
      parts.push(el('div', { class: 'finding' },
        el('div', {}, el('strong', {}, c.packageName + ' ' + c.versionNumber), ' ', el('span', { class: 'badge ' + (c.status === 'Success' ? 'passed' : c.status === 'Error' ? 'failed' : 'needs-review') }, c.status)),
        table(['Field', 'Value'], [
          ['Dev Hub', c.devHubAlias + ' (' + c.devHubOrgId + ')'], ['Build request (08c)', c.requestId], ['Subscriber package version (04t)', c.subscriberPackageVersionId || 'not yet available'],
          ['Package code coverage', cov], ['Released', c.isReleased === undefined ? 'unknown' : c.isReleased ? 'Yes' : 'No (beta)'],
          ['Branch / tag', (c.branch || '-') + ' / ' + (c.tag || '-')], ['Installation key', c.keyMode === 'key' ? 'set (not stored)' : 'bypassed'],
          ['Source fingerprint', (c.sourceFingerprint || '').slice(0, 16)], ['Created', fmt(c.createdAt)], ['Last checked', c.lastPolledAt ? fmt(c.lastPolledAt) : '-']
        ].map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v))), ''),
        c.errors && c.errors.length ? el('div', { class: 'err' }, el('strong', {}, 'Build errors'), el('pre', { class: 'log-line' }, c.errors.join('\n'))) : null));
    });
    return el('div', {}, parts);
  }

  const PHASE_LABEL = { definition: 'Scratch definition', create: 'Create scratch org', dependencies: 'Install dependencies', baseline: 'Install previous released version', seed: 'Seed baseline data',
    install: 'Install candidate', verify: 'Verify installed version', permsets: 'Assign permission sets', scripts: 'Project scripts', smoke: 'Automated checks', open: 'Open org' };
  const PHASE_ORDER = ['definition', 'create', 'dependencies', 'baseline', 'seed', 'install', 'verify', 'permsets', 'scripts', 'smoke', 'open'];

  function envCard(e) {
    const busy = !!data.busy;
    const live = e.status === 'ready';
    const stateText = { pass: '\u2713 Pass', fail: '\u2715 Fail', pending: '\u25CB Pending' };
    const allPass = e.checklist.length > 0 && e.checklist.every(i => i.state === 'pass');
    const parts = [];
    parts.push(el('div', {}, el('strong', {}, (e.kind === 'upgrade' ? 'Upgrade test ' : 'Fresh install ') + e.alias), ' ',
      el('span', { class: 'badge ' + (e.status === 'ready' ? 'passed' : e.status === 'failed' ? 'failed' : 'needs-review') }, e.status),
      e.signoff ? el('span', { class: 'badge passed' }, 'Signed off by ' + e.signoff.approver) : null));
    parts.push(table(['Field', 'Value'], [
      ['Org ID / user', (e.orgId || 'pending') + ' / ' + (e.username || 'pending')], ['Dev Hub', e.devHubAlias + ' (' + e.devHubOrgId + ')'],
      ['Version under test', (e.targetVersion || '') + ' ' + e.targetVersionId], e.kind === 'upgrade' ? ['Upgraded from (released)', (e.baselineVersion || '') + ' ' + (e.baselineVersionId || '')] : null,
      ['Installed version verified', e.verifiedInstalledVersion || 'not yet'], ['Install request', e.installRequestId || '-'],
      ['Created / expires', fmt(e.createdAt) + ' / ' + (e.expiresAt ? fmt(e.expiresAt) : '-')]
    ].filter(Boolean).map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v))), ''));
    if (e.failure) { parts.push(el('div', { class: 'err' }, el('strong', {}, 'Stopped at ' + (e.failedPhase ? PHASE_LABEL[e.failedPhase] : 'a phase') + ': '), e.failure)); }
    parts.push(table(['Phase', 'Result', 'Detail'], PHASE_ORDER.filter(ph => e.phases[ph] || (e.kind === 'upgrade' || (ph !== 'baseline' && ph !== 'seed'))).map(ph => {
      const st = e.phases[ph];
      return el('tr', {}, el('td', {}, PHASE_LABEL[ph]), el('td', {}, st ? (st.status === 'done' ? '\u2713 Done' : '\u2715 Failed') : '\u25CB Pending'), el('td', {}, (st && st.detail) || ''));
    }), ''));
    if (e.smoke.length) {
      parts.push(el('h2', {}, 'Automated checks'));
      parts.push(table(['Check', 'Result', 'Detail'], e.smoke.map(c => el('tr', {}, el('td', {}, c.name), el('td', {}, CHECK_ICON[c.status]), el('td', {}, c.detail))), ''));
    }
    if (e.logRefs.length) {
      parts.push(el('div', { class: 'toolbar' }, e.logRefs.slice(-4).map(ref => el('button', { class: 'action secondary', onclick: () => post({ type: 'openReport', ref }) }, 'Open log: ' + ref.split(/[\\/]/).pop().slice(0, 40)))));
    }
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action secondary', disabled: busy || !live, onclick: () => post({ type: 'qaOpen', envId: e.id }) }, 'Open Org'),
      el('button', { class: 'action secondary', disabled: busy || !e.orgId || e.status === 'deleted', onclick: () => post({ type: 'qaDelete', envId: e.id }) }, 'Delete Scratch Org...')));
    parts.push(el('h2', {}, 'Manual QA checklist'));
    parts.push(el('p', { class: 'muted' }, 'Installation success does not mean the product works. Each item must be verified by a person and explicitly marked; nothing passes by inference.'));
    e.checklist.forEach(i => parts.push(el('div', { class: 'finding' },
      el('div', {}, el('strong', {}, stateText[i.state]), ' ', i.text),
      i.note || i.by ? el('div', { class: 'muted' }, (i.by ? i.by + ' ' : '') + (i.at ? fmt(i.at) : '') + (i.note ? ' \u00B7 ' + i.note : '')) : null,
      el('div', { class: 'toolbar' },
        el('button', { class: 'action secondary', disabled: busy || !live || !!e.signoff, onclick: () => post({ type: 'qaMark', envId: e.id, itemId: i.id, state: 'pass' }) }, 'Mark Pass'),
        el('button', { class: 'action secondary', disabled: busy || !live || !!e.signoff, onclick: () => post({ type: 'qaMark', envId: e.id, itemId: i.id, state: 'fail' }) }, 'Mark Fail...')))));
    parts.push(el('div', { class: 'toolbar' }, el('button', { class: 'action', disabled: busy || !live || !allPass || !!e.signoff, title: allPass ? '' : 'Mark every item Pass first', onclick: () => post({ type: 'qaSignOff', envId: e.id }) }, e.signoff ? 'Signed off ' + fmt(e.signoff.at) : 'Sign Off QA...')));
    return el('details', { class: 'step', open: true }, el('summary', {}, el('strong', {}, (e.kind === 'upgrade' ? 'Upgrade: ' : 'Fresh install: ') + e.alias), el('span', { class: 'badge' }, e.status)), el('div', { class: 'body' }, parts));
  }

  function qaTab() {
    const q = data.qa || { envs: [], definition: [] };
    const steps = data.state.run.steps;
    const busy = !!data.busy;
    const def = id => data.definitions.find(d => d.id === id);
    const why = id => blockedReason(def(id), steps);
    const parts = [el('h2', {}, 'QA environments')];
    parts.push(el('p', { class: 'muted' }, 'Creates a clean scratch org from your Dev Hub (no namespace, so the managed package can install), installs the exact candidate 04t, assigns permission sets, runs your project scripts, and opens the org. Automation ending successfully only makes the step "Needs Review": you must then complete the manual checklist and sign off.'));
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action', disabled: busy || !!why('clean-install-qa'), title: why('clean-install-qa') || '', onclick: () => post({ type: 'run', stepId: 'clean-install-qa' }) }, steps['clean-install-qa'].status === 'needs-review' ? 'Continue QA Environment' : 'Prepare QA Environment'),
      el('button', { class: 'action secondary', disabled: busy || !!why('upgrade-qa'), title: why('upgrade-qa') || '', onclick: () => post({ type: 'run', stepId: 'upgrade-qa' }) }, 'Run Upgrade Test')));
    if (why('clean-install-qa')) { parts.push(el('p', { class: 'muted' }, 'Prepare QA Environment is unavailable: ' + why('clean-install-qa'))); }
    parts.push(el('p', { class: 'muted' }, 'Upgrade testing installs the previous released version, then upgrades to the candidate. Salesforce allows upgrading to a beta from a released version in a scratch org, but never from a beta, so unsupported paths are blocked with an explanation.'));
    const us = steps['upgrade-qa'];
    if (us.message && (us.status === 'blocked' || us.status === 'skipped')) { parts.push(el('div', { class: 'banner' }, 'Upgrade QA: ' + us.message + (us.failure && us.failure.remediation ? ' Alternative: ' + us.failure.remediation : ''))); }
    parts.push(el('h2', {}, 'Scratch org definition: ' + (q.definitionFile || '')));
    parts.push(table(['Check', 'Result', 'Detail'], (q.definition || []).map(c => el('tr', {}, el('td', {}, c.name), el('td', {}, CHECK_ICON[c.status]), el('td', {}, c.detail))), 'No project selected.'));
    if (!q.envs.length) { parts.push(el('div', { class: 'empty' }, 'No QA environments yet.')); }
    q.envs.forEach(e => parts.push(envCard(e)));
    return el('div', {}, parts);
  }

  let qGroup = 'file';
  let qFilter = '';
  let qShowTriaged = false;

  function sevBadge(f) { return el('span', { class: 'badge sev' + f.severity }, f.severityLabel); }

  function findingRow(f) {
    return el('div', { class: 'finding' + (f.triaged ? ' triaged' : '') },
      el('div', {}, sevBadge(f), ' ', el('strong', {}, f.rule), ' ', el('span', { class: 'muted' }, '(' + f.engine + ') ' + f.file + ':' + f.line + ':' + f.column)),
      el('div', {}, f.message),
      f.suggestions.length ? el('div', { class: 'muted' }, 'Suggestion: ' + f.suggestions.join(' | ')) : null,
      f.resources.length ? el('div', { class: 'muted' }, 'Docs: ' + f.resources.join(' ')) : null,
      el('div', { class: 'toolbar' },
        el('button', { class: 'action secondary', onclick: () => post({ type: 'openFile', key: f.key }) }, 'Open in editor'),
        f.fix ? el('button', { class: 'action secondary', title: 'Shows a diff and asks before changing anything', onclick: () => post({ type: 'applyFix', key: f.key }) }, 'Review suggested fix') : null,
        f.triaged ? el('button', { class: 'action secondary', onclick: () => post({ type: 'untriage', key: f.key }) }, 'Remove triage')
          : el('button', { class: 'action secondary', onclick: () => post({ type: 'triage', key: f.key }) }, 'Triage...')));
  }

  function groupOf(f) { return qGroup === 'file' ? f.file : qGroup === 'rule' ? f.rule : f.severityLabel; }

  function analysisSection(q) {
    const a = q.analysis;
    const parts = [el('h2', {}, 'Static analysis')];
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action', disabled: !!data.busy, onclick: () => post({ type: 'run', stepId: 'analysis' }) }, a ? 'Rescan' : 'Run Code Analyzer'),
      el('button', { class: 'action secondary', onclick: () => post({ type: 'exportSummary' }) }, 'Export quality summary...')));
    if (!a) { parts.push(el('div', { class: 'empty' }, 'No scan yet. Source Ready must pass before the analyzer can run.')); return parts; }
    if (a.outdated) { parts.push(el('div', { class: 'banner', role: 'alert' }, 'This scan is OUTDATED: the source changed after it ran. Rescan before relying on it.')); }
    if (a.warnings && a.warnings.length) { parts.push(el('div', { class: 'err', role: 'alert' }, el('strong', {}, 'The scan may be incomplete. '), 'Code Analyzer printed warnings:', el('pre', { class: 'log-line' }, a.warnings.slice(0, 12).join('\n')))); }
    const c = a.counts;
    parts.push(el('p', {}, c.total + ' finding(s): ' + c.Critical + ' critical, ' + c.High + ' high, ' + c.Moderate + ' moderate, ' + c.Low + ' low' +
      ' · gate: block at ' + q.gate + ' and above · ' + a.blockers + ' untriaged blocker(s) · scanned ' + fmt(a.at)));
    parts.push(el('p', { class: 'muted' }, 'Selectors: ' + a.selectors.join(', ') + ' · ' + Object.entries(a.versions).map(e => e[0] + ' ' + e[1]).join(', ') + ' · ' + a.jsonPath));
    const groupSel = el('select', { 'aria-label': 'Group findings by' }, ['file', 'severity', 'rule'].map(g => el('option', { value: g, selected: g === qGroup }, 'Group by ' + g)));
    groupSel.addEventListener('change', () => { qGroup = groupSel.value; render(); });
    const filter = el('input', { type: 'search', placeholder: 'Filter by rule, file or text', value: qFilter, 'aria-label': 'Filter findings' });
    filter.addEventListener('change', () => { qFilter = filter.value; render(); });
    const showT = el('input', { type: 'checkbox', id: 'show-triaged', checked: qShowTriaged });
    showT.addEventListener('change', () => { qShowTriaged = showT.checked; render(); });
    parts.push(el('div', { class: 'toolbar' }, groupSel, filter, el('label', { for: 'show-triaged' }, showT, ' show triaged')));
    const needle = qFilter.toLowerCase();
    const list = a.findings.filter(f => (qShowTriaged || !f.triaged) && (!needle || (f.rule + ' ' + f.file + ' ' + f.message).toLowerCase().includes(needle)));
    if (!list.length) { parts.push(el('div', { class: 'empty' }, a.findings.length ? 'No findings match the filter.' : 'No findings.')); return parts; }
    const groups = new Map();
    list.forEach(f => { const k = groupOf(f); groups.set(k, (groups.get(k) || []).concat([f])); });
    const sorted = [...groups.entries()].sort((x, y) => qGroup === 'severity' ? x[1][0].severity - y[1][0].severity : y[1].length - x[1].length);
    sorted.forEach(([k, fs]) => {
      fs.sort((x, y) => x.severity - y.severity || x.line - y.line);
      parts.push(el('details', { class: 'step', open: sorted.length === 1 || qGroup === 'severity' },
        el('summary', {}, el('strong', {}, k), el('span', { class: 'badge' }, String(fs.length))), el('div', { class: 'body' }, fs.slice(0, 200).map(findingRow),
          fs.length > 200 ? el('p', { class: 'muted' }, (fs.length - 200) + ' more; narrow the filter.') : null)));
    });
    if (a.truncated) { parts.push(el('p', { class: 'muted' }, 'Only the first 3000 findings are shown; open the JSON report for all.')); }
    if (q.triage.length) {
      parts.push(el('h2', {}, 'Triage decisions'));
      parts.push(table(['Finding', 'Owner', 'When', 'Reason'], q.triage.map(t => el('tr', {}, el('td', {}, t.key), el('td', {}, t.owner), el('td', {}, fmt(t.at)), el('td', {}, t.reason))), ''));
    }
    return parts;
  }

  function testsSection(q) {
    const a = q.apex;
    const parts = [el('h2', {}, 'Apex tests and coverage')];
    const failedTests = a ? a.tests.filter(t => t.outcome !== 'Pass' && t.outcome !== 'Skip') : [];
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action', disabled: !!data.busy, onclick: () => post({ type: 'run', stepId: 'tests' }) }, a ? 'Run Tests Again' : 'Run Tests'),
      el('button', { class: 'action secondary', disabled: !!data.busy || !failedTests.length, onclick: () => post({ type: 'rerunFailed' }) }, 'Rerun Failed Tests Only')));
    parts.push(el('p', { class: 'muted' }, 'Tests run in the selected Validation org only (never the Dev Hub), after you confirm. Coverage below is the validation org’s org-wide figure, NOT package-version coverage; Salesforce requires ≥75% package-version coverage and every trigger covered, which is verified when the beta package is built.'));
    if (!a) { parts.push(el('div', { class: 'empty' }, 'No test run recorded yet.')); }
    else {
      if (a.outdated) { parts.push(el('div', { class: 'banner', role: 'alert' }, 'This test run is OUTDATED: the source changed after it ran.')); }
      parts.push(el('p', {}, a.orgLabel + ' · ' + a.testLevel + ' · outcome ' + a.outcome + ' · ' + a.passed + ' passed, ' + a.failed + ' failed, ' + a.skipped + ' skipped of ' + a.total + ' · ' + fmt(a.at)));
      parts.push(el('p', {}, 'Coverage: ' + a.gate.coverageLabel + ' · target ' + q.coverageTarget + '% · local source deployed by ReleasePilot: ' + (a.deployedLocalSource ? 'yes' : 'NO')));
      a.gate.problems.forEach(pr => parts.push(el('div', { class: 'err' }, pr)));
      if (a.gate.sourceUnverified) { parts.push(el('div', { class: 'banner' }, 'Local source was not deployed to the org by ReleasePilot, so this result is not proven to describe your code.')); }
      const ordered = a.tests.slice().sort((x, y) => (x.outcome === 'Pass') - (y.outcome === 'Pass'));
      parts.push(table(['Test', 'Outcome', 'Message'], ordered.slice(0, 500).map(t => el('tr', {}, el('td', {}, t.fullName),
        el('td', {}, (t.outcome === 'Pass' ? '✓ ' : t.outcome === 'Skip' ? '⤷ ' : '✕ ') + t.outcome),
        el('td', {}, t.message || '', t.stackTrace ? el('details', {}, el('summary', {}, 'Stack trace'), el('pre', { class: 'log-line' }, t.stackTrace)) : null))), 'No individual test results returned.'));
      if (a.classes.length) {
        parts.push(el('h2', {}, 'Class coverage (lowest first)'));
        parts.push(table(['Class', 'Covered', 'Lines', '%'], a.classes.slice().sort((x, y) => x.percent - y.percent).slice(0, 100).map(cl =>
          el('tr', {}, el('td', {}, cl.name), el('td', {}, cl.coveredLines), el('td', {}, cl.totalLines), el('td', {}, cl.percent + (cl.percent < 75 ? ' ⚠' : '')))), ''));
      }
      if (a.rawPath) { parts.push(el('p', { class: 'muted' }, 'Raw results: ' + a.rawPath)); }
    }
    if (q.rerun) { parts.push(el('p', {}, 'Last failed-test rerun (informational): ' + q.rerun.passed + '/' + q.rerun.total + ' passed at ' + fmt(q.rerun.at) + '. A full run is still required to pass the gate.')); }
    const l = q.lwc;
    parts.push(el('h2', {}, 'LWC Jest'));
    parts.push(l ? el('p', {}, l.configured ? l.passed + '/' + l.total + ' passed, ' + l.failed + ' failed' + (l.reason ? ' · ' + l.reason : '') : 'NOT_CONFIGURED: ' + l.reason) : el('p', { class: 'muted' }, 'Runs together with the Pre-package Tests step.'));
    if (l && l.failures && l.failures.length) { parts.push(table(['File', 'Test', 'Message'], l.failures.map(f => el('tr', {}, el('td', {}, f.file), el('td', {}, f.test), el('td', {}, el('pre', { class: 'log-line' }, f.message)))), '')); }
    return parts;
  }

  function qualityTab() {
    const q = data.quality || { triage: [] };
    return el('div', {}, analysisSection(q), testsSection(q));
  }

  function logsTab() {
    const logs = data.state.logs;
    return el('div', {},
      el('div', { class: 'toolbar' }, el('button', { class: 'action secondary', onclick: () => post({ type: 'showLogs' }) }, 'Open Output Channel')),
      logs.length ? logs.slice(-300).reverse().map(l =>
        el('p', { class: 'log-line lvl-' + l.level }, fmt(l.at) + ' [' + l.level.toUpperCase() + '] ' + l.scope + ': ' + l.message))
        : el('div', { class: 'empty' }, 'No log entries yet.'));
  }

  function errorsTab() {
    const failing = Object.values(data.state.run.steps).filter(s => s.failure);
    const derrs = (data.discovery && data.discovery.errors) || [];
    if (!failing.length && !derrs.length) { return el('div', { class: 'empty' }, 'No errors recorded in this run.'); }
    return el('div', {},
      derrs.map(e => el('div', { class: 'err' }, el('strong', {}, 'Discovery (' + e.scope + ') - ' + e.code),
        el('div', {}, e.message), e.remediation ? el('div', { class: 'muted' }, 'Next: ' + e.remediation) : null)),
      failing.map(s => {
        const def = data.definitions.find(d => d.id === s.id);
        return el('div', { class: 'err' }, el('strong', {}, def.title + ' - ' + s.failure.code),
          el('div', {}, s.failure.message), s.failure.detail ? el('pre', { class: 'log-line' }, s.failure.detail) : null,
          s.failure.remediation ? el('div', { class: 'muted' }, 'Next: ' + s.failure.remediation) : null,
          el('div', { class: 'muted' }, fmt(s.failure.at)));
      }));
  }

  function reportsTab() {
    const rows = [];
    const row = (who, e) => el('tr', {}, el('td', {}, who), el('td', {}, e.kind), el('td', {}, e.label), el('td', {}, e.ref), el('td', {}, fmt(e.createdAt)),
      el('td', {}, el('button', { class: 'action secondary', onclick: () => post({ type: 'openReport', ref: e.ref }) }, 'Open'), ' ',
        el('button', { class: 'action secondary', onclick: () => post({ type: 'exportReport', ref: e.ref }) }, 'Export...')));
    for (const s of Object.values(data.state.run.steps)) {
      const def = data.definitions.find(d => d.id === s.id);
      s.evidence.forEach(e => rows.push(row(def.title, e)));
    }
    (data.state.artifacts || []).forEach(e => rows.push(row('Project', e)));
    return table(['Source', 'Kind', 'Label', 'Reference', 'Created', 'Actions'], rows,
      'No reports or artifacts yet. Evidence appears here once steps run or a retrieval preview is created.');
  }

  function historyTab() {
    const h = data.state.history;
    return table(['Run', 'Started', 'Ended', 'Passed steps', 'Failed'], h.map(r => el('tr', {},
      el('td', {}, r.id.slice(0, 8)), el('td', {}, fmt(r.startedAt)), el('td', {}, fmt(r.endedAt)),
      el('td', {}, r.passedSteps.length + ' / ' + data.definitions.length), el('td', {}, r.outcome.failed))),
    'No completed release runs yet. Use "New Release Run" to archive the current run.');
  }

  function settingsTab() {
    const s = data.settings;
    const field = (key, label, min, max, hint) => {
      const input = el('input', { type: 'number', min, max, value: s[key], id: 'set-' + key });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= min && v <= max) { post({ type: 'setSetting', key, value: v }); }
        else { input.value = s[key]; }
      });
      return el('tr', {}, el('td', {}, el('label', { for: 'set-' + key }, label)), el('td', {}, input), el('td', { class: 'muted' }, hint));
    };
    const choice = (key, label, options, hint) => {
      const sel = el('select', { id: 'set-' + key }, options.map(o => el('option', { value: o, selected: s[key] === o }, o)));
      sel.addEventListener('change', () => post({ type: 'setSetting', key, value: sel.value }));
      return el('tr', {}, el('td', {}, el('label', { for: 'set-' + key }, label)), el('td', {}, sel), el('td', { class: 'muted' }, hint));
    };
    const openBox = el('input', { type: 'checkbox', id: 'set-openOrgAfterInstall', checked: s.openOrgAfterInstall });
    openBox.addEventListener('change', () => post({ type: 'setSetting', key: 'openOrgAfterInstall', value: openBox.checked }));
    const deploy = el('input', { type: 'checkbox', id: 'set-deployBeforeTests', checked: s.deployBeforeTests });
    deploy.addEventListener('change', () => post({ type: 'setSetting', key: 'deployBeforeTests', value: deploy.checked }));
    const dirty = el('input', { type: 'checkbox', id: 'set-allowDirtySource', checked: s.allowDirtySource });
    dirty.addEventListener('change', () => post({ type: 'setSetting', key: 'allowDirtySource', value: dirty.checked }));
    return el('div', {}, el('table', {}, el('tbody', {},
      el('tr', {}, el('td', {}, el('label', { for: 'set-allowDirtySource' }, 'Allow uncommitted source')), el('td', {}, dirty),
        el('td', { class: 'muted' }, 'Lets Source Ready pass with uncommitted changes. Not recommended for release candidates.')),
      choice('severityGate', 'Analyzer severity gate', ['none', 'critical', 'high', 'moderate', 'low'], 'Untriaged findings at or above this severity block the pipeline.'),
      field('qaOrgDurationDays', 'QA org lifetime (days)', 1, 30, 'Scratch org expiry; the org is never deleted automatically.'),
      field('qaWaitMinutes', 'QA create/install wait (minutes)', 1, 120, 'Local limit; a timeout never cancels remote work.'),
      choice('qaSecurityType', 'Install security type', ['AdminsOnly', 'AllUsers'], 'Who gets access to the package in the QA org.'),
      el('tr', {}, el('td', {}, el('label', { for: 'set-openOrgAfterInstall' }, 'Open org after preparing')), el('td', {}, openBox), el('td', { class: 'muted' }, 'Permission sets, scripts and checklists: edit the releasepilot.qa* settings in VS Code.')),
      choice('installationKeyPolicy', 'Installation key policy', ['require', 'allow-bypass'], 'require: every build needs a key (asked each time, never stored). allow-bypass: empty key after explicit confirmation.'),
      field('buildWaitMinutes', 'Package build wait (minutes)', 1, 720, 'Local tracking limit. A timeout never cancels the build; retry continues the same request.'),
      field('buildPollSeconds', 'Build status poll (seconds)', 5, 120, 'Interval between status checks.'),
      choice('testLevel', 'Apex test level', ['RunLocalTests', 'RunAllTestsInOrg'], 'Test level for the Pre-package Tests step.'),
      el('tr', {}, el('td', {}, el('label', { for: 'set-deployBeforeTests' }, 'Deploy local source before tests')), el('td', {}, deploy),
        el('td', { class: 'muted' }, 'Asks for confirmation, then deploys package directories to the validation org. If off, test results cannot pass the gate.')),
      field('testWaitMinutes', 'Deploy/test wait (minutes)', 1, 600, 'A local timeout never cancels remote jobs.'),
      el('tr', {}, el('td', {}, 'Rule selectors'), el('td', {}, (s.ruleSelectors || []).join(', ')), el('td', { class: 'muted' }, 'Edit "releasepilot.ruleSelectors" in VS Code settings (e.g. add AppExchange).')),
      field('coverageTargetPercent', 'Internal coverage target (%)', 0, 100, 'Org-level target. Salesforce package-version coverage (minimum 75%) is evaluated separately.'),
      field('logRetentionEntries', 'Log retention (entries)', 100, 50000, 'Persisted log size.'),
      field('stepTimeoutMinutes', 'Step timeout (minutes)', 1, 720, 'Applies after reload. A local timeout never cancels remote jobs.'))));
  }

  function orgSelect(label, current, orgs, type) {
    const sel = el('select', { 'aria-label': label, disabled: !!data.busy },
      el('option', { value: '' }, '(none selected)'),
      orgs.map(o => el('option', { value: o.alias || o.username, selected: current && current.username === o.username }, (o.alias ? o.alias + ' - ' : '') + o.username)));
    sel.addEventListener('change', () => post({ type, alias: sel.value }));
    return el('label', {}, label, sel);
  }

  function selectors() {
    const folders = data.workspace.folders;
    const d = data.discovery || {};
    const orgs = d.orgs || [];
    const proj = el('select', { 'aria-label': 'Project', disabled: !!data.busy }, folders.length
      ? folders.map(f => el('option', { value: f.path, title: f.path, selected: f.path === data.selectedRoot }, f.name))
      : [el('option', {}, 'No folder open')]);
    proj.addEventListener('change', () => post({ type: 'selectFolder', path: proj.value }));
    return el('div', { class: 'selectors' }, el('label', {}, 'Project', proj),
      orgSelect('Development org', d.devOrg, orgs.filter(o => !o.isDevHub || !o.isScratch), 'selectDevOrg'),
      orgSelect('Validation org', d.validationOrg, orgs.filter(o => !d.devHub || o.orgId !== d.devHub.orgId), 'selectValidationOrg'),
      orgSelect('Dev Hub', d.devHub, orgs.filter(o => o.isDevHub), 'selectDevHub'));
  }

  function render() {
    if (!data) { app.replaceChildren(el('p', {}, 'Loading…')); return; }
    const tabs = el('nav', { role: 'tablist' }, TABS.map(([id, label]) =>
      el('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; persistUi(); render(); } }, label)));
    const view = { pipeline: pipelineTab, project: projectTab, quality: qualityTab, package: packageTab, qa: qaTab, logs: logsTab, errors: errorsTab, reports: reportsTab, history: historyTab, settings: settingsTab }[tab]();
    app.replaceChildren(
      el('h1', {}, 'ReleasePilot'),
      el('div', { class: 'muted' }, 'Salesforce managed 2GP release automation · TwinStack Solutions'),
      data.workspace.trusted ? null : el('div', { class: 'banner', role: 'alert' }, 'This workspace is not trusted. ReleasePilot is read-only until you trust it.'),
      data.busy ? el('div', { class: 'banner', role: 'status' }, '⏳ ' + data.busy + '...') : null,
      data.notice ? el('div', { class: 'banner', role: 'alert' }, data.notice.text) : null,
      data.cliAvailable === false ? el('div', { class: 'banner', role: 'alert' }, 'Salesforce CLI (sf) was not found on PATH. Install it and restart VS Code.') : null,
      selectors(), tabs, el('section', { role: 'tabpanel' }, view));
  }

  window.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'state') { data = ev.data; render(); }
  });
  render();
  post({ type: 'ready' });
})();
