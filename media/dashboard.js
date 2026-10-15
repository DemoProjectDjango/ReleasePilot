(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const ICON = { pending: '○', running: '↻', passed: '✓', failed: '✕', blocked: '⛔', 'needs-review': '👁', stale: '⟳', skipped: '⤼', cancelled: '⊘' };
  const LABEL = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', blocked: 'Blocked', 'needs-review': 'Needs Review', stale: 'Stale', skipped: 'Skipped', cancelled: 'Cancelled' };
  const TABS = [['pipeline', 'Pipeline'], ['logs', 'Logs'], ['errors', 'Errors'], ['reports', 'Reports & Artifacts'], ['history', 'Release History'], ['settings', 'Settings']];

  const saved = vscode.getState() || {};
  let tab = saved.tab || 'pipeline';
  let openSteps = new Set(saved.openSteps || []);
  let data = null;

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') { e.className = v; }
      else if (k.startsWith('on')) { e.addEventListener(k.slice(2), v); }
      else if (v === true) { e.setAttribute(k, ''); }
      else if (v !== false && v != null) { e.setAttribute(k, String(v)); }
    }
    for (const c of children.flat()) {
      if (c == null) { continue; }
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  const post = msg => vscode.postMessage(msg);
  const persistUi = () => vscode.setState({ tab, openSteps: [...openSteps] });
  const fmt = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } };

  function blockedReason(def, steps) {
    if (!def.hasExecutor) { return 'Not available in this build (delivered in Slice ' + def.plannedSlice + ').'; }
    if (!data.workspace.trusted) { return 'Workspace is not trusted.'; }
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
            onclick: ev => { ev.preventDefault(); post({ type: step.attempt > 0 && step.status !== 'pending' ? 'retry' : 'run', stepId: def.id }); }
          }, step.attempt > 0 && step.status !== 'pending' ? 'Retry' : 'Run')
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
        step.evidence.length ? el('p', {}, 'Evidence: ' + step.evidence.map(e => e.label).join(', ')) : null
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
    if (!failing.length) { return el('div', { class: 'empty' }, 'No errors recorded in this run.'); }
    return el('div', {}, failing.map(s => {
      const def = data.definitions.find(d => d.id === s.id);
      return el('div', { class: 'err' }, el('strong', {}, def.title + ' - ' + s.failure.code),
        el('div', {}, s.failure.message), s.failure.detail ? el('pre', { class: 'log-line' }, s.failure.detail) : null,
        s.failure.remediation ? el('div', { class: 'muted' }, 'Next: ' + s.failure.remediation) : null,
        el('div', { class: 'muted' }, fmt(s.failure.at)));
    }));
  }

  function reportsTab() {
    const rows = [];
    for (const s of Object.values(data.state.run.steps)) {
      const def = data.definitions.find(d => d.id === s.id);
      for (const e of s.evidence) { rows.push(el('tr', {}, el('td', {}, def.title), el('td', {}, e.kind), el('td', {}, e.label), el('td', {}, e.ref), el('td', {}, fmt(e.createdAt)))); }
    }
    if (!rows.length) { return el('div', { class: 'empty' }, 'No reports or artifacts yet. Evidence appears here once real steps produce it (Slice 3 onward).'); }
    return el('table', {}, el('thead', {}, el('tr', {}, ['Step', 'Kind', 'Label', 'Reference', 'Created'].map(h => el('th', {}, h)))), el('tbody', {}, rows));
  }

  function historyTab() {
    const h = data.state.history;
    if (!h.length) { return el('div', { class: 'empty' }, 'No completed release runs yet. Use "New Release Run" to archive the current run.'); }
    return el('table', {}, el('thead', {}, el('tr', {}, ['Run', 'Started', 'Ended', 'Passed steps', 'Failed'].map(x => el('th', {}, x)))),
      el('tbody', {}, h.map(r => el('tr', {}, el('td', {}, r.id.slice(0, 8)), el('td', {}, fmt(r.startedAt)), el('td', {}, fmt(r.endedAt)),
        el('td', {}, r.passedSteps.length + ' / ' + data.definitions.length), el('td', {}, r.outcome.failed)))));
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
    return el('div', {}, el('table', {}, el('tbody', {},
      field('coverageTargetPercent', 'Internal coverage target (%)', 0, 100, 'Org-level target. Salesforce package-version coverage (minimum 75%) is evaluated separately.'),
      field('logRetentionEntries', 'Log retention (entries)', 100, 50000, 'Persisted log size.'),
      field('stepTimeoutMinutes', 'Step timeout (minutes)', 1, 720, 'Applies after reload. A local timeout never cancels remote jobs.'))));
  }

  function render() {
    if (!data) { app.replaceChildren(el('p', {}, 'Loading…')); return; }
    const folders = data.workspace.folders;
    const tabs = el('nav', { role: 'tablist' }, TABS.map(([id, label]) => {
      const b = el('button', { role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; persistUi(); render(); } }, label);
      return b;
    }));
    const view = { pipeline: pipelineTab, logs: logsTab, errors: errorsTab, reports: reportsTab, history: historyTab, settings: settingsTab }[tab]();
    app.replaceChildren(
      el('h1', {}, 'ReleasePilot'),
      el('div', { class: 'muted' }, 'Salesforce managed 2GP release automation · TwinStack Solutions'),
      data.workspace.trusted ? null : el('div', { class: 'banner', role: 'alert' }, 'This workspace is not trusted. ReleasePilot is read-only until you trust it.'),
      el('div', { class: 'selectors' },
        el('label', {}, 'Project',
          el('select', { 'aria-label': 'Project' }, folders.length ? folders.map(f => el('option', { title: f.path }, f.name)) : [el('option', {}, 'No folder open')])),
        el('label', {}, 'Development org', el('select', { disabled: true, title: 'Org discovery arrives in Slice 2' }, el('option', {}, 'Org discovery: Slice 2'))),
        el('label', {}, 'Dev Hub', el('select', { disabled: true, title: 'Dev Hub discovery arrives in Slice 2' }, el('option', {}, 'Dev Hub discovery: Slice 2')))),
      tabs, el('section', { role: 'tabpanel' }, view));
  }

  window.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'state') { data = ev.data; render(); }
  });
  render();
  post({ type: 'ready' });
})();
