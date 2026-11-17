# Native onboarding contract

Core onboarding supports Codex/OpenCode native environments and profile aliases.
User steps: [first workspace](../getting-started/first-workspace.md).

## Ownership and public contracts

[onboarding.py](../../apps/server/agent-bridge/application/onboarding.py) adapts
Agent Manager. Agent Manager supplies installation plans/progress; Undercurrent
provides retained installation and sign-in terminals.

- Prepare with `Manager.prepare_provider_operation`; execute with `Manager.perform_provider_operation` or awaited Client equivalents.
- Capture the registry, exact plan/target, and environment revision. Revalidate before execution.
- Create profiles with `Client.manage_profiles('create_profile', {'name': ...}, request_id=...)` so retries retain identity.
- Suite retains dispatch/completion receipts. Inspect unconfirmed launches before retrying.

Suite profile `identity` equals `profile_id`; retain `environment_id`, `profile_id`,
and revision. Native authentication uses `auth: null`. Profiles do not own resource
libraries or shared saved-login records.

Codex acceptance repeats its bounded native status check. OpenCode's completed
login is retained as configured but lacks a qualified live status probe. Neither
establishes model entitlement.

Incomplete operations, replaced identities, and unsupported provider selections
prevent completion. Reconciliation preserves history and removes unsupported
selections from current progress.

## Verification

- Server coordinator/request-policy tests: completion, revisions, reconciliation, registration retries.
- `test_onboarding_native.py`: public SDKs with disposable executable fixtures.
- Agent Manager's `test_provider_operation_sdk.py`: capture, progress, stale revisions, foreign registries.
- `onboarding-native.spec.ts`: browser fixture onboarding and failure/retry.

These checks do not perform live provider login or verify model access.
