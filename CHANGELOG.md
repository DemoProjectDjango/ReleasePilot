# Changelog

## [Unreleased]
### Added
- Project switcher: pick any open folder, a recent project, or browse to any Salesforce DX project. State, reports, QA and release history are stored per project; projects outside the workspace need an explicit one-time trust confirmation. Existing single-project state is adopted for the first workspace folder.
- Extension-host integration test (stubbed VS Code API) covering activation and project switching.
- Getting-ready checklist (spec FR-35, advisory only) with copy-command and open-file buttons; Quick scan for ad-hoc Code Analyzer runs that never count as release evidence.
- Dashboard redesign: sidebar navigation with status dots, sticky project/org context bar, stat tiles per page, card sections, stepper pipeline with auto-opening failed steps, pills and inline icons, grouped settings with switches, structured log view, responsive layout, theme-aware light/dark. Fixes stray "null" text in the header.
- tools/preview: headless screenshot harness for the dashboard.
- Slice 6: release readiness with 15 gates and hash-bound evidence, overridable local policy vs hard platform blockers, JSON/Markdown/HTML reports, typed-confirmation single-use promotion approval, promotion with intent recording and Salesforce verification, receipts, release history, Release tab.
- Slice 5: scratch org QA automation (create, install, verify, permission sets, scripts, open), automated upgrade testing with Salesforce's beta rules, manual QA checklist with signed results, reconciliation and cleanup, QA tab.
- Slice 4: package readiness checks, beta package creation with persisted 08c tracking, 04t verification against the version report, duplicate-build protection, installation-key handling, Package tab.
- Slice 3: Code Analyzer v5 integration with incomplete-scan detection, triage, reviewed fixes, Apex tests with optional deploy and coverage gating, LWC Jest, failed-test rerun, Quality tab, report open/export and Markdown quality summary.
- Slice 2: Salesforce CLI adapter, project/org/Dev Hub/package discovery, Git fingerprinting, real Preflight and Source Ready steps, conflict-safe retrieval, per-project config, Project tab.
- Slice 1: extension foundation, sidebar pipeline tree, dashboard webview, workflow engine, persistent state, structured logging with redaction, light/dark theme support.
