# ReleasePilot — Implementation Status

## Slice 2 — Salesforce Integration and Project Discovery

**State:** Implemented; automated and live read-only checks pass. Interactive check in the Extension Development Host is still a manual step for the user.

### Completed features
- **Process runner** (`src/adapters/processRunner.ts`): `spawn` with `shell:false` and argument arrays, real-time line streaming, timeout, abort, output cap, unsafe-argument rejection.
- **Salesforce CLI adapter** (`sfCli.ts`): resolves `sf` without a shell (node + `run.js` for npm installs on Windows), JSON envelope parsing tolerant of warning noise, error mapping with remediation (missing org, expired auth, network, unavailable command), alias/ID validation, redacted command history.
- **Whitelist parsers** (`discovery/parsers.ts`): `sf org list --json` contains `accessToken` for every org; only named non-secret fields are copied, so tokens cannot reach the UI, logs or state.
- **Project discovery**: `sfdx-project.json` (package directories, aliases to 0Ho IDs, dependencies, ancestors, namespace, version format warnings); Git snapshot (branch, HEAD, uncommitted files, content-based fingerprint that excludes `.releasepilot.json`); tooling versions (sf, Code Analyzer v5, legacy scanner, Git, Node).
- **Org / Dev Hub / package discovery**: authenticated orgs, Dev Hub flag, defaults from `sf config`, Dev Hub packages and the latest 15 package versions with release/coverage fields.
- **Per-project config** `.releasepilot.json` (aliases only, validated, atomic write, no secrets).
- **Real Preflight and Source Ready executors** with JSON report evidence: DX project, package config, CLI, Code Analyzer v5, Git, Dev Hub, package ownership by the selected Dev Hub, namespace match. Failures carry remediation. Source Ready becomes Needs Review for uncommitted changes unless `releasepilot.allowDirtySource` is enabled.
- **Freshness**: a debounced watcher compares the live Git fingerprint with the Source step's fingerprint; changes mark Source and everything downstream Stale. Changing Dev Hub, package or project marks Preflight Stale.
- **Conflict-safe retrieval**: `sf project retrieve preview` then `start`, only after a fresh preview of the same org against the unchanged working tree. Blocks on conflicts, on overlap with uncommitted edits, on non-Git projects and on orgs without source tracking; asks for confirmation when unrelated edits exist; never passes `--ignore-conflicts`. Reports are kept as artifacts.
- **UI**: new Project tab (project, packages, tooling, Git, orgs, Dev Hub package versions, retrieval preview/apply, executed commands with exit code and duration), live Project/Development org/Dev Hub selectors, busy and error banners, discovery errors in the Errors tab, artifacts in the Reports tab, "allow uncommitted source" setting.

### Requirement IDs
FR-01, FR-02, FR-03, FR-04 (single project at a time), FR-06, FR-14 (pre-build inspection; deeper checks in Slice 4), FR-22 (commands shown, redacted), FR-29 (preview-based; manifest selection not yet), NFR-01, NFR-02, NFR-03, NFR-04 (Dev Hub/package ownership check), NFR-06, NFR-09, NFR-15.

### Files created or modified
`src/adapters/{processRunner,sfCli,git,commandHistory}.ts`, `src/discovery/{project,parsers,projectConfig,discoveryService,retrieval}.ts`, `src/executors/{executors,reportWriter}.ts`, `src/engine/workflowEngine.ts` (markStale, artifacts), `src/core/models.ts`, `src/extension.ts`, `src/ui/{messages,dashboardPanel}.ts`, `media/dashboard.js`, `package.json`, tests `src/test/{slice2,live}.test.ts`.

### Tests executed
| Category | What | Result |
|---|---|---|
| Mocked | CLI adapter, parsers, preflight evaluation, retrieval safety rules (mocked `sf`), message validation | pass |
| Local integration | real process runner (injection resistance, timeout, abort), real `git` repos (fingerprints, dirty states), real `sf --version` | pass |
| **Live read-only** (`RP_LIVE=1`) | real `sf org list`, `package list`, `package version list` against locally authenticated orgs; preflight pass for an owned package and fail for an unknown one | 2/2 pass |
| Default suite | `npm run check` (tsc, eslint, vitest, bundle) | 53 passed, 2 live skipped |
| Not run | retrieve `start` against a real org (would modify local files from a live org), VS Code UI check | manual / not executed |

### Defects found by live testing and fixed
1. Code Analyzer v5 was not detected: the plugin is named `@salesforce/plugin-code-analyzer`. Detection now parses plain `sf plugins` output (the `--json` form returns megabytes of internal data) and ignores the "Uninstalled JIT Plugins" section.
2. CLI warnings containing braces broke JSON extraction; extraction now tries each candidate start and requires a valid `status` envelope.
3. With no package selected, a package without an alias matched `undefined === undefined`, so an unowned project package could appear owned. Fixed; preflight now fails "Package ownership" correctly.

### Known limitations
- `sf project retrieve start` was verified only with a mocked CLI; no live retrieval was run.
- Retrieval needs source-tracking orgs; manifest-based selection is not implemented.
- One project/Dev Hub is active at a time (FR-04 multi-product handling is basic).
- Steps beyond Preflight and Source Ready have no executors (Slices 3-6).
- No automated regression test yet for the package-selection fix beyond the live test.
- Dashboard/theme behaviour still needs a manual F5 check; no extension-host test.

### Recommended next: Slice 3 — Code Analyzer, tests, coverage and reports (after approval).

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
