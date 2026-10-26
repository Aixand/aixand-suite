# Validation

Validated on Linux with Python 3.14.7, using the sibling Agent Manager 0.1.0,
Carrier 0.2.0, and Undercurrent 0.1.0 SDKs and matching local runtime binaries.

## Automated checks

- 26 focused tests passed for module-level usage, optional scopes, receipt/revision
  handling, input serialization, cancellation, resource ownership, failed setup,
  uncertain launches and writes, authenticated acceptance, acknowledgment failure,
  and managed consumer error propagation.
- Five integration tests passed: ordinary Python request/reply, a full managed
  team exchange, Carrier-free spawning with detach/stop checks, default connections
  across separate event loops, and supervised consumer failure after stopping a
  private Carrier service. They use real SDKs, MCP, and isolated runtime services.
- The integration run verified separate sessions/credentials, reply correlation,
  acknowledgment, session shutdown, and private-service cleanup. Agent Manager
  released the managed-run leases after runtime termination.
- A wheel built successfully and imported from a temporary installation outside
  the source checkout. Dependency validation (`pip check`) passed.

## Stabilization pass

The following behavior is covered without changing the composition architecture:

| Behavior | Verification |
| --- | --- |
| Spawn without `address=` | Launch/send/wait works while Carrier provisioning and client creation are forbidden by test guards. |
| Spawn with `address=` | Real MCP setup, separate authenticated identities, acceptance receipts, and supervised consumer tasks. |
| Direct send versus inbox delivery | Controlled interleavings in both directions prove shared input serialization and acceptance gating. |
| Default and explicit waits | Default waits retain the most recent direct-send revision after a Carrier delivery; `after=` selects an older receipt explicitly. |
| Consumer failure propagation | Stopping a private Carrier service interrupts `connection.wait_for(...)`, cancels its pending work, and reports the failed address. |
| Stop versus close | Stop cancels queued sends and the consumer before terminating its session; close detaches by default, and opt-in cleanup stops only owned sessions. |
| Separate `asyncio.run()` calls | Two actual runs create different bridge processes; explicit `aixand.close()` joins their readers, reaps their bridges, and leaves no pending tasks. |

Two regressions were fixed: background Carrier deliveries overwrote the default
wait receipt, and `agent.stop()` could wait behind a send blocked on readiness.
Resource-warning checks also found and corrected an unclosed SQLite inspection
connection in the integration test itself. These checks use test providers, not
live credentials. The live-provider evidence below is from the initial implementation.
The final stabilization suite passed all 31 tests with resource warnings enabled
and no unraisable resource errors.

## Live provider check

On September 23, 2026 (Asia/Manila), `examples/team.py` completed with two real
Codex agents using the existing `backup` profile. The task asked whether agent
profile/auth management should be separated from runtime/session control and
required consultation with Brain, without reading or modifying project files.

Carrier recorded the complete substantive exchange:

```text
coordinator -> implementer -> brain -> implementer -> coordinator
```

All four messages were acknowledged; Brain's reply referenced Implementer's
question and the final reply referenced the original coordinator job. Five
agent-authenticated acceptance receipts covered the two setup prompts and three
inbox deliveries. Python saved the final Carrier reply, closed without consumer
errors, stopped both sessions and its private service, and the two Agent Manager
leases were released. Codex's initial trust prompt for this newly created folder
was accepted manually in the test session.

The live run validates the complete MCP/terminal path. It does not make runtime
readiness a task-success signal: this example finished on an explicit final
Carrier response. Run manifests, credentials, databases, and model transcripts
are local artifacts and are not committed.
