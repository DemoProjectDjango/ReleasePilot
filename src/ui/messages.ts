import { PIPELINE } from '../core/pipeline';
import { StepId } from '../core/models';

export const BOOLEAN_SETTINGS = ['allowDirtySource', 'deployBeforeTests', 'openOrgAfterInstall'] as const;
export const ENUM_SETTINGS: Record<string, readonly string[]> = {
  severityGate: ['none', 'critical', 'high', 'moderate', 'low'],
  testLevel: ['RunLocalTests', 'RunAllTestsInOrg'],
  installationKeyPolicy: ['require', 'allow-bypass'],
  qaSecurityType: ['AdminsOnly', 'AllUsers']
};
export type SettingKey = 'coverageTargetPercent' | 'logRetentionEntries' | 'stepTimeoutMinutes' | 'testWaitMinutes' | 'severityGate' | 'testLevel' | 'installationKeyPolicy' | 'qaSecurityType' | 'qaOrgDurationDays' | 'qaWaitMinutes' | 'buildWaitMinutes' | 'buildPollSeconds' | typeof BOOLEAN_SETTINGS[number];

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'run' | 'retry' | 'cancel'; stepId: StepId }
  | { type: 'resume' | 'newRun' | 'showLogs' | 'refresh' | 'discover' | 'retrievePreview' | 'retrieveApply' | 'rerunFailed' | 'exportSummary' | 'refreshBuild' | 'promote' | 'quickScan' | 'openProject' }
  | { type: 'openFile'; key: string }
  | { type: 'copyCmd'; id: string }
  | { type: 'overrideGate' | 'removeOverride'; gateId: string }
  | { type: 'qaMark'; envId: string; itemId: string; state: 'pass' | 'fail' }
  | { type: 'qaSignOff' | 'qaDelete' | 'qaOpen'; envId: string }
  | { type: 'openReport' | 'exportReport'; ref: string }
  | { type: 'triage' | 'untriage' | 'applyFix'; key: string }
  | { type: 'selectFolder'; path: string }
  | { type: 'selectDevHub' | 'selectDevOrg' | 'selectPackage' | 'selectValidationOrg'; alias: string }
  | { type: 'setSetting'; key: SettingKey; value: number | boolean | string };

export const SETTINGS: Record<string, { min: number; max: number }> = {
  coverageTargetPercent: { min: 0, max: 100 },
  logRetentionEntries: { min: 100, max: 50000 },
  stepTimeoutMinutes: { min: 1, max: 720 },
  testWaitMinutes: { min: 1, max: 600 },
  qaOrgDurationDays: { min: 1, max: 30 },
  qaWaitMinutes: { min: 1, max: 120 },
  buildWaitMinutes: { min: 1, max: 720 },
  buildPollSeconds: { min: 5, max: 120 }
};
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const REF_RE = /^[^\u0000\r\n]{1,2000}$/;
const ALIAS_RE = /^[A-Za-z0-9_.@+-]{1,128}$/;
const CONTROL_RE = /[\u0000\r\n]/;

const STEP_IDS = new Set<string>(PIPELINE.map(p => p.id));

/** Validates untrusted data coming from the webview. Returns undefined when invalid. */
export function parseMessage(raw: unknown): WebviewMessage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'resume':
    case 'newRun':
    case 'showLogs':
    case 'refresh':
    case 'discover':
    case 'retrievePreview':
    case 'retrieveApply':
    case 'rerunFailed':
    case 'exportSummary':
    case 'refreshBuild':
    case 'promote':
    case 'quickScan':
    case 'openProject':
      return { type: m.type };
    case 'qaMark':
      return typeof m.envId === 'string' && ID_RE.test(m.envId) && typeof m.itemId === 'string' && /^c\d{1,3}$/.test(m.itemId) && (m.state === 'pass' || m.state === 'fail')
        ? { type: 'qaMark', envId: m.envId, itemId: m.itemId, state: m.state } : undefined;
    case 'copyCmd':
      return typeof m.id === 'string' && /^[a-z-]{1,40}$/.test(m.id) ? { type: 'copyCmd', id: m.id } : undefined;
    case 'overrideGate':
    case 'removeOverride':
      return typeof m.gateId === 'string' && /^[a-z0-9-]{1,40}$/.test(m.gateId) ? { type: m.type, gateId: m.gateId } : undefined;
    case 'qaSignOff':
    case 'qaDelete':
    case 'qaOpen':
      return typeof m.envId === 'string' && ID_RE.test(m.envId) ? { type: m.type, envId: m.envId } : undefined;
    case 'openFile':
    case 'triage':
    case 'untriage':
    case 'applyFix':
      return typeof m.key === 'string' && REF_RE.test(m.key) ? { type: m.type, key: m.key } : undefined;
    case 'openReport':
    case 'exportReport':
      return typeof m.ref === 'string' && REF_RE.test(m.ref) ? { type: m.type, ref: m.ref } : undefined;
    case 'selectFolder':
      return typeof m.path === 'string' && m.path.length > 0 && m.path.length < 1024 && !CONTROL_RE.test(m.path)
        ? { type: 'selectFolder', path: m.path } : undefined;
    case 'selectDevHub':
    case 'selectDevOrg':
    case 'selectPackage':
    case 'selectValidationOrg':
      // An empty string clears the selection; anything else must look like an alias, username or ID.
      return typeof m.alias === 'string' && (m.alias === '' || (ALIAS_RE.test(m.alias) && !m.alias.startsWith('-')))
        ? { type: m.type, alias: m.alias } : undefined;
    case 'run':
    case 'retry':
    case 'cancel':
      return typeof m.stepId === 'string' && STEP_IDS.has(m.stepId)
        ? { type: m.type, stepId: m.stepId as StepId }
        : undefined;
    case 'setSetting': {
      const key = m.key;
      const value = m.value;
      if (typeof key === 'string' && (BOOLEAN_SETTINGS as readonly string[]).includes(key)) {
        return typeof value === 'boolean' ? { type: 'setSetting', key: key as SettingKey, value } : undefined;
      }
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(ENUM_SETTINGS, key)) {
        return typeof value === 'string' && ENUM_SETTINGS[key].includes(value) ? { type: 'setSetting', key: key as SettingKey, value } : undefined;
      }
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(SETTINGS, key)) {
        return undefined;
      }
      const range = SETTINGS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
        return undefined;
      }
      return { type: 'setSetting', key: key as SettingKey, value };
    }
    default:
      return undefined;
  }
}
