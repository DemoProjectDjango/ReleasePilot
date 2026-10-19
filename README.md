# ReleasePilot

Guided, evidence-based release automation for Salesforce managed 2GP packages, inside VS Code.
Publisher: TwinStack Solutions. Spec: [docs/ReleasePilot_Spec_v1.1.md](docs/ReleasePilot_Spec_v1.1.md).

## Status
Slices 1-3 are implemented: dashboard, workflow engine, project/org/package discovery, Preflight and Source Ready, conflict-safe retrieval, Code Analyzer, Apex/LWC tests and coverage. Package creation, QA and promotion arrive in Slices 4-6, so they cannot run yet. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Develop
```powershell
npm install
npm run check      # typecheck + lint + tests + bundle

# Optional: read-only live checks against the orgs authenticated in your Salesforce CLI
$env:RP_LIVE=1; npx vitest run src/test/live.test.ts
```
Press **F5** in VS Code to launch the Extension Development Host, open a Salesforce DX project folder, click the ReleasePilot icon in the Activity Bar and choose **Open Dashboard**.

## Docs
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
