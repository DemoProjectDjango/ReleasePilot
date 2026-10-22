import type { DiscoverySnapshot } from './discoveryService';

export type SetupAction =
  | { kind: 'copyCmd'; id: SetupCommandId; label: string }
  | { kind: 'openProject'; label: string };

export type SetupCommandId = 'install-cli' | 'install-analyzer' | 'login-devhub' | 'create-package';

export interface SetupItem {
  id: string;
  title: string;
  /** ok = satisfied; todo = needs you; info = waiting on something else or optional. */
  state: 'ok' | 'todo' | 'info';
  detail: string;
  actions: SetupAction[];
}

/**
 * Turns discovery results into a plain "what is left to set up" list. Purely advisory: ReleasePilot only ever
 * offers commands to copy and never creates packages, orgs or files on your behalf here (spec FR-35).
 */
export function buildSetup(s: Pick<DiscoverySnapshot, 'project' | 'tooling' | 'git' | 'orgs' | 'devHub' | 'selectedPackage' | 'validationOrg'>): SetupItem[] {
  const items: SetupItem[] = [];
  const add = (id: string, title: string, state: SetupItem['state'], detail: string, actions: SetupAction[] = []) => items.push({ id, title, state, detail, actions });

  add('project', 'Salesforce DX project', s.project ? 'ok' : 'todo',
    s.project ? 'sfdx-project.json found.' : 'Open the root folder of a Salesforce DX project (the folder that contains sfdx-project.json).');
  add('cli', 'Salesforce CLI', s.tooling?.sf ? 'ok' : 'todo', s.tooling?.sf ? s.tooling.sf.split(' ')[0] : 'The "sf" command was not found on PATH. Install it, then restart VS Code.',
    s.tooling?.sf ? [] : [{ kind: 'copyCmd', id: 'install-cli', label: 'Copy install command' }]);
  add('analyzer', 'Code Analyzer v5', s.tooling?.codeAnalyzer ? 'ok' : s.tooling?.sf ? 'todo' : 'info',
    s.tooling?.codeAnalyzer ? `code-analyzer ${s.tooling.codeAnalyzer.version}` : 'The code-analyzer plugin is not installed. It also needs Java 11 or newer for the PMD engine.',
    s.tooling?.codeAnalyzer || !s.tooling?.sf ? [] : [{ kind: 'copyCmd', id: 'install-analyzer', label: 'Copy install command' }]);
  add('git', 'Git repository', s.git?.isRepo ? 'ok' : 'todo', s.git?.isRepo ? `On branch ${s.git.branch ?? '?'}.` : (s.git?.error ?? 'The project must be in a Git repository so source can be fingerprinted.'));

  const devHubs = s.orgs.filter(o => o.isDevHub);
  add('devhub', 'Dev Hub selected', s.devHub ? 'ok' : 'todo',
    s.devHub ? `${s.devHub.alias ?? s.devHub.username} (${s.devHub.orgId})`
      : devHubs.length ? 'Choose your Dev Hub in the "Dev Hub" list at the top of the page.' : 'No authenticated Dev Hub found. Log in to the org that owns your package.',
    s.devHub || devHubs.length ? [] : [{ kind: 'copyCmd', id: 'login-devhub', label: 'Copy login command' }]);

  const dirs = s.project?.packageDirectories ?? [];
  const withPackage = dirs.find(d => d.package);
  const withId = dirs.find(d => d.packageId);
  if (!s.project) {
    add('package', 'Package declared in sfdx-project.json', 'info', 'Waiting for a Salesforce DX project.');
  } else if (!withPackage) {
    add('package', 'Package declared in sfdx-project.json', 'todo',
      'No package directory has a "package" entry, so there is nothing to release. ReleasePilot manages managed second-generation packages: add "package" and "versionNumber" to a packageDirectories entry and map the package name to its 0Ho ID in packageAliases. If the package does not exist yet, create it once (this makes a permanent package in your Dev Hub, which ReleasePilot never does for you).',
      [{ kind: 'openProject', label: 'Open sfdx-project.json' }, { kind: 'copyCmd', id: 'create-package', label: 'Copy create-package command' }]);
  } else if (!withId) {
    add('package', 'Package declared in sfdx-project.json', 'todo', `"${withPackage.package}" has no 0Ho package ID in packageAliases.`, [{ kind: 'openProject', label: 'Open sfdx-project.json' }]);
  } else {
    add('package', 'Package declared in sfdx-project.json', 'ok', `${withId.package} (${withId.packageId}) in ${withId.path}.`);
  }

  add('ownership', 'Dev Hub owns the package', s.selectedPackage ? 'ok' : s.devHub && withId ? 'todo' : 'info',
    s.selectedPackage ? `${s.selectedPackage.name} (${s.selectedPackage.id}).`
      : s.devHub && withId ? 'The selected Dev Hub does not list that package. Select the Dev Hub that owns it, or fix packageAliases.' : 'Waiting for a Dev Hub and a declared package.');
  add('validation', 'Validation org (needed for tests)', s.validationOrg ? 'ok' : 'info',
    s.validationOrg ? `${s.validationOrg.alias ?? s.validationOrg.username}` : 'Optional until the Pre-package Tests step: choose a scratch org or sandbox (never your Dev Hub).');
  return items;
}

const slug = (v: string) => v.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'MyPackage';

/** Text for the "copy command" buttons. Built here (not by the webview) so the clipboard only ever receives known commands. */
export function setupCommand(id: string, s: Pick<DiscoverySnapshot, 'project' | 'devHub'>): string | undefined {
  switch (id) {
    case 'install-cli':
      return 'npm install --global @salesforce/cli';
    case 'install-analyzer':
      return 'sf plugins install code-analyzer';
    case 'login-devhub':
      return 'sf org login web --alias my-devhub --set-default-dev-hub';
    case 'create-package': {
      const dir = s.project?.packageDirectories[0]?.path || 'force-app';
      const hub = s.devHub?.alias ?? s.devHub?.username ?? '<devhub-alias>';
      return `sf package create --name "${slug(s.project?.name ?? 'MyPackage')}" --package-type Managed --path ${dir} --target-dev-hub ${hub}`;
    }
    default:
      return undefined;
  }
}
