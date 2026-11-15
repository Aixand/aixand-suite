# Native agent onboarding

Suite v0.1.0-beta onboarding supports Codex and OpenCode. Both use native
Agent Manager environments and profile aliases. Onboarding does not create shared
saved-login libraries or bind prompt, skill or MCP resources to profiles.

## User flow

1. Select Codex, OpenCode or both.
2. Detect the existing CLI, or explicitly request a managed installation.
3. Create or select a profile with a stable environment identity.
4. Open its retained sign-in terminal and finish the provider's native login.
5. Explicitly accept the profile, then choose projects or skip project setup.

Agent Manager supplies installation methods, prerequisites, approved versions,
plans and progress. Suite retains the operation ID before dispatching a worker.
The worker calls the public `Manager.perform_provider_operation` API with the
captured descriptor. It does not implement a second provider installer.
Undercurrent supplies retained terminals for installation and interactive login.
A running, configured local daemon is therefore required for those operations.

## Ownership and public contracts

`apps/server/agent-bridge/application/onboarding.py` adapts the public Agent
Manager SDK into Suite profile and readiness views. Profile creation uses
`Client.manage_profiles('create_profile', {'name': ...}, request_id=...)` so a
retry returns the original identity rather than creating another environment.

Agent Manager provides synchronous `Manager.prepare_provider_operation` and
`Manager.perform_provider_operation`, with awaited Client equivalents. Preparation
captures the manager registry and exact installation plan, or immutable native
environment/profile IDs with an environment revision. Execution revalidates that
capture. Suite's retained operation journal owns dispatch and completion receipts.
An unconfirmed launch is inspected rather than blindly repeated.

Suite's profile `identity` field equals Agent Manager's `profile_id`.
`environment_id`, `profile_id` and revision fields remain present. Beta provider
capabilities declare native authentication; `auth` is null. UI readiness is a
Suite projection and must not replace either manager's native identity or
Conversation Manager's conversation-startup result.

A current signed-in observation can satisfy onboarding. Codex acceptance performs
its bounded native status check again, so an external sign-out cannot be overridden
by an old successful login receipt. OpenCode has no qualified native status probe;
a completed native login is retained as configured but unverified access. Neither
observation establishes model entitlement or a successful conversation.

Unsupported providers are hidden by the picker and rejected on new onboarding
writes and completion. Historical progress remains readable and reconciliation
removes unsupported selections. Incomplete operations and replaced profile
identities prevent completion.

## Verification

- Server coordinator and request-policy tests exercise completion, reconciliation,
  revision conflicts, provider scope and project-registration retries.
- `test_onboarding_native.py` uses real public SDKs with disposable executable
  fixtures, testing profile retries, worker receipts, native login/readiness,
  external sign-out and retained installation admission.
- Agent Manager's `test_provider_operation_sdk.py` verifies public lifecycle
  capture, progress, immutable targeting, stale revisions and foreign registries.
- `onboarding-native.spec.ts` exercises the beta picker, installation progression,
  native profile sign-in and failure/retry in the simulated browser flow.

These are offline/fixture checks, not a claim of execution in this documentation
change. They do not establish live provider login or model entitlement.
