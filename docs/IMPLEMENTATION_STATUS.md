# ReleasePilot — Implementation Status

## Slice 1 — VS Code Extension Foundation and UI

**State:** Implemented and verified by automated checks. Interactive verification in the Extension Development Host is a manual step for the user (see "Known limitations"). Not marked fully accepted until that is done.

### Completed features
- Extension scaffold (TypeScript, esbuild bundle, ESLint, Vitest), F5 launch config.
- Activity bar container, "Release Pipeline" tree with status icons and inline Run/Retry/Cancel.
- Dashboard webview: project selector (workspace folders), org/Dev Hub selectors (disabled placeholders until Slice 2), pipeline timeline with expandable step panels, Resume Pipeline, New Release Run, Logs, Errors, Reports & Artifacts, Release History, Settings tabs. UI tab/expansion state survives panel reloads.
- Typed models: nine statuses, steps, runs, evidence, failures, log entries.
- Workflow engine: dependency gating, approval gating, Workspace Trust gating, evidence-required success, required-step-skip rejection, local timeout → needs-review, local cancel, downstream staleness, resume, run archive.
- Persistent state (atomic JSON, corrupt-file quarantine, interrupted-run recovery).
- Structured logger with persisted ring buffer, Output Channel sink and secret redaction.
- Light/dark theme via VS Code variables; status shown by icon and text.
- Secure webview: nonce CSP, restricted resource roots, validated messages, no innerHTML.

### Honesty note
No step executors exist yet, so **no step can be run and none can show Passed**. "Run" is disabled with an explanation and the engine returns `NOT_IMPLEMENTED` without altering state.

### Requirement IDs
FR-05 (statuses/timeline), FR-21 (engine support), FR-22 (logging/redaction foundation), FR-27 (local state restore), NFR-01, NFR-02 (redaction), NFR-05 (partial), NFR-07, NFR-08, NFR-14, NFR-18, NFR-12.

### Files
`package.json`, `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `vitest.config.mts`, `.gitignore`, `.vscodeignore`, `.vscode/{launch,tasks}.json`, `media/{icon.svg,dashboard.css,dashboard.js}`, `src/extension.ts`, `src/core/{models,pipeline,logger,redact}.ts`, `src/engine/{workflowEngine,stateStore}.ts`, `src/ui/{dashboardPanel,pipelineTree,messages}.ts`, `src/test/engine.test.ts`, `docs/*`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`.

### Tests executed (all local/mocked; no live Salesforce)
| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `eslint src` | pass |
| `vitest run` (18 unit tests: engine, store, redaction, message validation) | 18 passed |
| `esbuild` bundle | pass (`dist/extension.js` 29 kB) |
| VS Code extension-host test / visual check | **not executed** (requires GUI; see below) |

### Known limitations
- Dashboard rendering and theming not exercised automatically; needs F5 check.
- No `@vscode/test-electron` integration tests yet (planned alongside Slice 2).
- Org/Dev Hub selectors are placeholders.
- Step timeout setting is read at activation (reload to apply).
- Dev dependency audit warnings from `npm install` not yet reviewed.

### Git
Branch `feature/releasepilot-initial-development`. Commit hash recorded in the hand-off message.

### Recommended next: Slice 2 — Salesforce integration and project discovery.
