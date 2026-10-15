import { PIPELINE } from '../core/pipeline';
import { StepId } from '../core/models';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'run' | 'retry' | 'cancel'; stepId: StepId }
  | { type: 'resume' | 'newRun' | 'showLogs' | 'refresh' }
  | { type: 'setSetting'; key: SettingKey; value: number };

export const SETTINGS: Record<string, { min: number; max: number }> = {
  coverageTargetPercent: { min: 0, max: 100 },
  logRetentionEntries: { min: 100, max: 50000 },
  stepTimeoutMinutes: { min: 1, max: 720 }
};
export type SettingKey = 'coverageTargetPercent' | 'logRetentionEntries' | 'stepTimeoutMinutes';

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
      return { type: m.type };
    case 'run':
    case 'retry':
    case 'cancel':
      return typeof m.stepId === 'string' && STEP_IDS.has(m.stepId)
        ? { type: m.type, stepId: m.stepId as StepId }
        : undefined;
    case 'setSetting': {
      const key = m.key;
      const value = m.value;
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
