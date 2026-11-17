# Suite architecture

Suite combines independent managers, messaging, and process services into one
workspace. Execution belongs to the selected backend's computer.

- **Suite:** interface and local backend, with optional Server connections.
- **Client:** interface and native connection transport.
- **Server:** workspace backend without a desktop/browser frontend.

## Boundaries and ownership

This diagram shows runtime coordination, not package dependencies.

```mermaid
flowchart TD
    accTitle: Suite runtime responsibilities
    accDescr: Web in the native shell communicates with Server. Server uses private workers and bridges for manager integrations, Runner effects, and optional device and voice integrations. Runner executes IR; independent managers, Carrier, and Undercurrent retain their domain state.
    UI[Web interface and native shell] --> Server[Server HTTP and WebSocket transports]
    Server --> Workers[Private application workers and bridges]
    Workers --> Managers[Agent, Conversation and resource managers]
    Workers --> UC[Undercurrent process supervision]
    Workers --> Carrier[Carrier message delivery]
    Workers --> Runner[Runner durable workflows]
    Runner --> IR[IR execution engine]
    Runner --> Effects[Explicit application effect host]
    Effects --> Workers
    Workers --> Optional[Connect and Vox integrations]
```

Server's TypeScript transports handle authenticated HTTP/WebSocket requests.
Private Python workers coordinate manager APIs and workspace state; Rust bridges
provide native integration. See [ownership](ownership.md) for each authority.

Server still consumes `orchestration_mcp.compat` services. Application extraction
is incomplete; there is no separate compatibility distribution.

Managed chats use Conversation Manager. Native terminals use Agent Manager and
Undercurrent. Runner schedules durable jobs; IR defines execution. The Python SDK
is optional.

## Further details

- [Execution and recovery](execution-and-recovery.md)
- [Security boundaries](security.md)
- [Component map](../README.md#find-a-component)
- [Compatibility](../reference/compatibility.md)
- [Application services](../../apps/server/agent-bridge/application/README.md)
- [Development integrations](../development/integrations.md)
