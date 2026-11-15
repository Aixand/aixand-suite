# Choose an installation role

Packaging defines three roles for the development beta. Native artifacts need
separate target qualification; these roles do not establish public availability.

| Role | Payload | Workspace choice |
| --- | --- | --- |
| Desktop | Native shell, web assets, local backend and product runtimes | This computer or Server |
| Client | Native shell and web assets | Server only |
| Server | Backend and product runtimes | Hosts a workspace |

The installation model is distributed. Independent products retain their own
installation identities, state owners and licenses. Libraries stay in consumer
interpreters rather than becoming extra command-line products. Source component
versions may diverge; see [the component contract](../../../docs/reference/components.md).

See [Server setup and maintenance](../../server/docs/installation.md) for shared
product review, license acceptance, state modes and selective removal. Removing
Suite must not silently delete shared products, project directories or account
data. Review the explicit cleanup plan before applying it.

[Desktop development](desktop.md) owns native-shell setup. [Client](client.md)
owns remote-only behavior and its separate local session storage. Client never
starts or stops the remote host's services.
