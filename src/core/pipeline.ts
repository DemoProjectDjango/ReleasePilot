import { StepDefinition } from './models';

export const PIPELINE: readonly StepDefinition[] = [
  {
    id: 'preflight', title: 'Discover & Preflight',
    description: 'Verify the Salesforce DX project, CLI tooling, authenticated orgs, Dev Hub and package ownership (read-only).',
    dependsOn: [], optional: false, requiresApproval: false, plannedSlice: 2,
    requirements: ['FR-01', 'FR-02', 'FR-03', 'FR-04', 'FR-14']
  },
  {
    id: 'source', title: 'Source Ready',
    description: 'Confirm the local Git working tree is the authoritative source and snapshot its fingerprint. Optional conflict-safe retrieval from a developer org.',
    dependsOn: ['preflight'], optional: false, requiresApproval: false, plannedSlice: 2,
    requirements: ['FR-06', 'FR-29']
  },
  {
    id: 'analysis', title: 'Static Analysis',
    description: 'Run Salesforce Code Analyzer and triage findings.',
    dependsOn: ['source'], optional: false, requiresApproval: false, plannedSlice: 3,
    requirements: ['FR-07', 'FR-08', 'FR-09', 'FR-30']
  },
  {
    id: 'tests', title: 'Pre-package Tests',
    description: 'Run Apex (and LWC Jest when configured) tests in a validation org and evaluate coverage targets.',
    dependsOn: ['analysis'], optional: false, requiresApproval: false, plannedSlice: 3,
    requirements: ['FR-10', 'FR-11', 'FR-12', 'FR-13']
  },
  {
    id: 'package-readiness', title: 'Package Readiness',
    description: 'Validate package ID, Dev Hub, namespace, dependencies, version plan and ancestry.',
    dependsOn: ['tests'], optional: false, requiresApproval: false, plannedSlice: 4,
    requirements: ['FR-14']
  },
  {
    id: 'package-build', title: 'Create Beta Package',
    description: 'Create a validated beta package version (08c request, then 04t) with code coverage, tracked to completion.',
    dependsOn: ['package-readiness'], optional: false, requiresApproval: false, plannedSlice: 4,
    requirements: ['FR-15', 'FR-16']
  },
  {
    id: 'clean-install-qa', title: 'Clean-install QA',
    description: 'Create a clean scratch org, install the exact 04t, assign permissions, smoke test and record manual QA.',
    dependsOn: ['package-build'], optional: false, requiresApproval: false, plannedSlice: 5,
    requirements: ['FR-17', 'FR-18', 'FR-19', 'FR-20', 'FR-23']
  },
  {
    id: 'upgrade-qa', title: 'Upgrade QA',
    description: 'Existing products only: previous released version to candidate upgrade verification. Beta-to-beta upgrades are never attempted.',
    dependsOn: ['clean-install-qa'], optional: true, requiresApproval: false, plannedSlice: 5,
    requirements: ['FR-32']
  },
  {
    id: 'release-review', title: 'Release Readiness',
    description: 'Re-verify every gate against the exact candidate and produce the consolidated readiness report.',
    dependsOn: ['clean-install-qa', 'upgrade-qa'], optional: false, requiresApproval: false, plannedSlice: 6,
    requirements: ['FR-24', 'FR-28']
  },
  {
    id: 'promotion', title: 'Approve & Promote',
    description: 'Irreversible. Requires explicit confirmation of package, Dev Hub and 04t; verifies Released status afterwards.',
    dependsOn: ['release-review'], optional: false, requiresApproval: true, plannedSlice: 6,
    requirements: ['FR-25', 'FR-26']
  }
];
