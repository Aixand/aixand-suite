# Choose an installation role

The development beta defines three payload roles. Native artifacts need target qualification; a role does not establish public release availability.

| Role | Payload | Workspace |
| --- | --- | --- |
| Desktop | Native shell, Web assets, backend and product runtimes | This computer or Server |
| Client | Native shell and Web assets | Server only |
| Server | Backend and product runtimes | Hosts a workspace |

| Concern | Contract |
| --- | --- |
| Products | Independent installation identities, state owners and licenses. Libraries stay inside consumer interpreters. |
| Versions | Source component versions may diverge; see the [component contract](../../../docs/reference/components.md). |
| Maintenance | [Server setup](../../server/docs/operations/installation.md) owns product review, licenses, state modes and selective removal. |
| Cleanup | Review the explicit cleanup plan. Suite removal must not silently delete shared products, projects or account data. |
| Native roles | [Desktop](desktop.md) owns shell setup; [Client](client.md) owns remote-only behavior and isolated sessions. Client never starts/stops remote services. |

