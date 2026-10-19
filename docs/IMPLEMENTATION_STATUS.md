# ReleasePilot — Implementation Status

## Slice 3 — Code Analyzer, Automated Testing, and Reports

**State:** Implemented. Static analysis is verified end to end against the real Code Analyzer plugin. Apex testing and deployment are verified only with a mocked CLI because no validation org was designated, so no test run or deployment was executed in any real org.

### Completed features
- **Static analysis step** (`sf code-analyzer run`, JSON + HTML reports with fixes and suggestions requested): findings normalized (severity, rule, engine, file, line/column, message, tags, docs, fix, suggestions); grouping by file, severity or rule; filter; open-in-editor at the exact line; rescan; configurable rule selectors (e.g. add AppExchange) and severity gate (default: High and above).
- **Outdated-scan detection:** each report stores the source fingerprint; the UI flags a scan or test run as OUTDATED when the live fingerprint differs, and editing source marks Source Ready and everything after it Stale.
- **Incomplete-scan protection:** the JSON report does not record engine failures. A file PMD cannot parse produced no finding at all (found by live testing), so the CLI's `»` warning blocks are captured; any non-benign block makes the step Needs Review (`ANALYZER_WARNINGS`) instead of a clean pass.
- **Triage:** a finding can be dismissed only with a written reason (min. 10 characters), owner and timestamp; entries are listed in the UI and the export, are removable, and changing them invalidates the analysis result.
- **Fixes:** analyzer-provided fixes are applied only after a diff view and a modal confirmation, and only if the source is unchanged since the scan. Every fix is treated as behaviour-changing. (AI remediation is deliberately left to a later slice.)
- **Pre-package Tests step:** requires an explicit validation org (never defaulted, never the Dev Hub, not expired); modal confirmation naming org, ID, type and what will happen; optional deploy of the package directories (`sf project deploy start --source-dir`, never any ignore flag) so the tests exercise the local source; `sf apex run test --code-coverage`; parsed pass/fail/skip counts, failure messages and stack traces, per-class coverage.
- **Coverage honesty:** the figure is the validation org's org-wide coverage, compared with the configurable internal target (default 80%) and labelled "not package-version coverage"; the 75%/all-triggers package rule is documented as a Slice 4 build-time check.
- **Source-not-proven rule:** if local source was not deployed by ReleasePilot, tests cannot Pass; they end Needs Review (`SOURCE_NOT_VERIFIED_IN_ORG`).
- **LWC Jest:** detected from `package.json` + jest config; run through node on the project's own sfdx-lwc-jest; `NOT_CONFIGURED` is recorded without failing; configured-but-not-installed is Needs Review.
- **Failed-test rerun:** reruns only the failed tests (`RunSpecifiedTests`) after confirmation; stored as informational and never satisfies the gate.
- **Reports:** Open and Export buttons for every artifact (only known artifact paths are accepted); consolidated Markdown quality summary export with fingerprints, blockers, triage, failed tests, coverage and the disclaimer.
- **Dependent steps blocked:** Package Readiness cannot run until Pre-package Tests passes, which cannot run until Static Analysis passes.
- **UI:** new Quality tab, Validation org selector, severity gate / test level / deploy-before-tests / wait-time settings.

### Requirement IDs
FR-07, FR-08, FR-09, FR-10, FR-11, FR-12, FR-13, FR-22, FR-28 (analysis and test portions), FR-30 (fix review; fully verified only with mocked fix data); NFR-02, NFR-03, NFR-04 (validation org identity and Dev Hub exclusion), NFR-06, NFR-09, NFR-15.

### Files created or modified
New: `src/analysis/{analyzer,triage}.ts`, `src/testing/{apex,lwc,qualityStore,summary}.ts`, `src/executors/quality.ts`, `src/test/slice3.test.ts`. Modified: `src/adapters/sfCli.ts` (stderr capture), `src/discovery/{discoveryService,projectConfig}.ts` (validation org), `src/extension.ts`, `src/ui/{messages,dashboardPanel}.ts`, `media/{dashboard.js,dashboard.css}`, `package.json` (settings), `src/test/live.test.ts`.

### Tests executed
| Category | What | Result |
|---|---|---|
| Mocked | analyzer/Apex/deploy parsing and command construction, gates, executors for every outcome (no org, Dev Hub as org, declined, deploy failure, test failure, low coverage, unverified source, triage, warnings), summary export, message validation | pass |
| Local integration | real fix application; LWC Jest plumbing with a fake Jest binary run through the real process runner | pass |
| Local real tool (no org) | real Code Analyzer v5 plugin on a throwaway project: 8 findings parsed, zero warnings; a deliberately unparseable file is flagged as an incomplete scan | pass |
| Live read-only (earlier slice) | org / package queries | pass (88/88 with `RP_LIVE=1`) |
| Default suite | `npm run check` | 84 passed, 4 live/local-tool tests skipped |
| **Not run** | Apex tests and deployment in a real org; real analyzer fixes (the installed engines emitted none); VS Code UI check | see limitations |

### Defects found by real-tool testing and fixed
1. A file that PMD cannot parse yields **no finding**; the failure appears only in CLI warnings. Without capturing them a broken class would give a clean scan.
2. A naive "any warning blocks" rule would have blocked every scan: healthy runs always print a "Could not find typescript" notice. Warnings are now grouped into blocks and known-benign notices ignored.

### Known limitations
- The Apex result shape (`summary.orgWideCoverage`, `tests[]`, `coverage.coverage[]`) follows Salesforce documentation and is **not verified against a live org**. The first real run should be reviewed before relying on the gate.
- The `fixes[]`/`suggestions[]` shape follows documentation; the installed engines produced none to verify against.
- Deploy-then-test writes to the chosen validation org by design (after confirmation). Test runs create Apex test run records there.
- A local timeout leaves the remote job running; the step is Needs Review rather than Failed.
- Warning classification relies on the CLI's `»` markers and a short benign list; new CLI wording could need an update.
- The Quality tab and diff-based fix flow have not been exercised in a live VS Code window.

### Recommended next: Slice 4 — managed 2GP package creation (after approval).

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
