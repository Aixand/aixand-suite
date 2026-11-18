# Aixand Connect

Paired-device transfer and receiving-side execution components for Aixand Suite.

**Current status:** the companion and sender libraries exist, but current Server dispatch lacks legacy Connect handlers. Read [implementation status](docs/reference/status.md) before attempting UI workflows.

## When to use Connect

Connect supplies paired receiver, transfer and remote-execution building blocks. The receiver owns execution and files. Current Suite Connect handlers are absent; UI schemas and companion implementations do not establish end-to-end availability. Connect is separate from [Client-to-Server access](../../docs/guides/remote-access.md).

[Read the guide](docs/README.md).

## Set up

Use the receiver commands and explicitly scoped pairing qualification procedure. Restart with the same state directory and omit `--pair` to retain pairing.

[Read the guide](docs/development/setup.md#set-up).

## Verify your first transfer

After Server integration is restored, compare a disposable file with the receiver contents and inspect receipts before retrying.

[Read the guide](docs/development/setup.md#verify-your-first-transfer).

## Remote Codex chats

Prepare the receiver's Codex login and project roots. Current Suite remote-chat routing is unavailable; Windows native execution remains unverified.

[Read the guide](docs/development/setup.md#configure-direct-codex).

## Managers on connected devices

Use an explicit interpreter where needed; follow the managed conversation contract for immutable ownership and no fallback.

[Read the guide](docs/development/setup.md#configure-a-manager-interpreter).

## Copy a project to a device

The copy/test walkthrough is a retained application contract pending Server adapter restoration. Read the project lifecycle for snapshot rules.

[Read the guide](docs/reference/retained-ui.md).

## Compare a project across machines

Comparison prompts and UI labels are reference material pending orchestration restoration and qualification.

[Read the guide](docs/reference/retained-ui.md).

## Transfer behavior

Read the canonical lifecycle for hashing, exclusive publication, cancellation and uncertain delivery. [HTTP contracts](docs/reference/http.md) own size and filename bounds.

[Read the guide](docs/lifecycles/transfers.md).

## Trust and storage

Read pairing, private IPv4 and tunnel requirements before deployment. [Storage](docs/reference/storage.md) describes sensitive credentials and retained files.

[Read the guide](docs/architecture/trust.md).

## Development and packaging

Build the deterministic companion separately from Web. Use [verification](docs/development/verification.md) for exact test commands and evidence scope; prior platform observations are qualified in the retained UI note.

[Read the guide](docs/development/packaging.md).

## Component architecture

Read component ownership, contracts and implementation gaps.

[Read the guide](docs/README.md).

[Suite](../../README.md) · [Server integration](../../apps/server/docs/integrations/connect.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
