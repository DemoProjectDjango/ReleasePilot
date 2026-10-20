# Post-MVP proposals (not implemented, awaiting approval)

Each item builds on existing modules and keeps the evidence-first rules: nothing is marked successful without verification, and nothing irreversible runs without explicit approval.

1. **AI-assisted Code Analyzer remediation.** Opt-in provider selection; send only the finding, a bounded code excerpt and the rule text after explicit consent; show the proposed patch in the existing diff review; rerun analysis and tests afterwards. Extends `src/analysis` (fix review already exists). Risk: behaviour-changing security fixes, so human review stays mandatory.
2. **Advanced UI regression testing.** Project-supplied Playwright or UTAM suites run against the QA org through a new `qaUiTests` hook, with traces and screenshots saved as evidence. Needs a way to hand the org session to the tool without exposing tokens.
3. **GitHub Actions CI/CD.** Extract `src/core` and `src/engine` into a headless runner (they already avoid `vscode`) for validation, build and QA; keep promotion as a protected manual environment gate. Fulfils FR-36.
4. **Multi-project release dashboard.** Aggregate per-workspace state and release history; add per-product policy profiles and a portfolio view of stale or blocked releases.
5. **AppExchange Security Review preparation.** Preset Code Analyzer selectors and report bundles for the review, an evidence index, and a checklist of review prerequisites. ReleasePilot would prepare, not submit.
6. **Release notes generation.** Draft notes from approved Git history and the readiness report; human edit before export (FR-37).
7. **Partner Console integration where supported.** Only if Salesforce exposes a supported API; otherwise keep guided steps with pre-filled values (04t, version, install links).
8. **Customer push-upgrade management.** A separate module with its own approval model (it affects subscriber orgs), staged by org group, with dry run and rollback guidance.
9. **Release metrics and analytics.** Local-only lead time, gate failure rates, flaky tests and coverage trends from the stored history; no telemetry leaves the machine.
10. **Hardening found during this build:** second-person (four-eyes) promotion approval; a supervised-pilot checklist and a recorded live-run harness for the mutating commands; `@vscode/test-electron` integration tests for the webview and commands; automatic expiry reminders and cleanup of old QA scratch orgs (always confirmed).
