# ReleasePilot — Implementation Plan

Primary requirements: [ReleasePilot_Spec_v1.1.md](ReleasePilot_Spec_v1.1.md) (its older title, "TwinStack Salesforce Release Assistant", means ReleasePilot).

## 1. Stage 0 findings

| Item | Result |
|---|---|
| Repo | `D:\Product\ReleasePilot`, remote `origin` = `https://github.com/DemoProjectDjango/ReleasePilot.git`, branch `main` (2 commits: README only) |
| Pre-existing files | `README.md` (2 lines), `docs/ReleasePilot_Spec_v1.1.md` (untracked) |
| Node / npm | v24.11.1 / 11.10.0 |
| TypeScript | not global; installed per-project (5.x) |
| Salesforce CLI | `@salesforce/cli/2.150.6` with `code-analyzer 5.15.0`, `@salesforce/sfdx-scanner 4.12.0` (legacy v4), `sfdx-plugin-lwc-test` |
| Git / VS Code | 2.52.0 / 1.139.1 |
| CLI syntax verified | `sf package version create report --package-create-request-id <08c> --target-dev-hub`, `sf package version promote --package <04t> --no-prompt`, `sf code-analyzer run --workspace --rule-selector --output-file` all exist in the installed CLI. Remaining commands are re-verified with `--help` in the slice that uses them (the adapter must not trust the spec's syntax blindly). |

### Spec vs. repo gap
Nothing from the spec was implemented before Slice 1. All spec features are outstanding apart from those listed in `IMPLEMENTATION_STATUS.md`.

### Conflicts / decisions
- **Name:** Product is *ReleasePilot*; the spec's config file `.twinstack-release.json` is renamed `.releasepilot.json` (Slice 2) — non-secret project config only.
- **Statuses:** Spec uses `NOT_STARTED`; the task brief uses `Pending`. We use the brief's `pending`. Spec's `NOT_APPLICABLE` (new product, upgrade QA) is represented by `skipped` on an *optional* step; required steps can never be skipped.
- **Two Code Analyzers:** both v4 (`sfdx-scanner`) and v5 (`code-analyzer`) are installed. Only v5 is used (spec §4 Stage 2); preflight (Slice 2/3) must detect and report the v5 plugin explicitly.
- **Spec §12 `package install --package <04t>`**: verified when Slice 5 starts.

## 2. Architecture

```
VS Code UI (Tree view, Webview, Output channel)      src/ui/
        │  validated messages only
Extension host controller (commands, trust, wiring)  src/extension.ts
        │
Workflow engine (DAG, freshness, approval, cancel)   src/engine/workflowEngine.ts
        │                         │
State store (atomic JSON)    Step executors (one per step, added per slice)
src/engine/stateStore.ts          │
                              Adapters (sf CLI, Code Analyzer, Git, Jest)   src/adapters/  (Slice 2+)
```

Core rules: the engine and `src/core` import nothing from `vscode`, so they are unit-testable and later reusable headlessly (FR-36).

### Folder structure
```
src/core/        models, pipeline definition, logger, redaction (pure TS)
src/engine/      workflowEngine, stateStore
src/adapters/    (Slice 2+) process runner, sf CLI, git, analyzer, jest
src/executors/   (Slice 2+) one executor per pipeline step
src/ui/          dashboard webview host, tree provider, message validation
src/test/        vitest unit tests (mocked/local)
media/           webview JS/CSS, icon
docs/            spec, plan, status
```

### Workflow execution
- 10 steps defined in `src/core/pipeline.ts` with dependencies, `optional`, `requiresApproval`, requirement IDs.
- `runStep` checks: known step → not running → trusted workspace → executor exists → dependencies `passed` (or `skipped` if optional) → approval for irreversible steps.
- Executors return `StepResult`. **`passed` without evidence is rejected** (`EVIDENCE_MISSING`). Required steps cannot be `skipped`.
- Local timeout → `needs-review` (remote state unknown), never `failed`. Cancel aborts the local wait only (NFR-20).
- `invalidateDownstream(step)` marks dependents `stale` (freshness model §6 of spec). Slice 2 wires source/config fingerprints to it.
- Restart: any persisted `running` step becomes `needs-review` (`INTERRUPTED`) so remote 08c/install IDs are reconciled before retry (FR-27, NFR-05).

### Salesforce CLI adapter strategy (Slice 2)
`ProcessRunner` using `child_process.spawn` with `shell:false` and argument arrays; on Windows resolve `sf.cmd` via explicit path lookup rather than a shell. Always `--json` where available; parse into typed results; stream stdout/stderr lines to the logger (redacted); AbortSignal + timeout; command allow-list with argument validators (aliases, IDs `0Ho/04t/08c` regexes). A mock `ProcessRunner` supports tests; live tests are labelled separately.

### State persistence
`workflow-state.json` in `context.storageUri` (per-workspace; fallback to global storage) containing current run, history (≤200), and log ring buffer. Atomic write (tmp+rename); corrupt files quarantined, not trusted. Secrets are never stored (install keys by reference to `SecretStorage`).

### UI structure
Sidebar tree (`releasepilot.pipeline`) for quick status/actions; one webview dashboard with tabs: Pipeline (timeline + expandable step panels), Logs, Errors, Reports & Artifacts, Release History, Settings. Status shown via icon **and** text (NFR-08). Theming uses only VS Code CSS variables.

### Error recovery
Structured `Failure {code, message, detail, remediation}`; failed steps keep evidence; Retry re-runs one step; Resume continues in order and stops at the first non-pass; non-idempotent operations (package create, promote, scratch create) will first reconcile remote IDs (Slices 4–6).

### Security architecture
Workspace Trust (`untrustedWorkspaces: limited`, engine refuses execution); webview CSP with nonce, `default-src 'none'`, restricted `localResourceRoots`, DOM built with `textContent` (no `innerHTML`); all webview messages validated (`messages.ts`); `redact()` applied to logs and failure text; no tokens stored; promotion needs approval flag, enforced in engine.

## 3. Slices
| Slice | Scope | Spec milestone |
|---|---|---|
| 1 | Extension foundation, engine, state, logging, dashboard | A (part) |
| 2 | Project/org/package discovery, CLI adapter, retrieval safety, project config | A |
| 3 | Code Analyzer v5, Apex/Jest tests, coverage, reports | B |
| 4 | Package readiness + beta creation (08c/04t) | C |
| 5 | Scratch org, install, permsets, QA checklist, upgrade QA | C |
| 6 | Readiness report, approval, promotion, verification | D |

## 4. Requirement traceability

| Requirement | Slice | Requirement | Slice |
|---|---|---|---|
| FR-01..04 | 2 | FR-16 | 4 |
| FR-05 | **1** | FR-17..20 | 5 |
| FR-06 | 2 | FR-21 | **1** (engine), per-step 2–6 |
| FR-07..09 | 3 | FR-22 | **1** (logging/redaction), 2 (commands) |
| FR-10..13 | 3 | FR-23 | 5 |
| FR-14 | 2 + 4 | FR-24 | 6 |
| FR-15 | 4 | FR-25, FR-26 | 6 |
| FR-27 | **1** (state restore), 4–6 (remote reconcile) | FR-28 | 3 (reports) + 6 |
| FR-29 | 2 | FR-30..38 | post-MVP / P1–P2 |

| NFR | Status in Slice 1 |
|---|---|
| NFR-01 | Implemented (trust gate) |
| NFR-02 | Redaction implemented; no secrets stored |
| NFR-03 | Process runner in Slice 2 |
| NFR-04 | Slices 2, 6 |
| NFR-05 | Interrupted-run recovery implemented; remote reconcile later |
| NFR-06 | Stale model implemented; fingerprints in Slice 2+ |
| NFR-07 | Async engine; no blocking calls |
| NFR-08 | Text+icon status, keyboard-operable controls |
| NFR-09/22 | Logging foundation; command display in Slice 2 |
| NFR-14 | Layered structure + unit tests |
| NFR-18 | CSP, resource roots, message validation |
| NFR-12 | No telemetry |

## 5. Implementation checklist
- [x] Stage 0 analysis and docs
- [x] Slice 1 foundation (see status doc)
- [x] Slice 2 discovery and CLI adapter
- [ ] Slice 3 … Slice 6
- [ ] Post-MVP proposals (AI remediation, CI, multi-project dashboard, security-review prep, release notes, Partner Console, push upgrades, analytics)
