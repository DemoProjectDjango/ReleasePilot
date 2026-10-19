(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const ICON = { pending: '○', running: '↻', passed: '✓', failed: '✕', blocked: '⛔', 'needs-review': '👁', stale: '⟳', skipped: '⤼', cancelled: '⊘' };
  const LABEL = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', blocked: 'Blocked', 'needs-review': 'Needs Review', stale: 'Stale', skipped: 'Skipped', cancelled: 'Cancelled' };
  const TABS = [['pipeline', 'Pipeline'], ['project', 'Project'], ['logs', 'Logs'], ['errors', 'Errors'], ['reports', 'Reports & Artifacts'], ['history', 'Release History'], ['settings', 'Settings']];

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
    const row = (who, e) => el('tr', {}, el('td', {}, who), el('td', {}, e.kind), el('td', {}, e.label), el('td', {}, e.ref), el('td', {}, fmt(e.createdAt)));
    for (const s of Object.values(data.state.run.steps)) {
      const def = data.definitions.find(d => d.id === s.id);
      s.evidence.forEach(e => rows.push(row(def.title, e)));
    }
    (data.state.artifacts || []).forEach(e => rows.push(row('Project', e)));
    return table(['Source', 'Kind', 'Label', 'Reference', 'Created'], rows,
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
    const dirty = el('input', { type: 'checkbox', id: 'set-allowDirtySource', checked: s.allowDirtySource });
    dirty.addEventListener('change', () => post({ type: 'setSetting', key: 'allowDirtySource', value: dirty.checked }));
    return el('div', {}, el('table', {}, el('tbody', {},
      el('tr', {}, el('td', {}, el('label', { for: 'set-allowDirtySource' }, 'Allow uncommitted source')), el('td', {}, dirty),
        el('td', { class: 'muted' }, 'Lets Source Ready pass with uncommitted changes. Not recommended for release candidates.')),
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
      orgSelect('Dev Hub', d.devHub, orgs.filter(o => o.isDevHub), 'selectDevHub'));
  }

  function render() {
    if (!data) { app.replaceChildren(el('p', {}, 'Loading…')); return; }
    const tabs = el('nav', { role: 'tablist' }, TABS.map(([id, label]) =>
      el('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; persistUi(); render(); } }, label)));
    const view = { pipeline: pipelineTab, project: projectTab, logs: logsTab, errors: errorsTab, reports: reportsTab, history: historyTab, settings: settingsTab }[tab]();
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
