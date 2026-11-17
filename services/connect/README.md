<p align="center">
  <img src="../../apps/web/public/favicon.svg" width="160" height="160" alt="Aixand logo">
</p>

# Aixand Connect

<p align="center">
  <strong>Pair devices. Transfer files. Run work on the receiving computer.</strong>
</p>

Send project files, run remote Codex chats, and test project snapshots on a paired computer.
The receiver streams the file to a temporary location, verifies SHA-256, and
publishes it without overwriting an existing filename. Suite shows progress and
the verified destination in the conversation.

The MVP uses a Linux Suite host and a Python 3.11+ receiving companion written
for Windows, macOS, and Linux. The companion has no third-party dependencies.
Optionally, it runs Codex chats in existing project directories on the connected
computer. Codex must be installed and signed in on that computer; the full Suite,
Undercurrent, and Agent Manager are not required for direct chats. Optional
managed chats can use an existing Agent Manager profile on macOS/Linux. Remote desktop and an
interactive terminal attachment are outside this release.

## When to use Connect

Use Connect to send a file or project snapshot to a paired device, or to run
supported remote Codex work on that device. The receiving computer owns its
provider software, login, execution, and resulting files.

Connect is separate from [Client-to-Server access](../../README.md#work-across-computers).
Client opens a Server's workspace interface; Connect adds paired receiving
devices to that workspace. It does not replace the Server's SSH/HTTPS connection.
File transfer does not require an agent on the receiver.

The managed-chat helper has migration limits described below; do not infer
end-to-end UI support from its API alone. Native remote Codex execution on
Windows remains unverified. See [Suite qualification limits](../../docs/reference/compatibility.md).

[Pair a device](#set-up) · [Check a transfer](#verify-your-first-transfer) ·
[Remote chats](#remote-codex-chats) · [Project copies](#copy-a-project-to-a-device) ·
[Trust and storage](#trust-and-storage) · [Development](#development-and-packaging)

## Set up

1. Connect the **Suite host and receiving computers** to the same NetBird account.
   Being able to list a peer through the API does not prove that the Suite host
   can connect to it.
2. Open **Suite → Settings → Devices**. Save your NetBird HTTPS API URL and a
   service-user API token permitted to read peers. The default URL is
   `https://api.netbird.io/api`; a self-hosted HTTPS API is also supported.
3. Expand **Pair a device** and download `aixand-connect.pyz` on the receiving
   computer. Install Python 3.11+ if needed.
4. Start the companion on that computer using its **NetBird IPv4 address** and
   the folder where files should arrive:

   Linux/macOS:

   ```sh
   python3 aixand-connect.pyz --bind 100.80.1.2 --receive-dir "$HOME/Downloads/Aixand" --pair
   ```

   Windows PowerShell:

   ```powershell
   py -3 aixand-connect.pyz --bind 100.80.1.2 --receive-dir "$env:USERPROFILE\Downloads\Aixand" --pair
   ```

   Substitute the actual NetBird address. The receiving folder is created if
   absent. Keep the process running; this MVP does not install a background
   service. Restart with the same arguments **without `--pair`** to retain pairing.
5. Permit TCP **47831** from the Suite host to the receiver in NetBird's access
   policy and the device's host firewall. A different port can be selected with
   `--port` and entered in Suite's pairing form.
6. In Suite, load NetBird devices, select the receiver, choose a unique name,
   and enter the one-time pairing code displayed by the companion. The code
   expires after ten minutes and is never entered in chat.
7. Open a native chat associated with a saved project and ask:

   > Copy `dist/app.zip` to my Windows PC.

The source is on the **Suite host**, inside that chat's project. Files on the
computer running your browser must first be uploaded into the project through
another mechanism. A scratch chat without a saved project cannot send files.

To change a receiving folder or regenerate pairing, stop the companion, restart
with the desired folder and `--pair`, and pair the device again in Suite. Pairing
replaces its previous Suite credential. One receiver pairs with one Suite owner.
Only one receiver process can use a state directory at a time.

## Verify your first transfer

Create a small disposable text file in the chat's saved project on the Suite
host. Ask the chat to send it to the paired device. Confirm the destination
exists and its contents match. Suite should report verified delivery, not only
upload progress. If the acknowledgment is lost, use **Check delivery** to inspect
the retained receipt before attempting another send.

Stop the companion with Ctrl+C when finished. Delivered files remain on the
receiver; remove only your disposable test file when no longer needed. Keep the
same state directory and omit `--pair` when restarting an established pairing.
The companion installs no automatic login service. If persistent access is wanted,
review an OS-specific startup plan with the user before changing startup settings.

## Remote Codex chats

Install and sign in to Codex on the remote computer (`codex login`). Update its
companion download, stop the old process, and add `--project-root` when restarting.
For example, on a Homebrew Mac with Python 3.11+:

```sh
/opt/homebrew/bin/python3 "$HOME/dev/aixand-connect.pyz" \
  --bind 100.80.1.2 --receive-dir "$HOME/Downloads/Aixand" \
  --project-root "$HOME/dev"
```

Use that computer's actual NetBird address. Omit `--pair` to preserve the existing
pairing. `--project-root` must already exist and can be repeated. `--codex` selects
an explicit executable if it is not on PATH or in a standard installation location.
Keep the companion running; automatic startup at login is not installed by this MVP.

In Suite, choose **Chat → Remote chat**, or **Settings → Devices → Start chat on
device**. Select the device, enter an existing remote directory such as
`~/dev/my-project`, choose its access mode, and start chatting. Suite validates the
directory on the remote computer and shows the device and canonical directory
above the conversation. You can also ask an existing local Suite chat:

> Start a chat on my Mac in ~/dev/my-project and run its tests.

The `start_remote_chat` workspace tool creates a linked conversation and submits
the task there. Its default access mode follows Suite's saved spawn setting;
the manual dialog defaults to Workspace write. Existing files are not copied or
synchronized automatically. Transfer or clone the project before starting a chat.

Commands, edits, searches, and tests run through Codex's normal tools on that
device. Its own Codex login, configuration, skills, and MCP setup apply. Suite
does not copy a local profile's authentication or MCP configuration to it.
Project roots restrict where a chat can start; Codex's selected sandbox and
approval policy govern what its commands can access.

Replies, command output, approvals, and Stop use the existing chat controls.
Closing the browser or restarting the Suite bridge leaves the remote Codex
process running. Reopen the chat to reload history and pending approvals. If the
companion itself stops, its Codex processes stop too; saved thread history can be
resumed after restart. Interrupted turns are not automatically resubmitted.
Unconfirmed requests retain their operation identity instead of repeating work.
Remote connection failures never route a task onto the Suite host.

There are at most four live remote Codex processes per companion. Idle sessions
can be evicted and resumed from Codex history; active turns and approvals are
retained. Stream buffers and displayed history are bounded, with truncation
reported. The remote chat MVP accepts text messages and uses the device's default
Codex model. Remote voice and interactive terminal attachment are not enabled.

## Managers on connected devices

Update the companion, then open **Settings → Devices → Managers on this device →
Check managers**. Discovery reports Agent, Conversation, MCP, Prompt and Skill
Manager packages separately. It reads configured profiles without launching a
worker. Installation alone does not prove authentication or live model access.

The managed device helper now uses compatible `agent-manager` and
`aixand-conversation-manager[agents]` packages and the configured Codex executable
on macOS/Linux (`python -m pip install "aixand-suite-connect[managers]"` in the selected manager
environment). Server Manager and an Undercurrent daemon are not required for
this chat path. Undercurrent remains the owner of native terminal execution.
Resource libraries are optional; explicit resource selections additionally use
the shared Orchestration MCP compiler. Legacy profile resource inheritance is
rejected before native startup rather than silently ignored.

Connect discovers Python environments through installed manager CLI scripts.
If the SDK is in another environment, select its interpreter explicitly:

```sh
python3 "$HOME/dev/aixand-connect.pyz" \
  --bind 100.80.1.2 --receive-dir "$HOME/Downloads/Aixand" \
  --project-root "$HOME/dev" \
  --manager-python "$HOME/.aixand/connect/manager-env/bin/python"
```

Keep the usual bind, receive directory, project roots and state directory when
restarting; omit `--pair` to preserve pairing. SDK installation and the runtime
remain device administration tasks. Discovery is cached for up to 30 seconds.

Select the directory and access mode. Auto delegates selection to Agent Manager's
configured policy; an explicit profile resolves to its immutable environment ID.
The decision, native environment, permissions and explicit resources are captured
before launch. Retries and reconnects never resolve a profile alias again or pick
another account. Credentials stay in the selected native home on the device.

Conversation Manager retains exact session/worker references across helper and
companion restarts. Operations keep stable IDs, and recorded dispatch intents
without receipts remain uncertain instead of being sent again. A missing worker
is reported rather than replaced. Old Server Manager bindings are left intact;
they are not automatically converted to new conversations.

The migrated helper supports create/state, send/cancel, events/history, native
approvals, settings and advertised commands. The current Suite frontend bridge
still needs its remote-chat routes ported to this helper contract; this helper
API adaptation alone does not qualify end-to-end UI or project-test paths.

The existing **Direct Codex · native login** option remains available separately.

The companion implementation supports managed native Codex text chats, streaming, approvals,
Stop and reconnect. Manager catalog editing, remote terminal attachment, voice,
other managed providers and remote desktop are outside this MVP. Project tests
and machine comparisons also default to Auto on each machine. Ask for a named
profile per device to override it, or explicitly select Direct Codex on devices
without managers. The comparison uses one shared source snapshot and shows the
actual profile and remaining allowance at selection for each machine. Auto
failure never silently changes to Direct Codex. File-only project copying still
requires no agent, manager or quota.

## Copy a project to a device

With an updated companion configured with `--project-root`, open a local Suite chat and ask:

> Copy this project to my Mac.

The chat's saved project is the default source; another saved project can be
selected through chat. Suite packages the current working files, including
uncommitted changes and new, nonignored files. It verifies the upload, creates a
fresh directory under the device's **first `--project-root`** at
`aixand-snapshots/<run-id>`, and extracts the files automatically. Existing remote
projects are not overwritten. The original chat shows **Project ready** only after
extraction is confirmed, together with the **Project folder** path. Copying does
not require Codex installed or signed in, start an agent, install dependencies,
or execute tests. The ZIP is the transfer package; no manual unzip is required.
The archive is also retained in the receiving folder for now.

You can later ask the same chat to run tests or work in that copied folder. The
agent retrieves its confirmed path using `get_project_run` and starts a remote
chat there with `start_remote_chat`; this subsequent work requires remote Codex.
An explicit request to send a ZIP as a file continues to use ordinary file transfer.

To copy and test in one request, with Codex installed and signed in on the device:

> Copy this project to my Mac and run its tests.

That action also starts a linked remote Codex chat in the extracted workspace.
The remote chat defaults to Workspace write; test instructions can specify setup
commands or a particular test suite.

A card in the original chat shows packaging, upload progress, remote directory,
test status, and the final report. **Open remote chat** shows command output and
lets you answer questions or approve commands. Reports distinguish passed,
failed, blocked, and unconfirmed results. A completed Codex turn alone does not
mean tests passed; the report is Codex's assessment, with its command execution
history available in the linked chat.

## Compare a project across machines

From a local native Codex chat, ask:

> Test this project on the Linux host and my Mac, then compare the results.

Suite freezes the saved project's current source **once**. Each selected machine
receives those same files in a separate extracted workspace and starts its own
linked Codex test chat. The Suite host uses its existing local Codex runtime and
an isolated directory under the chat state directory's `project-workspaces/`;
it does not need a paired companion. Paired machines need Connect and Codex as
for a single-device test. “Suite host” means the computer running the backend,
which may be different from the browser's computer.

The comparison card shows independent progress and passed, failed, blocked, or
unconfirmed reports. Open a machine's test chat for command output or to answer
an approval. A setup failure, offline device, or failed test on one machine does
not stop another. **Stop machine** affects that target; **Stop all machines**
affects the comparison. A finished comparison does not imply every test passed.

Select two to four distinct machines, including the optional Suite host. One
comparison runs at a time, with at most two target executions concurrently; other
targets stay queued. **Check machine** or **Check all machines** reconnects after
an uncertain outcome or Suite restart using the same snapshot, workspace, and
chat identities. It never silently repeats an unconfirmed test submission.
A failure before a test starts is shown separately from an executed test failure.

This compares the results reported by each Codex test chat, not a guaranteed
identical test command across operating systems. Specify the test command in your
request when you need that. Dependencies are installed independently on each
machine. Workspaces are retained for inspection, and changes are not synced back.

Snapshot rules:

- One saved project per operation, at most two target executions at a time,
  10,000 files, and 512 MiB of source content. Comparisons can select up to four machines.
- Includes source and lockfiles. Excludes Git metadata, installed dependencies,
  common build/cache folders, Git-ignored untracked files, `.env` files (except
  `.env.example`, `.env.sample`, and `.env.template`), and common credential names
  such as `.npmrc` and private key files. This is filename filtering, not a scan
  for every possible secret. Remote dependencies and credentials must be available
  on the target or set up there.
- Add `.aixand-connectignore` in the project root for additional exclusions. Use
  one project-relative path or glob per line, such as `private/` or `*.sqlite3`;
  `#` begins a comment. Negated patterns are not supported.
- Links, submodules, unsafe paths, and names that collide on case-insensitive
  filesystems are rejected. If source changes during packaging, the run fails
  before upload so it can be retried with a stable working tree.
- The manifest records file checksums and executable flags. The source identity
  displayed by the card identifies those exact files, independently of archive
  compression. This is a snapshot, not continuous synchronization; remote edits
  are not copied back.

Browser disconnection leaves the job running. After a Suite restart or a lost
acknowledgement, **Check project copy** reconciles the extracted folder without
reuploading or creating another folder. **Check project run** for test operations
reconciles the delivered snapshot and
reconnects to the same remote chat without resubmitting an unconfirmed task.
**Stop project copy** cancels preparation/upload; an already extracted project is
retained and reported as ready when confirmed. **Stop project run** for tests
also interrupts the remote turn;
already delivered archives and workspaces remain for inspection. Suite retains
its private archive cache only while the outcome is unresolved. Finished remote
workspaces and uploaded archives are retained until you remove them yourself.
Resolve or stop unfinished runs before removing their device. Conversation deletion
only removes Suite history and works while the device is offline. Running work and
its execution receipts are retained separately; deletion does not stop it. Manage
unresolved work in **Settings → Devices → Background work**. **Stop and delete**
waits for the assigned turn to stop; if that cannot be confirmed, ordinary deletion
remains available. A later reconnect never restores deleted conversations.

Update the companion on each device for retained-session observation. Suite checks
existing sessions through a read-only endpoint and can recover saved terminal turn
outcomes without starting or resuming a Codex process. An unavailable process with
no saved outcome stays unknown. Project files and provider history are retained.

## Transfer behavior

- One regular file per request, up to **20 GiB**, with four concurrent transfers
  per Suite/receiver and up to sixteen paired devices.
- Filename-only destinations inside the receiver's configured folder. Optional
  `send_file.name` selects a different name. Windows reserved names, path
  separators, alternate data streams, and unsafe names are rejected.
- Source paths must stay inside the chat's registered project. The Linux sender
  opens each directory/file without following symbolic links and rejects special
  files such as FIFOs and devices.
- The file is hashed before sending and verified again by the receiver. Streaming
  uses 256 KiB chunks; the whole file is never buffered in memory.
- Publication uses an exclusive hard link from a private staging directory.
  Use a filesystem that supports hard links, such as NTFS, APFS, or ext4.
  FAT/exFAT destinations are not supported. Existing files are never replaced.
- Cancellation removes partial data; it does not remove a file already delivered.
  Interrupted transfers do not resume from a byte offset. Ask to send again after
  the previous operation is confirmed failed or cancelled.
- A lost acknowledgement is **Delivery unconfirmed**, not success or definite
  failure. **Check delivery** queries the receiver's durable receipt without
  resending. If the receiver never saw the upload, cancel the uncertain transfer
  to establish a cancellation record before starting a new attempt.
- Browser disconnects do not stop a transfer. A Suite restart marks unfinished
  delivery uncertain; the receipt can be checked after reconnecting. A receiver
  restart removes partial files and recovers a publication that completed just
  before its receipt was written.

## Trust and storage

The existing single-owner Suite session authorizes all Connect settings/actions.
Chat tools expose device IDs and paths, never setup credentials or arbitrary
network endpoints. The NetBird integration only reads the peer list; it does not
change your network policies or install software on other devices.

The companion binds to the explicitly selected private IPv4 interface. Its HTTP
protocol relies on **NetBird's encrypted tunnel** for transport confidentiality;
there is no separate TLS listener. Use the NetBird interface, not a public port
forward or an ordinary unencrypted LAN interface. Wildcard, public, loopback,
and link-local addresses are rejected by the CLI. The local tests construct
loopback listeners directly and do not relax the production CLI.

Pairing exchanges a 256-bit one-time code for a distinct random device credential.
The receiver stores only credential hashes in `~/.aixand/connect/receiver.sqlite3`.
Use `--state-dir` to select another private directory. On Windows, use your own
user profile with its normal user-specific ACLs. The Suite stores its NetBird token
and outbound device credentials in its private chat SQLite database under
`AGENTS_STATE_DIR`; this uses the same OS-owner trust boundary as Suite's other
capabilities. They are not encrypted separately at rest, sent to models, or saved
in browser local/session storage. Backups of that database contain credentials.

Removing a device in Suite removes its saved outbound credential. To invalidate
an older copy of a credential on the receiver as well, pair it again. Transfers
with active or uncertain outcomes must be resolved before removing the device.

## Development and packaging

The Server's Python integration loads this package from `services/connect`. Set
`AIXAND_CONNECT_SOURCE` to the directory containing `aixand_connect` if deploying
it elsewhere, or install the package into `AGENTS_PYTHON`'s environment.

From the Suite root:

```sh
python3 -m pip install ./services/connect
python3 services/connect/build_companion.py build/connect/companion.pyz
```

Suite's `./dev.sh prepare` builds the companion at `build/connect/companion.pyz`.
Server serves the authenticated companion download; frontend `npm run dev` and
`npm run build` do not regenerate it. Rebuild after companion source changes.
The reproducible
archive contains the receiver, snapshot validation, Codex process transport, and shared protocol, not Suite's sender or
tests. Companion construction requires Python 3.11+.

Chat application tools are `list_devices`, `send_file`, `get_file_transfer`,
`cancel_file_transfer`, `start_remote_chat`, `copy_project_to_device`,
`test_project_on_device`, `list_project_test_targets`, `test_project_across_devices`,
`get_project_run`, and `cancel_project_run` in
`aixand_workspace`. `get_project_test` and `cancel_project_test` remain available
for existing conversations. Comparison selection uses paired `deviceIds` and
`includeHost`; `get_project_run` and `cancel_project_run` accept an optional
`targetId` from the comparison to control one machine. Existing idle native chats refresh
their tool schema through Suite's established tool-version migration. These tools
follow the existing top-level native-chat eligibility rules; this release does
not add a separate Vox or external MCP transport for Connect.

```sh
cd services/connect
PYTHONPATH=. python3 -m unittest discover -s tests -v
```

Receiver tests can run on Windows with `py -3 -m unittest discover -s tests -v`
from this directory. Linux sender tests are skipped on Windows.
Suite integration checks are documented in
[the server integration guide](../../apps/server/docs/connect.md).

Validation includes receiver/sender HTTP transfers and chat-tool integration on
Linux, gateway schemas, browser interactions and accessibility. A paired Mac was
verified over live NetBird for file transfer and native Codex 0.159.2 commands,
remote file read/write, streamed output, Suite bridge restart/reconnect, and Stop.
Project snapshot verification on that Mac ran four real tests confirming macOS,
modified source, untracked source, and dependency/credential-file exclusions;
the parent report and reopening the same remote conversation were also verified.
Approval routing and companion history recovery are also covered by a stdio
protocol fixture. Native remote Codex execution on Windows remains unverified.

NetBird's public [peer API](https://docs.netbird.io/api/resources/peers) is the
network inventory contract used by this integration.

Shared prompt, skill and MCP requests use Agent Manager 0.1.0-beta's
`resource-request-1` contract. Suite forwards `resources` for new chats, terminal
launches and workflow stages; profile defaults are read and atomically saved via
`profile-resources-get` / `profile-resources-set`. `launch-preview` stays offline.
The SDK owns merging, version pins, optional/required policy and delivery reports.
Accepted user content remains active while publisher changes await reconciliation.

Connect advertises `resourceRequestVersion`. Managed requests resolve on the paired
device with that device's manager stores and capabilities; store paths must refer
to that machine. Direct native chats report unsupported optional extras and reject
required extras. A remote request never switches execution routes. MCP delivery
reports describe configuration separately from live connection status. Rebuild
the companion download with the existing build script after updating Connect.

Managed MCP publisher identities are supported by Agent Manager/MCP Manager 0.1.0-beta.
Manager discovery advertises `agent-manager/resource-request-2` when available.
Unresolved targets and historical state pins are resolved in the device's manager
store. A pending publisher update retains the accepted configuration and is included
in the returned resource report. Saved sessions retain captured definitions. Install
updated manager packages on the execution device before using the new target format.


Resource imports: Prompt/Skill Manager 0.1.0-beta and MCP/Agent Manager 0.1.0-beta use
`aixand-resource-sources` 0.1.0 for public GitHub source capture and retained jobs.
Create/import through the managers; launches resolve accepted local copies.
MCP installation is explicit and readiness belongs to the execution machine.
Update the manager packages and rebuild deployed Suite/Connect components to
enable the new controls. See manager-suites/docs/resource-imports.md.

[Suite](../../README.md) · [Server integration](../../apps/server/docs/connect.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
