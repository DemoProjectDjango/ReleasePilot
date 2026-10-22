(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const LABEL = { pending: 'Pending', running: 'Running', passed: 'Passed', failed: 'Failed', blocked: 'Blocked', 'needs-review': 'Needs Review', stale: 'Stale', skipped: 'Skipped', cancelled: 'Cancelled' };

  const saved = vscode.getState() || {};
  let tab = saved.tab || 'pipeline';
  let openSteps = new Set(saved.openSteps || []);
  let closedSteps = new Set(saved.closedSteps || []);
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
    for (const c of children.flat(Infinity)) {
      if (c == null) { continue; }
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  const post = msg => vscode.postMessage(msg);
  const persistUi = () => vscode.setState({ tab, openSteps: [...openSteps], closedSteps: [...closedSteps], dismissed: dismissedNotice });
  const fmt = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } };


  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Simple stroked icons (24x24 grid). Several sub-paths are separated by "|".
  const PATHS = {
    circle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    check: 'M20 6 9 17l-5-5', x: 'M18 6 6 18|M6 6l12 12', play: 'M7 4.5v15l12-7.5z', chevron: 'm6 9 6 6 6-6', loader: 'M21 12a9 9 0 1 1-6.2-8.6',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 6v6l4 2', lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z|M7 11V7a5 5 0 0 1 10 0v4',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    refresh: 'M21 12a9 9 0 0 0-15-6.7L3 8|M3 3v5h5|M3 12a9 9 0 0 0 15 6.7L21 16|M21 21v-5h-5', ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|m4.9 4.9 14.2 14.2',
    skip: 'M5 4l10 8-10 8z|M19 5v14', alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4|M12 17h.01',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 16v-4|M12 8h.01', inbox: 'M22 12h-6l-2 3h-4l-2-3H2|M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z',
    pipeline: 'M6 3v12|M18 9v12|M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M18 9a9 9 0 0 1-9 9',
    folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z',
    shield: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z|m9 12 2 2 4-4',
    package: 'M11 21.7a2 2 0 0 0 2 0l6-3.4a2 2 0 0 0 1-1.7V9.4a2 2 0 0 0-1-1.7l-6-3.4a2 2 0 0 0-2 0l-6 3.4a2 2 0 0 0-1 1.7v7.2a2 2 0 0 0 1 1.7z|M3.3 7 12 12l8.7-5|M12 22V12',
    flask: 'M10 2v7.5L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V2|M8.5 2h7|M7 16h10',
    rocket: 'M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z|M12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2z|M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0|M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5',
    terminal: 'm4 17 6-6-6-6|M12 19h8', file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M8 13h8|M8 17h5',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5|M12 7v5l4 2', sliders: 'M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6',
    branch: 'M6 3v12|M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 9a9 9 0 0 1-9 9', cloud: 'M17.5 19a4.5 4.5 0 1 0-1.2-8.8A6 6 0 1 0 6 18.5',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|m7 10 5 5 5-5|M12 15V3', list: 'M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01',
    plus: 'M12 5v14|M5 12h14', external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6|m15 3 6 0 0 6|M10 14 21 3'
  };

  function icon(name, extra) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'i' + (extra ? ' ' + extra : ''));
    s.setAttribute('aria-hidden', 'true');
    (PATHS[name] || PATHS.circle).split('|').forEach(d => { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }

  const STATUS_ICON = { pending: 'circle', running: 'loader', passed: 'check', failed: 'x', blocked: 'lock', 'needs-review': 'eye', stale: 'refresh', skipped: 'skip', cancelled: 'ban' };
  const STATUS_TONE = { pending: 'neutral', running: 'info', passed: 'ok', failed: 'bad', blocked: 'violet', 'needs-review': 'hold', stale: 'warn', skipped: 'neutral', cancelled: 'neutral' };

  function pill(status) {
    return el('span', { class: 'badge ' + status }, icon(STATUS_ICON[status] || 'circle', status === 'running' ? 'spin' : ''), LABEL[status] || status);
  }

  const CHECK_META = { pass: ['pass', 'check', 'Pass'], fail: ['fail', 'x', 'Fail'], warn: ['warn', 'alert', 'Warning'], na: ['', 'skip', 'Not applicable'], overridden: ['warn', 'alert', 'Overridden'] };
  function checkPill(state) {
    const m = CHECK_META[state];
    return m ? el('span', { class: 'badge ' + m[0] }, icon(m[1]), m[2]) : String(state);
  }
  // Fresh DOM nodes on every access, so a pill can be used in many table cells.
  const CHECK_ICON = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? checkPill(k) : undefined) });
  const GATE_RESULT = CHECK_ICON;
  function phasePill(st) {
    if (!st) { return el('span', { class: 'badge' }, icon('circle'), 'Pending'); }
    return st.status === 'done' ? el('span', { class: 'badge pass' }, icon('check'), 'Done') : el('span', { class: 'badge fail' }, icon('x'), 'Failed');
  }
  function checklistPill(state) {
    return state === 'pass' ? checkPill('pass') : state === 'fail' ? checkPill('fail') : el('span', { class: 'badge' }, icon('circle'), 'Pending');
  }

  function tile(o) {
    return el('div', { class: 'tile tone-' + (o.tone || 'neutral') },
      el('div', { class: 'k' }, o.k), el('div', { class: 'v' + (o.small ? ' sm' : '') }, o.v), o.s ? el('div', { class: 's' }, o.s) : null, o.action ? el('div', { class: 'tile-action' }, o.action) : null);
  }
  const tiles = list => el('div', { class: 'tiles' }, list.filter(Boolean).map(tile));

  function emptyState(text, name) { return el('div', { class: 'empty' }, icon(name || 'inbox'), el('div', {}, text)); }

  const SECTION_ICON = {
    'Salesforce project': 'folder', 'Tooling': 'terminal', 'Source control': 'branch', 'Authenticated orgs': 'cloud', 'Dev Hub package': 'package', 'Retrieve from development org': 'download',
    'Executed commands': 'terminal', 'Static analysis': 'shield', 'Apex tests and coverage': 'flask', 'Class coverage (lowest first)': 'list', 'LWC Jest': 'flask', 'Triage decisions': 'list',
    'Managed 2GP beta package': 'package', 'Readiness checks': 'check', 'Package builds': 'package', 'QA environments': 'flask', 'Release readiness and promotion': 'rocket',
    'Release history': 'history', 'Released versions': 'rocket', 'Release runs': 'history', 'Promotion record': 'rocket', 'Next steps': 'list', 'Blockers that cannot be overridden': 'alert',
    'Remaining warnings': 'alert', 'Analysis': 'shield', 'Testing': 'flask', 'Package builds ': 'package'
  };

  // Groups a page's flat list of nodes into cards: every <h2> starts a new card holding what follows it.
  function cardify(root) {
    const out = [];
    let card = null;
    for (const n of [...root.childNodes]) {
      if (n.nodeType === 1 && n.tagName === 'H2') {
        const ic = SECTION_ICON[n.textContent] || (n.textContent.startsWith('Scratch org definition') ? 'file' : null);
        card = el('section', { class: 'card' }, el('header', {}, ic ? icon(ic) : null, n));
        out.push(card);
      } else if (card) {
        card.append(n);
      } else {
        out.push(n);
      }
    }
    return el('div', { class: 'page' }, out);
  }

  function table(headers, rows, emptyText) {
    if (!rows.length) { return emptyState(emptyText); }
    const kv = headers[0] === 'Field' || (headers.length === 2 && headers[1] === '');
    return el('div', { class: 'table-wrap' }, el('table', { class: kv ? 'kv' : '' },
      kv ? null : el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h)))), el('tbody', {}, rows)));
  }

  function chip(tone, iconName, label, value) {
    return el('span', { class: 'chip ' + tone }, icon(iconName), label ? el('span', { class: 'muted' }, label) : null, value != null ? el('b', {}, value) : null);
  }

  function projectTiles(d) {
    const g = d.git;
    const orgs = d.orgs || [];
    return tiles([
      { k: 'Dev Hub', v: d.devHub ? (d.devHub.alias || d.devHub.username) : 'Not selected', small: true, s: d.devHub ? d.devHub.orgId : 'Choose one in the top bar', tone: d.devHub ? 'ok' : 'hold' },
      { k: 'Package', v: d.selectedPackage ? d.selectedPackage.name : 'None', small: true, s: d.selectedPackage ? d.selectedPackage.id : 'No package matched', tone: d.selectedPackage ? 'ok' : 'hold' },
      { k: 'Authenticated orgs', v: String(orgs.length), s: orgs.filter(o => o.expired).length + ' expired', tone: orgs.some(o => o.expired) ? 'warn' : 'ok' },
      { k: 'Uncommitted changes', v: g && g.isRepo ? String(g.files.length) : '\u2013', s: g && g.isRepo ? 'on ' + g.branch : 'not a Git repository', tone: g && g.isRepo ? (g.files.length ? 'warn' : 'ok') : 'bad' }
    ]);
  }

  function qualityTiles(q) {
    const a = q.analysis;
    const t = q.apex;
    const cov = t && t.gate && t.gate.coverageLabel ? parseFloat(t.gate.coverageLabel) : NaN;
    return tiles([
      { k: 'Findings', v: a ? String(a.counts.total) : '\u2013', s: a ? a.counts.High + ' high \u00B7 ' + a.counts.Moderate + ' moderate \u00B7 ' + a.counts.Low + ' low' : 'No scan yet', tone: !a ? 'neutral' : a.blockers ? 'bad' : 'ok' },
      { k: 'Blocking', v: a ? String(a.blockers) : '\u2013', s: 'untriaged at or above ' + q.gate, tone: !a ? 'neutral' : a.blockers ? 'bad' : 'ok' },
      { k: 'Apex tests', v: t ? t.passed + ' / ' + t.total : '\u2013', s: t ? t.failed + ' failed' : 'No run yet', tone: !t ? 'neutral' : t.failed ? 'bad' : 'ok' },
      { k: 'Org coverage', v: Number.isNaN(cov) ? '\u2013' : cov + '%', s: 'target ' + q.coverageTarget + '% \u00B7 not package coverage', tone: Number.isNaN(cov) ? 'neutral' : cov >= q.coverageTarget ? 'ok' : 'hold' }
    ]);
  }

  function packageTiles(pk) {
    const c = (pk.candidates || [])[0];
    return tiles([
      { k: 'Target version', v: pk.versionNumber || '\u2013', s: pk.package ? pk.package.name : 'No package selected', tone: pk.package ? 'info' : 'neutral' },
      { k: 'Latest build', v: c ? c.status : 'None', s: c ? c.requestId : 'No build recorded yet', small: true, tone: !c ? 'neutral' : c.status === 'Success' ? 'ok' : c.status === 'Error' ? 'bad' : 'hold' },
      { k: 'Package coverage', v: c && c.coveragePercent !== undefined ? c.coveragePercent + '%' : '\u2013', s: c ? (c.hasPassedCodeCoverageCheck ? 'Salesforce check passed' : 'check not passed') : 'Salesforce minimum 75%', tone: !c || c.coveragePercent === undefined ? 'neutral' : c.hasPassedCodeCoverageCheck ? 'ok' : 'bad' },
      { k: 'Version (04t)', v: c && c.subscriberPackageVersionId ? c.subscriberPackageVersionId : '\u2013', small: true, s: c && c.isReleased ? 'Released' : 'Beta', tone: 'neutral' }
    ]);
  }

  function qaTiles(q, steps) {
    const e = (q.envs || [])[0];
    const done = e ? e.checklist.filter(i => i.state === 'pass').length : 0;
    return tiles([
      { k: 'Environments', v: String((q.envs || []).length), s: e ? e.alias : 'None yet', small: !e, tone: e ? 'info' : 'neutral' },
      { k: 'Latest status', v: e ? e.status : '\u2013', s: e && e.verifiedInstalledVersion ? 'Installed ' + e.verifiedInstalledVersion : 'No install verified', tone: !e ? 'neutral' : e.status === 'ready' ? 'ok' : e.status === 'failed' ? 'bad' : 'hold' },
      { k: 'Manual checklist', v: e ? done + ' / ' + e.checklist.length : '\u2013', s: e && e.checklist.some(i => i.state === 'fail') ? 'An item failed' : 'items passed', tone: !e ? 'neutral' : done === e.checklist.length ? 'ok' : 'hold' },
      { k: 'QA sign-off', v: e && e.signoff ? 'Signed' : 'Pending', s: e && e.signoff ? e.signoff.approver : 'Required before release', tone: e && e.signoff ? 'ok' : 'neutral' }
    ]);
  }

  function releaseTiles(rel, steps) {
    const r = rel.report;
    const promo = steps.promotion;
    return tiles([
      { k: 'Verdict', v: !r ? 'Not generated' : r.ready ? 'Ready' : 'Not ready', small: !r, s: r ? (r.candidate ? r.candidate.version + ' \u00B7 ' + r.candidate.versionId : 'no candidate') : 'Run Release Readiness', tone: !r ? 'neutral' : r.ready ? 'ok' : 'bad' },
      { k: 'Hard blockers', v: r ? String(r.hardBlockers.length) : '\u2013', s: 'cannot be overridden', tone: !r ? 'neutral' : r.hardBlockers.length ? 'bad' : 'ok' },
      { k: 'Policy decisions', v: r ? String(r.gates.filter(g => g.kind === 'policy' && g.status === 'fail').length) : '\u2013', s: 'overridable with a reason', tone: !r ? 'neutral' : r.gates.some(g => g.kind === 'policy' && g.status === 'fail') ? 'hold' : 'ok' },
      { k: 'Promotion', v: promo.status === 'passed' ? 'Released' : LABEL[promo.status], small: promo.status !== 'passed', s: promo.status === 'passed' ? 'Verified in Salesforce' : 'Permanent once approved', tone: promo.status === 'passed' ? 'ok' : 'neutral' }
    ]);
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

  function stepPanel(def, index) {
    const step = data.state.run.steps[def.id];
    const reason = blockedReason(def, data.state.run.steps);
    const running = step.status === 'running';
    const retry = step.attempt > 0 && step.status !== 'pending';
    const details = el('details', { class: 'step s-' + step.status, open: openSteps.has(def.id) || ((step.status === 'failed' || step.status === 'needs-review') && !closedSteps.has(def.id)) },
      el('summary', {},
        el('div', { class: 's-main' },
          el('div', { class: 's-title' }, el('strong', {}, def.title), def.optional ? el('span', { class: 's-tag' }, 'optional') : null, def.requiresApproval ? el('span', { class: 's-tag' }, 'needs approval') : null),
          el('div', { class: 's-desc' }, step.message || def.description)),
        el('div', { class: 's-side' },
          pill(step.status),
          running
            ? el('button', { class: 'action danger sm', onclick: ev => { ev.preventDefault(); post({ type: 'cancel', stepId: def.id }); } }, icon('x'), 'Cancel')
            : el('button', {
              class: 'action sm' + (retry ? ' secondary' : ''), disabled: !!reason, title: reason || '',
              onclick: ev => { ev.preventDefault(); post({ type: retry ? 'retry' : 'run', stepId: def.id }); }
            }, icon(retry ? 'refresh' : 'play'), retry ? 'Retry' : 'Run'),
          icon('chevron', 'chev'))),
      el('div', { class: 'body' },
        el('p', {}, def.description),
        reason && step.status !== 'passed' ? el('div', { class: 'banner info' }, icon('info'), el('div', {}, 'Cannot run yet: ' + reason)) : null,
        step.message && step.status !== 'pending' ? el('p', {}, step.message) : null,
        step.failure ? el('div', { class: 'err' },
          el('strong', {}, step.failure.code + ': '), step.failure.message,
          step.failure.detail ? el('pre', { class: 'log-line' }, step.failure.detail) : null,
          step.failure.remediation ? el('div', { class: 'muted' }, 'Next: ' + step.failure.remediation) : null) : null,
        el('div', { class: 'meta' },
          el('span', {}, icon('list'), def.requirements.join(', ')), el('span', {}, icon('refresh'), 'Attempts ' + step.attempt),
          step.startedAt ? el('span', {}, icon('clock'), 'Started ' + fmt(step.startedAt)) : null, step.endedAt ? el('span', {}, icon('check'), 'Ended ' + fmt(step.endedAt)) : null,
          step.fingerprint ? el('span', {}, icon('lock'), 'Fingerprint ' + step.fingerprint.slice(0, 16)) : null),
        step.evidence.length ? el('div', { class: 'evidence' }, step.evidence.map(e => el('div', { class: 'evidence-row' }, icon('file'), el('strong', {}, e.label), el('span', { class: 'ref', title: e.ref }, e.ref),
          el('button', { class: 'action secondary sm', onclick: () => post({ type: 'openReport', ref: e.ref }) }, 'Open')))) : null
      ));
    details.addEventListener('toggle', () => {
      if (details.open) { openSteps.add(def.id); closedSteps.delete(def.id); } else { openSteps.delete(def.id); closedSteps.add(def.id); }
      persistUi();
    });
    return el('li', { class: 'step-card s-' + step.status },
      el('div', { class: 'rail' }, el('div', { class: 'node', title: LABEL[step.status] }, icon(STATUS_ICON[step.status], step.status === 'running' ? 'spin' : '')), el('div', { class: 'line' })),
      details);
  }

  function pipelineTab() {
    const steps = data.state.run.steps;
    const defs = data.definitions;
    const anyRunning = Object.values(steps).some(s => s.status === 'running');
    const count = pred => defs.filter(d => pred(steps[d.id].status)).length;
    const passed = count(s => s === 'passed' || s === 'skipped');
    const attention = count(s => s === 'failed' || s === 'needs-review' || s === 'stale' || s === 'blocked');
    const failed = count(s => s === 'failed');
    const pending = count(s => s === 'pending');
    const next = defs.find(d => { const s = steps[d.id].status; return s !== 'passed' && !(s === 'skipped' && d.optional); });
    const nextReason = next ? blockedReason(next, steps) : null;
    const nextState = next ? steps[next.id] : null;
    return el('div', {},
      tiles([
        { k: 'Progress', v: passed + ' / ' + defs.length, s: 'steps complete', tone: passed === defs.length ? 'ok' : 'info' },
        { k: 'Needs attention', v: String(attention), s: failed ? failed + ' failed' : attention ? 'review required' : 'nothing waiting', tone: failed ? 'bad' : attention ? 'hold' : 'ok' },
        { k: 'Not started', v: String(pending), s: 'steps pending', tone: 'neutral' },
        next ? { k: 'Next up', v: next.title, small: true, s: nextReason ? nextReason : (nextState.attempt ? 'Ready to retry' : 'Ready to run'), tone: nextReason ? 'neutral' : 'info',
          action: nextReason || anyRunning ? null : el('button', { class: 'action sm', onclick: () => post({ type: nextState.attempt ? 'retry' : 'run', stepId: next.id }) }, icon('play'), 'Run now') }
          : { k: 'Next up', v: 'All steps complete', small: true, tone: 'ok' }
      ]),
      el('div', { class: 'segbar', 'aria-hidden': 'true' }, defs.map(d => el('div', { class: 'seg tone-' + STATUS_TONE[steps[d.id].status], title: d.title + ': ' + LABEL[steps[d.id].status] }))),
      el('div', { class: 'toolbar' },
        el('button', { class: 'action', disabled: anyRunning, onclick: () => post({ type: 'resume' }) }, icon('play'), 'Resume pipeline'),
        el('button', { class: 'action secondary', disabled: anyRunning, onclick: () => post({ type: 'newRun' }) }, icon('plus'), 'New release run'),
        el('span', { class: 'muted' }, 'Run ' + data.state.run.id.slice(0, 8) + ' · started ' + fmt(data.state.run.startedAt))),
      el('ol', { class: 'steps', 'aria-label': 'Release pipeline' }, defs.map(stepPanel)));
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
    const parts = [projectTiles(d)];
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
    parts.push(t ? el('div', { class: 'chips' },
      chip(t.sf ? 'ok' : 'bad', t.sf ? 'check' : 'x', 'Salesforce CLI', t.sf ? t.sf.split(' ')[0].replace('@salesforce/cli/', '') : 'not found'),
      chip(t.codeAnalyzer ? 'ok' : 'bad', t.codeAnalyzer ? 'check' : 'x', 'Code Analyzer', t.codeAnalyzer ? t.codeAnalyzer.version : 'not installed'),
      chip('ok', 'check', 'Node', t.node), chip(d.git && d.git.version ? 'ok' : 'bad', d.git && d.git.version ? 'check' : 'x', 'Git', d.git && d.git.version ? d.git.version.replace('git version ', '') : 'not found')) : el('p', { class: 'muted' }, 'Not discovered yet.'));

    parts.push(el('h2', {}, 'Source control'));
    const g = d.git;
    parts.push(g && g.isRepo
      ? el('div', { class: 'chips' }, chip('ok', 'branch', 'Branch', g.branch), chip('ok', 'check', 'HEAD', (g.head || '').slice(0, 8)),
        chip(g.files.length ? 'warn' : 'ok', g.files.length ? 'alert' : 'check', 'Uncommitted', String(g.files.length)), chip('ok', 'lock', 'Fingerprint', (g.fingerprint || '').slice(0, 12)))
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


  function packageTab() {
    const pk = data.packaging || { candidates: [] };
    const steps = data.state.run.steps;
    const busy = !!data.busy;
    const def = id => data.definitions.find(d => d.id === id);
    const why = id => blockedReason(def(id), steps);
    const parts = [packageTiles(pk)];
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
    if (e.signoff) { parts.push(el('div', {}, el('span', { class: 'badge passed' }, icon('check'), 'Signed off by ' + e.signoff.approver + ' \u00B7 ' + fmt(e.signoff.at)))); }
    parts.push(table(['Field', 'Value'], [
      ['Org ID / user', (e.orgId || 'pending') + ' / ' + (e.username || 'pending')], ['Dev Hub', e.devHubAlias + ' (' + e.devHubOrgId + ')'],
      ['Version under test', (e.targetVersion || '') + ' ' + e.targetVersionId], e.kind === 'upgrade' ? ['Upgraded from (released)', (e.baselineVersion || '') + ' ' + (e.baselineVersionId || '')] : null,
      ['Installed version verified', e.verifiedInstalledVersion || 'not yet'], ['Install request', e.installRequestId || '-'],
      ['Created / expires', fmt(e.createdAt) + ' / ' + (e.expiresAt ? fmt(e.expiresAt) : '-')]
    ].filter(Boolean).map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v))), ''));
    if (e.failure) { parts.push(el('div', { class: 'err' }, el('strong', {}, 'Stopped at ' + (e.failedPhase ? PHASE_LABEL[e.failedPhase] : 'a phase') + ': '), e.failure)); }
    parts.push(table(['Phase', 'Result', 'Detail'], PHASE_ORDER.filter(ph => e.phases[ph] || (e.kind === 'upgrade' || (ph !== 'baseline' && ph !== 'seed'))).map(ph => {
      const st = e.phases[ph];
      return el('tr', {}, el('td', {}, PHASE_LABEL[ph]), el('td', {}, phasePill(st)), el('td', {}, (st && st.detail) || ''));
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
      el('button', { class: 'action danger', disabled: busy || !e.orgId || e.status === 'deleted', onclick: () => post({ type: 'qaDelete', envId: e.id }) }, icon('x'), 'Delete scratch org...')));
    parts.push(el('h2', {}, 'Manual QA checklist'));
    parts.push(el('p', { class: 'muted' }, 'Installation success does not mean the product works. Each item must be verified by a person and explicitly marked; nothing passes by inference.'));
    e.checklist.forEach(i => parts.push(el('div', { class: 'finding' },
      el('div', {}, checklistPill(i.state), ' ', i.text),
      i.note || i.by ? el('div', { class: 'muted' }, (i.by ? i.by + ' ' : '') + (i.at ? fmt(i.at) : '') + (i.note ? ' \u00B7 ' + i.note : '')) : null,
      el('div', { class: 'toolbar' },
        el('button', { class: 'action secondary', disabled: busy || !live || !!e.signoff, onclick: () => post({ type: 'qaMark', envId: e.id, itemId: i.id, state: 'pass' }) }, 'Mark Pass'),
        el('button', { class: 'action secondary', disabled: busy || !live || !!e.signoff, onclick: () => post({ type: 'qaMark', envId: e.id, itemId: i.id, state: 'fail' }) }, 'Mark Fail...')))));
    parts.push(el('div', { class: 'toolbar' }, el('button', { class: 'action', disabled: busy || !live || !allPass || !!e.signoff, title: allPass ? '' : 'Mark every item Pass first', onclick: () => post({ type: 'qaSignOff', envId: e.id }) }, e.signoff ? 'Signed off ' + fmt(e.signoff.at) : 'Sign Off QA...')));
    return el('details', { class: 'step', open: true }, el('summary', {}, el('div', { class: 's-main' }, el('div', { class: 's-title' }, el('strong', {}, (e.kind === 'upgrade' ? 'Upgrade test: ' : 'Fresh install: ') + e.alias))),
      el('div', { class: 's-side' }, el('span', { class: 'badge ' + (e.status === 'ready' ? 'pass' : e.status === 'failed' ? 'fail' : '') }, e.status), icon('chevron', 'chev'))), el('div', { class: 'body' }, parts));
  }

  function qaTab() {
    const q = data.qa || { envs: [], definition: [] };
    const steps = data.state.run.steps;
    const busy = !!data.busy;
    const def = id => data.definitions.find(d => d.id === id);
    const why = id => blockedReason(def(id), steps);
    const parts = [qaTiles(q, steps), el('h2', {}, 'QA environments')];
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

  const GATE_KIND = { hard: 'Required', policy: 'Policy', advisory: 'Advisory' };

  function releaseTab() {
    const rel = data.release || { history: [] };
    const r = rel.report;
    const steps = data.state.run.steps;
    const busy = !!data.busy;
    const def = id => data.definitions.find(d => d.id === id);
    const why = id => blockedReason(def(id), steps);
    const parts = [releaseTiles(rel, steps), el('h2', {}, 'Release readiness and promotion')];
    parts.push(el('p', { class: 'muted' }, 'Release Readiness re-checks every gate against Salesforce and the saved evidence for the exact candidate. Promotion is a separate, explicit, permanent action and is never triggered automatically.'));
    const reviewStep = steps['release-review'];
    const promoStep = steps.promotion;
    const canPromote = reviewStep.status === 'passed' && promoStep.status !== 'passed' && !busy && data.workspace.trusted;
    const files = reviewStep.evidence.filter(e => /^release-readiness-/.test(e.kind));
    parts.push(el('div', { class: 'toolbar' },
      el('button', { class: 'action', disabled: busy || !!why('release-review'), title: why('release-review') || '', onclick: () => post({ type: 'run', stepId: 'release-review' }) }, 'Run Release Readiness'),
      el('button', { class: 'action', disabled: !canPromote, title: canPromote ? 'Shows the full summary, then requires you to type the 04t' : 'Release Readiness must pass first', onclick: () => post({ type: 'promote' }) }, 'Approve & Promote...'),
      files.map(f => [el('button', { class: 'action secondary', onclick: () => post({ type: 'openReport', ref: f.ref }) }, 'Open ' + f.kind.replace('release-readiness-', '').toUpperCase()),
        el('button', { class: 'action secondary', onclick: () => post({ type: 'exportReport', ref: f.ref }) }, 'Export ' + f.kind.replace('release-readiness-', '').toUpperCase() + '...')])));
    const rw = why('release-review');
    if (rw) { parts.push(el('p', { class: 'muted' }, 'Release Readiness is unavailable: ' + rw)); }
    if (promoStep.status === 'passed') { parts.push(el('div', { class: 'banner ok', role: 'status' }, icon('check'), el('div', {}, promoStep.message || 'Promoted.'))); }
    else if (promoStep.status === 'needs-review' || promoStep.status === 'failed') { parts.push(el('div', { class: 'err', role: 'alert' }, el('strong', {}, 'Promotion: ' + promoStep.status + '. '), promoStep.failure ? promoStep.failure.message : (promoStep.message || ''),
      promoStep.failure && promoStep.failure.remediation ? el('div', { class: 'muted' }, 'Next: ' + promoStep.failure.remediation) : null)); }

    if (!r) { parts.push(el('div', { class: 'empty' }, 'No readiness report yet. Complete package QA, then run Release Readiness.')); }
    else {
      parts.push(el('div', { class: r.ready ? 'banner ok' : 'err', role: 'status' }, el('strong', {}, r.ready ? 'READY for promotion approval' : 'NOT READY'),
        ' \u00B7 ' + r.package.name + ' ' + ((r.candidate && r.candidate.version) || '') + ' \u00B7 ' + (r.candidate ? r.candidate.versionId : 'no candidate') + ' \u00B7 Dev Hub ' + r.devHub.alias + ' (' + r.devHub.orgId + ')'));
      parts.push(el('p', { class: 'muted' }, 'Generated ' + fmt(r.generatedAt) + ' \u00B7 source ' + (r.sourceFingerprint || '').slice(0, 12) + ' \u00B7 evidence hash ' + r.evidenceHash.slice(0, 16)));
      parts.push(table(['Summary', ''], [['Static analysis', r.summary.analysis], ['Apex tests', r.summary.tests], ['Org-wide coverage', r.summary.coverage], ['Package-version coverage', r.summary.packageCoverage]]
        .map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v || 'n/a'))), ''));
      parts.push(table(['Gate', 'Type', 'Result', 'Detail'], r.gates.map(g => el('tr', {},
        el('td', {}, g.title), el('td', {}, GATE_KIND[g.kind]), el('td', {}, GATE_RESULT[g.status]),
        el('td', {}, g.detail, g.remediation && g.status === 'fail' ? el('div', { class: 'muted' }, 'Next: ' + g.remediation) : null,
          g.override ? el('div', { class: 'muted' }, 'Override by ' + g.override.owner + ' ' + fmt(g.override.at) + ': ' + g.override.reason) : null,
          g.kind === 'policy' && g.status === 'fail' ? el('div', {}, el('button', { class: 'action secondary', disabled: busy, onclick: () => post({ type: 'overrideGate', gateId: g.id }) }, 'Override with justification...')) : null,
          g.status === 'overridden' ? el('div', {}, el('button', { class: 'action secondary', disabled: busy, onclick: () => post({ type: 'removeOverride', gateId: g.id }) }, 'Remove override')) : null))), ''));
      if (r.hardBlockers.length) { parts.push(el('h2', {}, 'Blockers that cannot be overridden')); r.hardBlockers.forEach(b => parts.push(el('div', { class: 'err' }, b))); }
      if (r.warnings.length) { parts.push(el('h2', {}, 'Remaining warnings')); r.warnings.forEach(w => parts.push(el('div', { class: 'finding' }, w))); }
    }
    if (rel.promotion) {
      parts.push(el('h2', {}, 'Promotion record'));
      parts.push(el('p', {}, rel.promotion.versionId + ' \u00B7 ' + rel.promotion.status + ' \u00B7 approver ' + rel.promotion.approver + ' \u00B7 ' + fmt(rel.promotion.startedAt) + (rel.promotion.error ? ' \u00B7 ' + rel.promotion.error : '')));
    }
    if (rel.nextSteps && rel.nextSteps.length) {
      parts.push(el('h2', {}, 'Next steps'));
      rel.nextSteps.forEach(n => parts.push(el('div', { class: 'finding' }, n)));
    }
    parts.push(el('h2', {}, 'Release history'));
    parts.push(releaseHistoryTable(rel.history));
    return el('div', {}, parts);
  }

  function releaseHistoryTable(h) {
    return table(['Released', 'Package', 'Version', '04t', 'Dev Hub', 'Approver', 'Package coverage', 'Receipt'], (h || []).map(e => el('tr', {},
      el('td', {}, fmt(e.at)), el('td', {}, e.packageName), el('td', {}, e.version || '-'), el('td', {}, e.versionId), el('td', {}, e.devHubAlias + ' (' + e.devHubOrgId + ')'),
      el('td', {}, e.approver + (e.verifiedOnly ? ' (verified only)' : '')), el('td', {}, e.coverage === undefined ? '-' : e.coverage + '%'),
      el('td', {}, el('button', { class: 'action secondary', onclick: () => post({ type: 'openReport', ref: e.receiptRef }) }, 'Open')))), 'No versions have been released through ReleasePilot yet.');
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
    parts.push(el('div', { class: 'chips' }, chip('neutral', 'list', 'Findings', String(c.total)), chip(c.Critical ? 'bad' : 'ok', c.Critical ? 'x' : 'check', 'Critical', String(c.Critical)),
      chip(c.High ? 'bad' : 'ok', c.High ? 'x' : 'check', 'High', String(c.High)), chip(c.Moderate ? 'warn' : 'ok', c.Moderate ? 'alert' : 'check', 'Moderate', String(c.Moderate)), chip('neutral', 'info', 'Low', String(c.Low)),
      chip(a.blockers ? 'bad' : 'ok', a.blockers ? 'lock' : 'check', 'Blocking at ' + q.gate + '+', String(a.blockers))));
    parts.push(el('p', { class: 'muted' }, 'Scanned ' + fmt(a.at)));
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
        el('td', {}, t.outcome === 'Pass' ? checkPill('pass') : t.outcome === 'Skip' ? checkPill('na') : el('span', { class: 'badge fail' }, icon('x'), t.outcome)),
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
    return el('div', {}, qualityTiles(q), analysisSection(q), testsSection(q));
  }

  function logsTab() {
    const logs = data.state.logs;
    return el('div', {},
      el('div', { class: 'toolbar' }, el('button', { class: 'action secondary', onclick: () => post({ type: 'showLogs' }) }, icon('terminal'), 'Open output channel'),
        el('span', { class: 'muted' }, 'Showing the latest ' + Math.min(300, logs.length) + ' of ' + logs.length + ' entries. Secrets are redacted.')),
      logs.length ? el('div', { class: 'logbox' }, logs.slice(-300).reverse().map(l =>
        el('div', { class: 'logrow lvl-' + l.level }, el('span', { class: 'muted' }, fmt(l.at)), el('span', { class: 'lv' }, l.level.toUpperCase()), el('span', { class: 'muted' }, l.scope), el('span', { class: 'msg' }, l.message))))
        : emptyState('No log entries yet.', 'terminal'));
  }

  function errorsTab() {
    const failing = Object.values(data.state.run.steps).filter(s => s.failure);
    const derrs = (data.discovery && data.discovery.errors) || [];
    if (!failing.length && !derrs.length) { return emptyState('No errors recorded in this run.', 'check'); }
    return el('div', {},
      derrs.map(e => el('div', { class: 'err' }, el('strong', {}, 'Discovery (' + e.scope + ') — ' + e.code),
        el('div', {}, e.message), e.remediation ? el('div', { class: 'muted' }, 'Next: ' + e.remediation) : null)),
      failing.map(s => {
        const def = data.definitions.find(d => d.id === s.id);
        return el('div', { class: 'err' }, el('strong', {}, def.title + ' — ' + s.failure.code),
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

  function historyView() {
    const rel = (data.release && data.release.history) || [];
    return el('div', {}, el('h2', {}, 'Released versions'), releaseHistoryTable(rel), el('h2', {}, 'Release runs'), historyTab());
  }

  function settingsTab() {
    const s = data.settings;
    const row = (id, label, hint, control) => el('div', { class: 'setting' }, el('label', { for: id }, label), control ? el('div', { class: 'ctl' }, control) : null, el('div', { class: 'hint' }, hint));
    const num = (key, label, min, max, hint) => {
      const input = el('input', { type: 'number', min, max, value: s[key], id: 'set-' + key });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= min && v <= max) { post({ type: 'setSetting', key, value: v }); } else { input.value = s[key]; }
      });
      return row('set-' + key, label, hint, input);
    };
    const choice = (key, label, options, hint) => {
      const sel = el('select', { id: 'set-' + key }, options.map(o => el('option', { value: o, selected: s[key] === o }, o)));
      sel.addEventListener('change', () => post({ type: 'setSetting', key, value: sel.value }));
      return row('set-' + key, label, hint, sel);
    };
    const toggle = (key, label, hint) => {
      const box = el('input', { type: 'checkbox', class: 'switch', id: 'set-' + key, checked: s[key], role: 'switch' });
      box.addEventListener('change', () => post({ type: 'setSetting', key, value: box.checked }));
      return row('set-' + key, label, hint, box);
    };
    return el('div', {},
      el('h2', {}, 'Analysis'),
      choice('severityGate', 'Analyzer severity gate', ['none', 'critical', 'high', 'moderate', 'low'], 'Untriaged findings at or above this severity block the pipeline.'),
      row('rules', 'Rule selectors', 'Edit "releasepilot.ruleSelectors" in VS Code settings (for example add AppExchange).', el('span', { class: 'muted' }, (s.ruleSelectors || []).join(', '))),
      toggle('allowDirtySource', 'Allow uncommitted source', 'Lets Source Ready pass with uncommitted changes. Not recommended for release candidates.'),
      el('h2', {}, 'Testing'),
      choice('testLevel', 'Apex test level', ['RunLocalTests', 'RunAllTestsInOrg'], 'Test level for the Pre-package Tests step.'),
      toggle('deployBeforeTests', 'Deploy local source before tests', 'Asks for confirmation, then deploys package directories to the validation org. If off, test results cannot pass the gate.'),
      num('testWaitMinutes', 'Deploy / test wait (minutes)', 1, 600, 'A local timeout never cancels remote jobs.'),
      num('coverageTargetPercent', 'Internal coverage target (%)', 0, 100, 'Org-level target. Salesforce package-version coverage (minimum 75%) is evaluated separately.'),
      el('h2', {}, 'Package builds'),
      choice('installationKeyPolicy', 'Installation key policy', ['require', 'allow-bypass'], 'require: every build needs a key (asked each time, never stored). allow-bypass: an empty key after explicit confirmation.'),
      num('buildWaitMinutes', 'Package build wait (minutes)', 1, 720, 'Local tracking limit. A timeout never cancels the build; retry continues the same request.'),
      num('buildPollSeconds', 'Build status poll (seconds)', 5, 120, 'Interval between status checks.'),
      el('h2', {}, 'QA environments'),
      num('qaOrgDurationDays', 'QA org lifetime (days)', 1, 30, 'Scratch org expiry. The org is never deleted automatically.'),
      num('qaWaitMinutes', 'QA create / install wait (minutes)', 1, 120, 'Local limit; a timeout never cancels remote work.'),
      choice('qaSecurityType', 'Install security type', ['AdminsOnly', 'AllUsers'], 'Who gets access to the package in the QA org.'),
      toggle('openOrgAfterInstall', 'Open org after preparing', 'Permission sets, scripts and checklists: edit the releasepilot.qa* settings in VS Code.'),
      el('h2', {}, 'General'),
      num('logRetentionEntries', 'Log retention (entries)', 100, 50000, 'Persisted log size.'),
      num('stepTimeoutMinutes', 'Step timeout (minutes)', 1, 720, 'Applies after reload. A local timeout never cancels remote jobs.'));
  }

  function orgSelect(label, current, orgs, type, iconName, required) {
    const sel = el('select', { 'aria-label': label, disabled: !!data.busy },
      el('option', { value: '' }, '(none selected)'),
      orgs.map(o => el('option', { value: o.alias || o.username, title: o.username + ' (' + o.orgId + ')', selected: current && current.username === o.username }, o.alias || o.username)));
    sel.addEventListener('change', () => post({ type, alias: sel.value }));
    return el('label', { class: 'ctx' + (required && !current ? ' missing' : ''), title: required && !current ? label + ' is required: choose one' : null }, el('span', {}, icon(iconName), label), sel);
  }

  function selectors() {
    const folders = data.workspace.folders;
    const d = data.discovery || {};
    const orgs = d.orgs || [];
    const proj = el('select', { 'aria-label': 'Project', disabled: !!data.busy }, folders.length
      ? folders.map(f => el('option', { value: f.path, title: f.path, selected: f.path === data.selectedRoot }, f.name))
      : [el('option', {}, 'No folder open')]);
    proj.addEventListener('change', () => post({ type: 'selectFolder', path: proj.value }));
    return [el('label', { class: 'ctx' }, el('span', {}, icon('folder'), 'Project'), proj),
      orgSelect('Dev Hub', d.devHub, orgs.filter(o => o.isDevHub), 'selectDevHub', 'cloud', true),
      orgSelect('Development org', d.devOrg, orgs.filter(o => !o.isDevHub || !o.isScratch), 'selectDevOrg', 'branch'),
      orgSelect('Validation org', d.validationOrg, orgs.filter(o => !d.devHub || o.orgId !== d.devHub.orgId), 'selectValidationOrg', 'flask')];
  }

  const PAGES = {
    pipeline: ['Release pipeline', 'From source validation to an approved package promotion. A step turns green only when real evidence backs it.'],
    project: ['Project & orgs', 'What ReleasePilot discovered: your DX project, tooling, authenticated orgs and Dev Hub packages.'],
    quality: ['Quality', 'Code Analyzer findings, Apex tests and coverage for the current source.'],
    package: ['Package', 'Readiness checks and beta package builds on your Dev Hub.'],
    qa: ['QA environments', 'Scratch orgs with the exact candidate installed, plus the manual checklist and sign-off.'],
    release: ['Release', 'Every gate re-verified against Salesforce, then an explicit, permanent promotion.'],
    errors: ['Errors', 'Problems found in this run, with what to do next.'],
    reports: ['Reports & artifacts', 'Evidence produced by steps. Open it in VS Code or export a copy.'],
    logs: ['Logs', 'A redacted, persistent record of what ReleasePilot did.'],
    history: ['History', 'Released versions and archived release runs.'],
    settings: ['Settings', 'Quality gates, timeouts and QA behaviour. More options live in VS Code settings under ReleasePilot.']
  };
  const NAV = [
    ['Workflow', [['pipeline', 'pipeline', ['preflight', 'source', 'analysis', 'tests', 'package-readiness', 'package-build', 'clean-install-qa', 'upgrade-qa', 'release-review', 'promotion']],
      ['project', 'folder', ['preflight', 'source']], ['quality', 'shield', ['analysis', 'tests']], ['package', 'package', ['package-readiness', 'package-build']],
      ['qa', 'flask', ['clean-install-qa', 'upgrade-qa']], ['release', 'rocket', ['release-review', 'promotion']]]],
    ['Insights', [['errors', 'alert'], ['reports', 'file'], ['logs', 'terminal'], ['history', 'history']]]
  ];
  const NAV_TITLE = { pipeline: 'Pipeline', project: 'Project', quality: 'Quality', package: 'Package', qa: 'QA', release: 'Release', errors: 'Errors', reports: 'Reports', logs: 'Logs', history: 'History', settings: 'Settings' };
  const SEVERITY = ['failed', 'blocked', 'needs-review', 'stale', 'running'];
  let dismissedNotice = saved.dismissed || '';

  function navDot(stepIds) {
    const steps = data.state.run.steps;
    const sts = stepIds.map(id => steps[id].status);
    const worst = SEVERITY.find(s => sts.includes(s));
    if (worst) { return STATUS_TONE[worst]; }
    return sts.every(s => s === 'passed' || s === 'skipped') ? 'ok' : null;
  }

  function sidebar(errorCount) {
    const item = (id, iconName, stepIds) => {
      const dot = stepIds ? navDot(stepIds) : null;
      return el('button', { class: 'nav-item', 'aria-current': tab === id ? 'page' : null, onclick: () => { tab = id; persistUi(); render(); } },
        icon(iconName), el('span', {}, NAV_TITLE[id]),
        id === 'errors' && errorCount ? el('span', { class: 'count', 'aria-label': errorCount + ' errors' }, String(errorCount)) : null,
        dot ? el('span', { class: 'nav-dot tone-' + dot, title: dot === 'ok' ? 'Complete' : 'Needs attention' }) : null);
    };
    return el('nav', { class: 'sidebar', 'aria-label': 'ReleasePilot sections' },
      el('div', { class: 'brand' }, el('div', { class: 'logo' }, icon('rocket')), el('div', {}, el('b', {}, 'ReleasePilot'), el('small', {}, 'Managed 2GP releases'))),
      NAV.map(([label, items]) => [el('div', { class: 'nav-label' }, label), items.map(([id, ic, ids]) => item(id, ic, ids))]),
      el('div', { class: 'nav-label' }, 'Configure'), item('settings', 'sliders'),
      el('div', { class: 'sidebar-foot' }, 'TwinStack Solutions'));
  }

  function topbar() {
    const busy = data.busy;
    return el('div', { class: 'topbar' }, selectors(), el('span', { class: 'spacer' }),
      el('span', { class: 'status-chip' + (busy ? ' busy' : '') }, icon(busy ? 'loader' : 'check', busy ? 'spin' : ''), busy ? busy + '…' : 'Ready'),
      el('button', { class: 'icon', title: 'Re-run discovery', 'aria-label': 'Re-run discovery', disabled: !!busy, onclick: () => post({ type: 'discover' }) }, icon('refresh')));
  }

  const VIEWS = { pipeline: pipelineTab, project: projectTab, quality: qualityTab, package: packageTab, qa: qaTab, release: releaseTab, logs: logsTab, errors: errorsTab, reports: reportsTab, history: historyView, settings: settingsTab };

  function render() {
    if (!data) { app.replaceChildren(el('div', { class: 'content' }, el('p', { class: 'muted' }, 'Loading…'))); return; }
    const errorCount = Object.values(data.state.run.steps).filter(s => s.failure).length + ((data.discovery && data.discovery.errors) || []).length;
    const view = cardify(VIEWS[tab]());
    const [title, subtitle] = PAGES[tab];
    const notice = data.notice && data.notice.text !== dismissedNotice ? data.notice : null;
    app.replaceChildren(el('div', { class: 'app' }, sidebar(errorCount), el('main', { class: 'main' }, topbar(),
      el('div', { class: 'content' },
        data.workspace.trusted ? null : el('div', { class: 'banner', role: 'alert' }, icon('lock'), el('div', {}, 'This workspace is not trusted. ReleasePilot is read-only until you trust it.')),
        data.cliAvailable === false ? el('div', { class: 'err', role: 'alert' }, 'Salesforce CLI (sf) was not found on PATH. Install it and restart VS Code.') : null,
        notice ? el('div', { class: 'banner ' + (notice.level === 'error' ? '' : 'info'), role: 'alert', style: notice.level === 'error' ? '--tone:var(--bad)' : null },
          icon(notice.level === 'error' ? 'alert' : 'info'), el('div', {}, notice.text),
          el('button', { class: 'callout-x', 'aria-label': 'Dismiss', onclick: () => { dismissedNotice = notice.text; persistUi(); render(); } }, icon('x'))) : null,
        el('div', { class: 'page-head' }, el('h1', {}, title), subtitle ? el('p', {}, subtitle) : null),
        view))));
  }

  window.addEventListener('message', ev => {
    if (ev.data && ev.data.type === 'state') { data = ev.data; render(); }
  });
  render();
  post({ type: 'ready' });
})();
