# Integrate independent managers

Suite composes five external managers through public APIs. It owns workspace
associations, presentation and captured operation intent. Managers own their
respective provider, conversation, prompt, skill and MCP lifecycles.

## Prepare dependencies

From the Suite root, run `./dev.sh prepare` for pinned published dependencies.
Use `./dev.sh prepare --local-sources` only when deliberately developing with
sibling checkouts. See [dependency preparation](../../../docs/development/dependencies.md).
Packaged workers use installed distributions and ignore source overrides.
Orchestration MCP is built from `mcps/orchestration`; it is not another manager.

## Keep state with its owner

Agent Manager supplies native environments, profiles and provider operations.
Conversation Manager owns managed chat transcripts, queues, settings, approvals
and worker lifecycle. The beta provider scope is Codex and OpenCode; capability
inventory does not prove account access or a successful model turn.

Prompt, Skill and MCP Manager stores are independent of the selected profile.
`PROMPT_MANAGER_HOME`, `SKILL_MANAGER_HOME` and `MCP_MANAGER_HOME` select their
stores. Resource selection is captured before chat launch. Editing a library does
not change a running chat's captured configuration. Native skill delivery requires
separate qualification and must not be implied by library availability.

[Agent integration](../../../docs/development/agent-integration.md) owns resource boundaries.
[Application composition](../agent-bridge/application/README.md) owns Suite launch
intent and recovery. [Onboarding](../../../docs/development/onboarding.md) owns native readiness.

## Recover uncertain work

Retain original environment, profile, conversation and operation IDs. Inspect an
unconfirmed mutation before retrying it; do not blindly repeat or create a new
identity. Manager receipts and Suite journals remain authoritative for their own
operations. A missing dependency or unsupported capability should produce a
bounded unavailable result rather than a fallback into another manager's store.
