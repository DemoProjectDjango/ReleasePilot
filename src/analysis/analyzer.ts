import * as fs from 'fs';
import * as path from 'path';
import { SfCli, SfError } from '../adapters/sfCli';

export type SeverityGate = 'none' | 'critical' | 'high' | 'moderate' | 'low';
export const SEVERITY_LABEL: Record<number, string> = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low', 5: 'Info' };
const GATE_LEVEL: Record<SeverityGate, number> = { none: 0, critical: 1, high: 2, moderate: 3, low: 4 };

export interface Fix {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  fixedCode: string;
}

export interface Finding {
  /** Stable identity used for triage: rule + file + line + message. */
  key: string;
  rule: string;
  engine: string;
  severity: number;
  severityLabel: string;
  /** Path relative to the analyzed workspace, forward slashes. */
  file: string;
  absFile: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  tags: string[];
  resources: string[];
  fix?: Fix;
  suggestions: string[];
}

export interface AnalysisReport {
  at: string;
  workspace: string;
  selectors: string[];
  versions: Record<string, string>;
  /** Source fingerprint the scan was taken against; used to detect outdated scans. */
  sourceFingerprint?: string;
  findings: Finding[];
  counts: Record<string, number>;
  jsonPath: string;
  htmlPath?: string;
  /**
   * Warnings the CLI printed (e.g. an engine could not parse a file). The JSON report does NOT contain
   * these, so a scan with warnings may be incomplete and must not be treated as clean.
   */
  warnings: string[];
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Normalizes a Code Analyzer v5 JSON report. Malformed entries are skipped, never invented. */
export function parseAnalyzerJson(text: string, workspace: string): { findings: Finding[]; versions: Record<string, string>; runDir?: string } {
  const j = o(JSON.parse(text));
  const runDir = str(j.runDir);
  const base = runDir ?? workspace;
  const versions: Record<string, string> = {};
  for (const [k, v] of Object.entries(o(j.versions))) {
    if (typeof v === 'string') {
      versions[k] = v;
    }
  }
  const findings: Finding[] = [];
  for (const raw of Array.isArray(j.violations) ? j.violations : []) {
    const v = o(raw);
    const locs = Array.isArray(v.locations) ? v.locations : [];
    const primary = o(locs[num(v.primaryLocationIndex) ?? 0] ?? locs[0]);
    const rule = str(v.rule);
    const severity = num(v.severity);
    const message = str(v.message);
    if (!rule || !severity || !message) {
      continue;
    }
    const file = str(primary.file);
    const absFile = file ? path.resolve(base, file) : '';
    const rel = file ? path.relative(workspace, absFile).replace(/\\/g, '/') : '(workspace)';
    const line = num(primary.startLine) ?? 1;
    const fixRaw = Array.isArray(v.fixes) ? o(v.fixes[0]) : {};
    const fixLoc = o(fixRaw.location);
    const fix: Fix | undefined = typeof fixRaw.fixedCode === 'string'
      ? {
        startLine: num(fixLoc.startLine) ?? line, startColumn: num(fixLoc.startColumn) ?? 1,
        endLine: num(fixLoc.endLine) ?? line, endColumn: num(fixLoc.endColumn) ?? 1,
        fixedCode: String(fixRaw.fixedCode)
      }
      : undefined;
    findings.push({
      key: `${rule}|${rel}|${line}|${message}`,
      rule, engine: str(v.engine) ?? 'unknown', severity, severityLabel: SEVERITY_LABEL[severity] ?? String(severity),
      file: rel, absFile, line, column: num(primary.startColumn) ?? 1, endLine: num(primary.endLine), endColumn: num(primary.endColumn),
      message,
      tags: (Array.isArray(v.tags) ? v.tags : []).filter((t): t is string => typeof t === 'string'),
      resources: (Array.isArray(v.resources) ? v.resources : []).filter((t): t is string => typeof t === 'string'),
      suggestions: (Array.isArray(v.suggestions) ? v.suggestions : []).map(s => str(o(s).message)).filter((t): t is string => !!t),
      fix
    });
  }
  return { findings, versions, runDir };
}

export function countBySeverity(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = { total: findings.length, Critical: 0, High: 0, Moderate: 0, Low: 0, Info: 0 };
  findings.forEach(f => { counts[f.severityLabel] = (counts[f.severityLabel] ?? 0) + 1; });
  return counts;
}

export type GroupBy = 'file' | 'severity' | 'rule';

export function groupFindings(findings: Finding[], by: GroupBy): Array<{ key: string; findings: Finding[] }> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = by === 'file' ? f.file : by === 'rule' ? f.rule : f.severityLabel;
    map.set(k, [...(map.get(k) ?? []), f]);
  }
  const groups = [...map.entries()].map(([key, list]) => ({ key, findings: list.sort((a, b) => a.severity - b.severity || a.line - b.line) }));
  return by === 'severity'
    ? groups.sort((a, b) => a.findings[0].severity - b.findings[0].severity)
    : groups.sort((a, b) => b.findings.length - a.findings.length || a.key.localeCompare(b.key));
}

export interface Triage {
  key: string;
  reason: string;
  owner: string;
  at: string;
}

/** Findings at or above the gate severity that have not been triaged with a justification. */
export function gateBlockers(findings: Finding[], gate: SeverityGate, triaged: ReadonlySet<string>): Finding[] {
  const level = GATE_LEVEL[gate];
  return level === 0 ? [] : findings.filter(f => f.severity <= level && !triaged.has(f.key));
}

/**
 * Applies an analyzer-provided fix (1-based line/column, end exclusive) to file text. Refuses when the
 * range is outside the file so a stale fix can never corrupt unrelated code.
 */
export function applyFix(text: string, fix: Fix): string {
  const lines = text.split('\n');
  const offsetOf = (line: number, col: number): number => {
    if (line < 1 || line > lines.length) {
      throw new Error('Fix range is outside the file; rescan before applying.');
    }
    let off = 0;
    for (let i = 0; i < line - 1; i++) {
      off += lines[i].length + 1;
    }
    const lineLen = lines[line - 1].replace(/\r$/, '').length;
    if (col < 1 || col - 1 > lineLen) {
      throw new Error('Fix range is outside the file; rescan before applying.');
    }
    return off + col - 1;
  };
  const start = offsetOf(fix.startLine, fix.startColumn);
  const end = offsetOf(fix.endLine, fix.endColumn);
  if (end < start) {
    throw new Error('Invalid fix range.');
  }
  return text.slice(0, start) + fix.fixedCode + text.slice(end);
}

export interface RunAnalyzerOptions {
  root: string;
  outputDir: string;
  selectors: string[];
  signal?: AbortSignal;
}

/** CLI notices that appear on healthy runs and say nothing about scan completeness. */
const BENIGN_WARNINGS = [/update available/i, /Could not find typescript/i];

/**
 * Groups the CLI's "»"-prefixed stderr lines (long messages are wrapped over several lines) into
 * one entry per "Warning:"/"Error:" block and drops known-benign notices. What remains, such as an
 * engine failing to parse a file, means the scan may be incomplete.
 */
export function extractWarnings(stderr: string): string[] {
  const blocks: string[] = [];
  for (const raw of stderr.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!line.startsWith('»')) {
      continue;
    }
    const text = line.replace(/^»\s*/, '').trim();
    if (!text) {
      continue;
    }
    if (/^(Warning|Error):/i.test(text) || blocks.length === 0) {
      blocks.push(text);
    } else {
      blocks[blocks.length - 1] += ' ' + text;
    }
  }
  return blocks.filter(blk => !BENIGN_WARNINGS.some(re => re.test(blk)));
}

const SELECTOR_RE = /^[A-Za-z0-9_:.,\-()&]{1,100}$/;

export function assertSelector(s: string): string {
  if (!SELECTOR_RE.test(s) || s.startsWith('-')) {
    throw new SfError('INVALID_ARGUMENT', `Invalid rule selector "${s}".`);
  }
  return s;
}

/**
 * Runs `sf code-analyzer run` and reads back its machine-readable report. The CLI's exit status is not
 * trusted for gating: findings are parsed and evaluated by policy.
 */
export async function runCodeAnalyzer(sf: SfCli, opts: RunAnalyzerOptions): Promise<AnalysisReport> {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(opts.outputDir, `code-analyzer-${stamp}.json`);
  const htmlPath = path.join(opts.outputDir, `code-analyzer-${stamp}.html`);
  const selectors = opts.selectors.length ? opts.selectors.map(assertSelector) : ['Recommended'];
  const args = ['code-analyzer', 'run', '--workspace', '.'];
  selectors.forEach(s => args.push('--rule-selector', s));
  args.push('--output-file', jsonPath, '--output-file', htmlPath, '--include-fixes', '--include-suggestions');
  const { stderr } = await sf.textWithStderr(args, { cwd: opts.root, signal: opts.signal, timeoutMs: 20 * 60_000 });
  if (!fs.existsSync(jsonPath)) {
    throw new SfError('NO_REPORT', 'Code Analyzer finished but wrote no JSON report.', 'Run "sf code-analyzer run" manually to see the underlying error.');
  }
  const parsed = parseAnalyzerJson(fs.readFileSync(jsonPath, 'utf8'), opts.root);
  return {
    at: new Date().toISOString(), workspace: opts.root, selectors, versions: parsed.versions,
    findings: parsed.findings, counts: countBySeverity(parsed.findings), jsonPath,
    htmlPath: fs.existsSync(htmlPath) ? htmlPath : undefined,
    warnings: extractWarnings(stderr)
  };
}
