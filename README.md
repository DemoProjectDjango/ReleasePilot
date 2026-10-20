# ReleasePilot

Guided, evidence-based release automation for Salesforce managed 2GP packages, inside VS Code.
Publisher: TwinStack Solutions. Spec: [docs/ReleasePilot_Spec_v1.1.md](docs/ReleasePilot_Spec_v1.1.md).

## Status
All six slices are implemented: dashboard, workflow engine, discovery, Code Analyzer and tests, package readiness and creation, scratch-org QA and upgrade testing, release readiness and controlled promotion. Everything that changes a Salesforce environment is tested with a mocked CLI only and still needs a supervised pilot. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Develop
```powershell
npm install
npm run check      # typecheck + lint + tests + bundle

# Optional: read-only live checks against the orgs authenticated in your Salesforce CLI
$env:RP_LIVE=1; npx vitest run src/test/live.test.ts
```
Press **F5** in VS Code to launch the Extension Development Host, open a Salesforce DX project folder, click the ReleasePilot icon in the Activity Bar and choose **Open Dashboard**.

## Docs
- **[User guide: install, launch and test](docs/USER_GUIDE.md)**
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
