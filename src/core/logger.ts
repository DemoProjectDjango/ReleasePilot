import { LogEntry, StepId } from './models';
import { redact } from './redact';

export type LogSink = (entry: LogEntry) => void;

export class Logger {
  private entries: LogEntry[];
  private sinks: LogSink[] = [];

  constructor(private maxEntries = 2000, initial: LogEntry[] = [], private now: () => Date = () => new Date()) {
    this.entries = initial.slice(-maxEntries);
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  setMax(max: number): void {
    this.maxEntries = max;
    this.trim();
  }

  log(level: LogEntry['level'], scope: string, message: string, stepId?: StepId): LogEntry {
    const entry: LogEntry = { at: this.now().toISOString(), level, scope, message: redact(message), stepId };
    this.entries.push(entry);
    this.trim();
    for (const sink of this.sinks) {
      sink(entry);
    }
    return entry;
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }
}
