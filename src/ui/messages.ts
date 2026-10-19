import { PIPELINE } from '../core/pipeline';
import { StepId } from '../core/models';

export const BOOLEAN_SETTINGS = ['allowDirtySource'] as const;
export type SettingKey = 'coverageTargetPercent' | 'logRetentionEntries' | 'stepTimeoutMinutes' | typeof BOOLEAN_SETTINGS[number];

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'run' | 'retry' | 'cancel'; stepId: StepId }
  | { type: 'resume' | 'newRun' | 'showLogs' | 'refresh' | 'discover' | 'retrievePreview' | 'retrieveApply' }
  | { type: 'selectFolder'; path: string }
  | { type: 'selectDevHub' | 'selectDevOrg' | 'selectPackage'; alias: string }
  | { type: 'setSetting'; key: SettingKey; value: number | boolean };

export const SETTINGS: Record<string, { min: number; max: number }> = {
  coverageTargetPercent: { min: 0, max: 100 },
  logRetentionEntries: { min: 100, max: 50000 },
  stepTimeoutMinutes: { min: 1, max: 720 }
};
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
      return { type: m.type };
    case 'selectFolder':
      return typeof m.path === 'string' && m.path.length > 0 && m.path.length < 1024 && !CONTROL_RE.test(m.path)
        ? { type: 'selectFolder', path: m.path } : undefined;
    case 'selectDevHub':
    case 'selectDevOrg':
    case 'selectPackage':
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
