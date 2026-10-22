import { AnalysisReport, Finding } from '../analysis/analyzer';
import { QualityState } from './qualityStore';

/**
 * Chooses which scan the Quality page shows. A quick scan is ad hoc: it is never release evidence, so it only
 * replaces the pipeline scan on screen when it is newer, and is always flagged as ad hoc.
 */
export function pickAnalysis(q: QualityState): { report?: AnalysisReport; adHoc: boolean } {
  if (q.quick && (!q.analysis || q.quick.at > q.analysis.at)) {
    return { report: q.quick, adHoc: true };
  }
  return { report: q.analysis, adHoc: false };
}

/** Finds a finding by key in either scan, with the report it belongs to (fixes must be checked against that report). */
export function findInReports(q: QualityState, key: string): { finding: Finding; report: AnalysisReport; adHoc: boolean } | undefined {
  for (const [report, adHoc] of [[q.quick, true], [q.analysis, false]] as Array<[AnalysisReport | undefined, boolean]>) {
    const finding = report?.findings.find(f => f.key === key);
    if (report && finding) {
      return { finding, report, adHoc };
    }
  }
  return undefined;
}
