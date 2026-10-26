# RAM per profile and loaded chat

Measured on **2026-10-13**, using **Codex CLI 0.162.1** on **Linux x86_64**.
These are observed memory readings under the conditions below, not fixed limits
or peak requirements. MiB means 1,048,576 bytes; MB means 1,000,000 bytes.

## How memory scales

Agent Manager starts one Codex app-server per active profile. Chats in that
profile share the process; creating another chat does not create another full
Codex process. Suite also shares its NestJS backend and Python chat bridge.

A loaded chat is a thread resident in the app-server, including idle threads.
Count these with `thread/loaded/list`, rather than counting saved conversations
in SQLite or the sidebar. Closing the browser does not stop the profile process
or guarantee that its loaded threads are released.

## Controlled measurements: empty chats

Three fresh, isolated app-server processes were measured at the same chat counts.
Each table range is the minimum and maximum observed across those three runs.

| Loaded empty chats in one profile | Process RAM (RSS) | Proportional RAM (PSS) |
| --- | --- | --- |
| 0 | 100.49–100.93 MiB | 32.29–32.61 MiB |
| 1 | 139.66–141.62 MiB | 42.52–44.48 MiB |
| 2 | 144.81–146.04 MiB | 47.44–48.62 MiB |
| 5 | 153.15–154.45 MiB | 55.23–56.58 MiB |
| 10 | 162.52–168.04 MiB | 64.48–70.18 MiB |

For this empty-chat workload:

- Profile startup used about **101 MiB RSS**.
- Loading the first chat added about **39–41 MiB RSS**, including initialization.
- Additional empty chats added roughly **2–5 MiB each** at the measured
  checkpoints. Going from one to five chats averaged **3.08–3.39 MiB per added
  chat**, so the four additional chats together added about **12–14 MiB**.

A rough approximation within the measured range of **1–10 empty chats** is:

```text
Profile RSS ≈ 141 MiB + (loaded chats − 1) × 3 MiB
```

Use the table for observed values. The formula is an approximation; it does not
establish linear growth beyond ten chats or describe active conversations.

## Existing profiles with conversation history

Read-only inspection of the running profiles during the same session found:

| Profile | Loaded chats | RSS | PSS | Swapped memory |
| --- | --- | --- | --- | --- |
| `aixand` | 5 | 188.17 MiB | 131.20 MiB | 16.06 MiB |
| `guides-x7kcfoxq-api-caller` | 3 | 176.57 MiB | 119.62 MiB | 31.98 MiB |

These processes had existing history, settings, and different lifetimes. Their
readings are examples of actual usage, not a controlled comparison of three
versus five chats. Do not infer the cost of an additional chat by subtracting
memory readings from different profiles.

About **200 MiB RSS per profile with five light loaded chats** is an initial
planning allowance based on these observations. It is not a peak budget or a
guarantee for longer histories or concurrent active work.

## What the readings include

RSS is the resident memory of the Codex app-server process. It includes shared
code and library pages. Summing RSS across profiles can count those pages more
than once; PSS apportions shared pages between processes and is more useful for
estimating their combined physical RAM usage. PSS also changes as other processes
start or stop. Neither RSS nor PSS includes swapped-out memory.

Budget separately for:

- The shared Suite backend, Python bridges, and Undercurrent services.
- Browser memory for cached transcripts and rendered messages.
- MCP servers, terminals, code hosts, and other child processes.
- Builds, tests, and commands launched by active chats.
- Larger histories, tool output, and transient allocations during turns.

Suite's serialized transcript snapshot target is approximately 1.5 MB; that
is a transport/storage bound, not a per-chat RAM limit or a limit on the full
provider history. The first six saved chat records inspected in this session
occupied up to 1.13 MiB each as decoded Python objects. This measured only their
metadata and transcript snapshots, not their complete runtime memory.

## Measurement method

The controlled benchmark used three temporary `CODEX_HOME` directories and a
fresh app-server for each run:

1. Start `codex app-server --listen stdio://` with the temporary home and working
   directory, then send `initialize` and `initialized`.
2. Wait one second and read the process's `/proc/<pid>/smaps_rollup`.
3. Create ten threads with `thread/start`, using the temporary working directory,
   `model: "gpt-6"`, `sandbox: "read-only"`, and `approvalPolicy: "never"`.
4. After thread counts 1, 2, 5, and 10, wait one second, verify the resident count
   with `thread/loaded/list`, and sample `smaps_rollup` again. Convert the reported
   KiB values to MiB by dividing by 1024.
5. Stop the temporary process group and remove its temporary home.

No turns were submitted, no model inference requests were made, and no real
profile credentials or configuration were copied into the temporary homes. The
benchmark excludes Suite's tool attachments, browser rendering, and active work.
Existing production profiles were inspected without starting or resuming threads.

For reproducibility, the RSS readings before rounding were:

| Run | 0 chats | 1 chat | 2 chats | 5 chats | 10 chats |
| --- | --- | --- | --- | --- | --- |
| 1 | 100.660 | 141.617 | 145.445 | 154.445 | 168.043 |
| 2 | 100.488 | 140.840 | 146.035 | 153.145 | 162.906 |
| 3 | 100.926 | 139.660 | 144.805 | 153.211 | 162.516 |

All values in this table are MiB. Repeat the measurement when changing the Codex
version, profile configuration, tool attachments, or workload. Measure active-turn
peaks and child processes separately before setting production memory limits.
