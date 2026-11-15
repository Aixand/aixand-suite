# ADR 0001: Compose Suite through one application backend

- Status: Accepted
- Scope: Aixand Suite v0.1.0-beta development architecture

## Context

Workspace behavior, provider integration, resource delivery and execution
coordination span Server, Orchestration MCP, voice and SDK code.
The independent managers now define clearer public contracts and domain ownership.
Source folders are grouped by role. Application boundaries still require consumer refactoring.

The goal is predictable development, updates and recovery through clear ownership
and shared application operations. Moving files alone does not establish these
boundaries or qualify all integrations.

## Decisions

### One Suite application owner

Server owns Suite workspace policy and application use cases. Web, Suite-connected
MCP tools and voice invoke the same application operations. Each behavior has one
owner; interfaces must not independently implement chat startup, resource capture,
project policy or lifecycle coordination.

NestJS owns HTTP/WebSocket transports, API authentication and browser event delivery.
The Python application layer coordinates public manager APIs and Suite persistence.
Keep that layer inside Server's existing private worker initially. Use the existing
private bridge; introduce a separate service or general-purpose RPC framework only
when a concrete lifecycle, isolation or deployment requirement justifies it.

Within Server, preserve these logical boundaries:

| Boundary | Responsibility |
| --- | --- |
| Transport | Authenticate, validate request envelopes, dispatch and deliver results/events |
| Application | Execute Suite use cases and coordinate integrations |
| Integration | Translate public manager/runtime contracts |
| Workspace | Persist Suite-owned organization, associations and preferences |

TypeScript, Python and Rust remain in use. The architecture organizes their
responsibilities; it does not remove the cost of maintaining several languages.

### Independent domain owners

The ownership table in [Suite architecture](../architecture.md#ownership) defines
the domain owners. Integrations use their supported public APIs. Suite must not
reimplement manager validation, reconciliation, conversation queues or execution
lifecycle engines.

Suite owns projects, workspace organization, display preferences, application
intent and associations to manager-owned objects. Retain exact serialized manager
references and receipts. Managers remain authoritative for environments,
conversations, transcripts, resources and lifecycle records. UI caches and
projections are disposable observations, not another domain authority.

Environment UUIDs preserve targeting. Profile aliases are display/selection
metadata and must not silently retarget a retained attachment when reused.

### MCP, voice and Python SDK boundaries

Orchestration MCP retains independently usable standalone operations over public
manager/runtime APIs. Suite-connected workspace tools reach Server's application
services through a private authenticated interface. They must not independently
open Suite's database or reproduce its workspace policy. The precise authentication
and transport details will be defined when implementing this boundary.

Vox owns audio transport, transcription, speech and voice interaction. It invokes
shared application/conversation operations rather than owning another chat engine.
Connect owns pairing, remote transport, file transfer and its receiving companion;
the receiving host invokes its own supported local integrations.

The Python SDK remains optional for Python consumers. Server can access manager
APIs directly. The SDK must not become a required intermediary, another Suite
workspace owner or another durable workflow scheduler. Audit overlap with Server
and orchestration before expanding its composition behavior.

### Workflow and process ownership

Runner owns durable job acceptance, scheduling, checkpoints, cancellation and
outcomes. IR owns workflow definitions, validation, expressions and execution
semantics. Suite effects run through explicit host adapters; workflow documents
cannot choose Suite sockets or credentials.

Managed conversations use Conversation Manager. Native agent terminal executions
use Agent Manager with Undercurrent. Shared project/environment associations do
not imply a shared process or lifecycle. Preserve the manager-recorded runtime
owner across attachment and reconnection, including shared-worker ownership.

### Operation identity and recovery

For mutating operations crossing application boundaries:

1. The caller supplies an operation ID before dispatch.
2. Suite retains the application intent and the owning manager's receipt/reference.
3. Retrying that ID inspects or resumes the same intent under the owner's contract.
4. Events carry a cursor or revision. After a gap, clients refresh an authoritative
   snapshot rather than assuming their local projection is complete.
5. Unknown outcomes remain unknown until reconciled. A timeout, disconnect or
   reconnect does not authorize replacement execution or blind message replay.

Capture supported resource inputs and provenance before launch. Retries preserve
that capture. Library discoverability alone does not establish delivery support.
Suite retains coordination information without maintaining a second authoritative
transcript, delivery queue or provider execution journal.

### Explicit removal and termination semantics

| Operation | Owner and intended scope |
| --- | --- |
| Remove from workspace | Suite association or visibility |
| Close conversation | Conversation Manager's supported conversation semantics |
| Stop runtime | Explicit termination of the recorded runtime owner |
| Delete retained history | Separate manager-supported operation with explicit scope |

These are distinct user actions. Show the impact before stopping a worker shared
by several conversations. An unavailable reference remains visible with a useful
status; it is not silently deleted or rebound using a reused profile name.

### Beta acceptance scope

The required v0.1.0-beta path is local Codex/OpenCode administration, managed chats
and native terminals. Actual provider capabilities determine available controls.
Prompt and MCP delivery enter the release acceptance scope only where the adapters
support them and the path is verified.

Advanced workflows, native skill delivery, remote chat and Vox are outside the
required beta acceptance criteria until separately qualified. Their existing code
remain outside required beta qualification. This does not require deleting those features or
claiming they are qualified because the packages exist.

### Maintainable development and updates

- Provide one obvious root development entry point for dependency preparation,
  service startup and focused checks. Document commands that are still pending;
  an architectural decision is not evidence that tooling already implements it.
- Development may explicitly use sibling source checkouts. Releases use pinned,
  tested component artifacts and compatible dependency versions.
- Keep integrations small and public-contract based. A manager update should be
  adapted in its owning integration module and checked at that boundary.
- Add focused integration checks for real contract and recovery behavior. Use
  broader application tests for composed user paths rather than duplicating every
  manager's internal tests.
- Keep package names, protocol identities and installed data locations independent
  of source folder names.

## Consequences

Updates have explicit integration boundaries, and UI, MCP and voice can share
verified behavior. Debugging follows transport, application operation, integration
and owning manager. Release packaging qualifies a concrete compatible component set.

The costs are a mixed-language backend, several independently versioned packages,
and a private transport boundary that must preserve authorization and recovery
semantics. Avoid introducing additional layers without a demonstrated need.

## Implementation sequence and acceptance

First establish the Server-to-Orchestration MCP ownership boundary and audit the
Server/orchestration/Python SDK overlap. Validate it with one complete user path:

1. Select a Codex or OpenCode environment.
2. Start a project conversation with supported captured resources.
3. Disconnect and reconnect using the exact retained reference.
4. Handle an advertised approval through the authorized interface.
5. Explicitly stop the recorded runtime and observe its terminal lifecycle.

Exercise the shared application operations from the UI and Suite-connected MCP.
Include interruption, repeated-operation, unavailable-reference and unauthorized
access cases. Once this path is verified, migrate remaining areas against the
same boundaries.

Implementation progress belongs in [the architecture qualification limits](../architecture.md#current-foundation-and-qualification-limits).
Acceptance of this ADR does not establish full feature parity, live provider
qualification or complete separation.

## Changing this decision

Record the reason, tradeoffs and affected contracts when changing a decision.
If superseded, link the replacement ADR here and preserve this record so that
future development can distinguish intentional changes from architectural drift.
