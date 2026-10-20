# ReleasePilot — agent instructions

VS Code extension (TypeScript) automating the Salesforce managed 2GP release lifecycle. Spec: `docs/ReleasePilot_Spec_v1.1.md`. Plan: `docs/IMPLEMENTATION_PLAN.md`. Progress: `docs/IMPLEMENTATION_STATUS.md`.

## Commands (Windows/PowerShell)
- `npm run check` — typecheck, lint, tests, bundle (run before every commit)
- `npm test` / `npm run lint` / `npm run typecheck` / `npm run compile`
- F5 in VS Code → "Run ReleasePilot (Extension Development Host)"

## Rules
- Work slice by slice; stop for user approval after each. Never push, merge to `main`, or open PRs without approval. Work on `feature/releasepilot-initial-development`.
- `src/core` and `src/engine` must not import `vscode`.
- A step may be `passed` only with evidence. Never simulate Salesforce success; mocks only in tests, labelled as mocked.
- Spawn processes with argument arrays and `shell:false`; validate all arguments; redact output via `redact()`.
- Never store tokens/installation keys; use existing `sf` auth. Never promote without explicit approval. No live-org create/delete/modify without user permission.
- Verify CLI syntax with `--help` before using a command.
- Webview: nonce CSP, validated messages, no innerHTML.
- Keep README, CHANGELOG and IMPLEMENTATION_STATUS in sync. Don't commit `.sf/`, `.sfdx/`, auth files, `.env`.
