# ReleasePilot — User Guide

How to run and test ReleasePilot on a new machine (for example, after cloning this repository at home).

> **Status:** all six development slices are built, but nothing that *changes* a Salesforce environment has been run for real yet. Start with the **safe, read-only path** below. Only try the mutating steps against a throwaway package and test orgs. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exactly what has and has not been verified.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Node.js | 20 or newer (24 was used) | `node -v` |
| npm | comes with Node | `npm -v` |
| Visual Studio Code | 1.90 or newer | `code --version` |
| Salesforce CLI (`sf`) | 2.x | `sf --version` |
| Code Analyzer v5 plugin | 5.x | `sf plugins` should list `code-analyzer` |
| Java (JDK 11+) | needed by the PMD engine | `java -version` |

Install the missing pieces:

```powershell
npm install --global @salesforce/cli
sf plugins install code-analyzer
```

You also need, for the Salesforce-facing features:

- An authenticated **Dev Hub** org with second-generation managed packaging enabled and an existing managed 2GP package (`0Ho…`).
- A Salesforce DX project folder (it has `sfdx-project.json`) whose package directory declares that package.
- Optionally a **scratch org or sandbox** to use as the *validation org* (never your Dev Hub).

Authenticate your orgs with the normal Salesforce CLI. ReleasePilot never stores tokens; it reuses the CLI's logins:

```powershell
sf org login web --alias my-devhub --set-default-dev-hub
sf org login web --alias my-sandbox
sf org list
```

## 2. Get the code

```powershell
git clone https://github.com/DemoProjectDjango/ReleasePilot.git
cd ReleasePilot
git checkout feature/releasepilot-initial-development
npm install
npm run check
```

`npm run check` runs the type check, lint, the automated tests and the build. You should see **206 passed** and 7 skipped (the skipped ones need a real Salesforce login, see section 7).

## 3. Launch ReleasePilot

1. Open the `ReleasePilot` folder in VS Code (`code .`).
2. Press **F5** (or Run > Start Debugging, choose *Run ReleasePilot (Extension Development Host)*). A second VS Code window opens: the *Extension Development Host*.
3. In that second window use **File > Open Folder** and open **your Salesforce DX project** (not the ReleasePilot folder).
4. Click **Trust** if VS Code asks about workspace trust. ReleasePilot refuses to run anything in an untrusted workspace.
5. Click the **ReleasePilot** icon in the Activity Bar, then **Open Dashboard**.

If the icon is missing, make sure you pressed F5 in the ReleasePilot window and that the build finished (`npm run compile`).

## 4. A first, read-only walkthrough

The **Pipeline** page starts with a **Getting ready** checklist. It tells you what is still missing (CLI, Code Analyzer, Git, a Dev Hub, a package declared in `sfdx-project.json`, package ownership) and offers buttons that only *open a file* or *copy a command* for you to run yourself. Nothing is created for you. If your project has no package yet, ReleasePilot cannot release it: that is expected, and the checklist says what to add.

**Want to try the Code Analyzer on any DX project first?** On the **Quality** page use **Quick scan**. It needs no Dev Hub or package, only reads your source, and is clearly marked *ad hoc*: it is never release evidence and never affects a gate.

These steps only *read* from your orgs.

1. **Project tab:** it discovers the project, tools (sf, Code Analyzer, Git), your authenticated orgs, the Dev Hub's packages and recent package versions. Pick your **Dev Hub** in the selector at the top. The choice is saved to `.releasepilot.json` in your project (aliases only, no secrets; add it to `.gitignore` if you do not want it committed).
2. **Pipeline tab > Discover & Preflight > Run.** It checks the project, package ownership by the selected Dev Hub, namespace, Git and the tools. Anything wrong is listed with how to fix it on the **Errors** tab.
3. **Pipeline tab > Source Ready > Run.** It fingerprints your Git working tree. Uncommitted changes make this step *Needs Review* unless you enable `releasepilot.allowDirtySource`.
4. **Quality tab > Run Code Analyzer.** Findings are grouped by file, severity or rule; click *Open in editor* to jump to the line. Fixes (if the analyzer offers any) always show a diff and ask before changing anything. Dismissing a finding requires a written justification.

Results and reports appear under **Reports & Artifacts** with *Open* and *Export…* buttons. Closing and reopening VS Code keeps your state.

## 5. Steps that change Salesforce (use test data first)

Each of these asks for explicit confirmation naming the org first, and stops cleanly if you decline. **Try them only with a throwaway package and disposable orgs.**

| Step | What it changes | Where to start |
|---|---|---|
| **Pre-package Tests** | Deploys your package directories to the **validation org** (if `releasepilot.deployBeforeTests` is on) and runs Apex tests there. | Quality tab: choose a *Validation org* (scratch or sandbox) in the selector row. |
| **Create Beta Package** | Creates a new beta package version on the Dev Hub (uses a package build). Always full validation with code coverage. Asks for an installation key (never stored). | Package tab > *Check Readiness*, then *Create Beta Package*. |
| **Prepare QA Environment** | Creates a scratch org from the Dev Hub (uses scratch org allocation), installs the exact beta, assigns permission sets, runs your scripts, opens the org. | QA tab. |
| **Run Upgrade Test** | Same, but installs the previous *released* version first and upgrades to the beta. Unsupported paths are blocked with an explanation. | QA tab. |
| **Approve & Promote** | **Permanently** marks the version Released. Needs a passed Release Readiness, a summary confirmation and typing the exact 04t. | Release tab. |

Order matters: each step stays blocked until the one before it has passed. A step turns green only with evidence; installation success alone never marks QA as passed. After the automation finishes, **you** complete the manual checklist in the QA tab and sign off.

ReleasePilot never deletes a scratch org unless you press *Delete Scratch Org…* and confirm.

### Useful settings (VS Code > Settings > ReleasePilot, or the dashboard Settings tab)

| Setting | Purpose |
|---|---|
| `releasepilot.severityGate` | Analyzer severity that blocks (default `high`). |
| `releasepilot.ruleSelectors` | Code Analyzer selectors, e.g. `["Recommended","AppExchange"]`. |
| `releasepilot.coverageTargetPercent` | Internal org-wide coverage target (default 80). Not the package-version rule (75%). |
| `releasepilot.deployBeforeTests` | Deploy local source to the validation org before tests (default on). |
| `releasepilot.installationKeyPolicy` | `require` (default) or `allow-bypass`. |
| `releasepilot.scratchDefinitionFile` | Scratch org definition, default `config/project-scratch-def.json`. |
| `releasepilot.qaPermissionSets` | Permission sets assigned in QA orgs. |
| `releasepilot.qaInitScripts`, `qaSmokeScripts`, `upgradeSeedScripts`, `upgradeRegressionScripts` | Project `.apex` files run **only in the new scratch org**. |
| `releasepilot.allowDirtySource` | Let Source Ready pass with uncommitted changes (not recommended for releases). |

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says Salesforce CLI not found | Install the CLI, restart VS Code (it must be on `PATH`). |
| Preflight: *Code Analyzer v5* missing | `sf plugins install code-analyzer`. |
| Analyzer step says the scan may be incomplete | The analyzer printed an engine error (often Apex that does not compile, or Java missing). Read the message shown, fix, rescan. |
| *Package ownership* fails | The selected Dev Hub does not own the package in `sfdx-project.json`; select the right Dev Hub or fix `packageAliases`. |
| An org shows *EXPIRED* / auth errors | `sf org login web --alias <alias>` again, then *Re-run Discovery*. |
| Buttons are disabled | Hover for the reason: usually an earlier step has not passed, or the workspace is not trusted. |
| Scratch org creation fails with a limit message | Your Dev Hub has no free scratch org allocation. Delete unused scratch orgs yourself and retry. |
| Something looks stuck after closing VS Code mid-run | Steps interrupted by a restart come back as *Needs Review*. Retry continues the same remote request instead of creating a duplicate. |
| Output / logs | Open the Logs tab, or the **ReleasePilot** channel in the Output panel. Secrets are redacted. |

Local state (workflow state, reports, QA records) is stored in VS Code's per-workspace extension storage, not in your project.

## 7. Running the automated tests

```powershell
npm test                      # unit and mocked tests; no Salesforce needed
$env:RP_LIVE = "1"; npm test  # also runs read-only checks against your authenticated orgs
```

The live tests only run `org list`, `package list`, `package version list/report`, `package installed list` and a local Code Analyzer scan on a temporary project. They create, change and delete nothing in Salesforce. They need an authenticated Dev Hub that owns at least one package, and Java for the analyzer.

## 8. Reporting what you find

Please note for each problem: the step, what you clicked, the message on the **Errors** tab, and the relevant lines from the **Logs** tab. Remember that the dashboard has never been opened in a live VS Code window before the first manual test, so cosmetic issues are expected.
