# Aixand Vox

Vox is the global voice assistant in Aixand Suite. It uses Pipecat for audio,
local Faster Whisper for transcription, local Kokoro for speech, and a custom
Codex adapter using Agent Manager's existing profiles and Undercurrent runtime.
Open Vox from the floating phone button at the bottom right; its conversation
stays active when changing pages. Drag the bubble with a mouse or touch to place
it anywhere; releasing snaps it to the nearest screen edge. Its position is
remembered, and the panel and message previews follow it. With the bubble focused,
Left/Right dock to a side, Up/Down adjust its position, and Home restores bottom right.
The round phone button becomes the call head while the microphone is connected.
The panel minimizes automatically; blue bubbles show your words and teal bubbles
show Vox's streamed replies. Only the latest utterance and one Vox reply appear;
speaking again replaces the old exchange. The call panel uses the same two-message
limit while the LLM retains previous turns for context. Previews dismiss after
twelve seconds of inactivity. Click the phone button for the conversation in the
middle and microphone, speaker, and centered end-call controls below it.

## Run locally

Use the existing sibling `manager-suites/agent-manager`, `manager-suites/server-manager`, and
`undercurrent` checkouts and a running Undercurrent daemon. The Suite backend and
Vox must run as the same OS user with the same Agent Manager and Undercurrent
configuration.

```sh
cd aixand-vox
uv sync --locked --python 3.12
uv run --locked aixand-vox-prepare
```

After updating the editable manager checkouts, run `uv lock` and then
`uv sync --locked --python 3.12` here to refresh their dependency metadata.
Restart `aixand-server` afterward. An older environment can report
`Install agent-manager[sdk] to connect to app-server` when it lacks the
`aixand-server-manager[native-codex]` dependency required by the updated SDK.

Preparation downloads Whisper, Kokoro, and the lightweight keyword model into
the server user's model cache, and loads the speech models. It needs internet on
the first run. Models also load automatically when enabling their microphone
listener; preparation avoids downloading them during that request.
Python 3.12 is recommended; the speech dependencies support Python 3.11–3.13.

Build/restart `aixand-server` and start/refresh `aixand-web`. Click the phone bubble,
then **Start call**. Vox connects the microphone and greets you: “Hi, I'm Vox, your
virtual assistant. How can I help?” The greeting uses local TTS once per call and
does not start an LLM turn. Microphone access requires HTTPS or localhost. Typed
messages remain available in the call panel. There is no additional public Python port:
Nest starts the private Python worker when a browser opens Vox.

Automatic profile selection refreshes account allowances after Agent Manager's
cache expires (60 seconds by default). Independent accounts are checked
concurrently, with up to four checks at once, so their network waits do not add
up on call startup. For a slow call, enable **Settings → Debug mode** and use
**Voice diagnostics → Copy diagnostics** in the Vox panel. The report includes
startup stage timings and microphone/WebRTC milestones without conversation text.

Vox can discover projects under an explicitly supplied local directory and add
them to the existing Suite project registry. Say “Discover all my projects under
`~/projects` and add them.” Discovery alone previews candidates; explicit addition
registers recommended roots without a second confirmation. Nested packages are
optional. The existing `aixand_vox` native tools start a saved backend job, inspect
results, import selected candidate IDs, or cancel scanning. Completion is announced
once when the call is idle, and detailed results remain in **Discover projects**
after the call ends. Interrupted controller turns discard new tool requests;
already accepted discovery jobs continue independently.

Vox can also find saved Suite chats, read their messages and parent/child threads,
and send an explicit follow-up into an existing conversation. Normal Codex chats
have the same tools. Say “Find the recent Undercurrent audit chat,” then “Send the
parent chat a request to turn the findings into an implementation plan.” Vox shows
clickable conversation links in both its panel and minimized call updates. Busy
destinations queue messages; delivery receipts distinguish acceptance from the
destination's completed reply. See the server's
[shared conversation tools](../aixand-server/docs/conversation-tools.md) for scope,
thread relationships, delivery recovery, and MCP/native transports.

To register an existing directory directly, say “Add `/absolute/path/to/notes` as
a project named Research notes.” `add_project(name, path)` uses the same registry
as manual Web registration and accepts `~/…` paths. It works without Git or build
manifests and leaves the directory untouched. Repeating the same name/path reuses
the saved project. Explicit `.aixand/project.json` markers also identify roots in
discovery; Suite's marker groups all five components beneath `aixand-suite`.

Say “Remove Research notes from my projects” to use `remove_project(projectId)`.
Vox resolves the exact saved project by name or path with `list_projects`; ambiguous
matches require clarification. Removal unregisters only that ID, preserving its
files, existing chats, aliases, and child registrations. Saved discovery results
refresh their live registration status, and repeat requests safely reuse the outcome.

Follow up with “Only show project roots, not all their crates” to use
`filter_project_discovery` on the same saved job/card. Roots, name/path queries,
and specific candidate IDs can narrow its results without rescanning or changing
registered projects. Filters combine and replace the previous view; scope `all`
with no query/IDs restores all results. `get_project_discovery` pages the filtered
view. If asked to add only those shown, `add_discovered_projects` uses selection
`filtered`; its default recommended selection still refers to the full scan.

The LLM receives live-call context, including whether a message is a Whisper
transcription or typed input. Clear spoken microphone checks get a natural
acknowledgement; garbled words prompt a request to repeat. Audio clarity is inferred
from the transcription, without claiming to measure volume or microphone quality.

## Interruptions and pauses

Speaking while Vox replies stops its playback and interrupts the current Codex
turn. The call and controller thread stay open. Late text/speech and new tool
requests from that interrupted turn are discarded; investigations already
launched keep running until explicitly stopped.

Whisper segments are collected into one spoken instruction. Brief pauses and
corrections update the same user bubble without sending another LLM request.
After roughly one second of silence, with allowance for VAD start confirmation,
Vox waits for every segment's final transcription and the previous native turn's
terminal completion, then sends the complete instruction once. New speech
replaces an older voice instruction still waiting to be sent. Failed transcription
segments discard the incomplete draft instead of dispatching a partial instruction.

The call panel shows **Listening…** while collecting the draft. Increase
`VOX_SPEECH_PAUSE_SECONDS` if you prefer longer thinking pauses (accepted range:
0.5–5 seconds). Longer pauses start a new conversational turn in the same thread.
If cancellation lacks terminal confirmation within ten seconds, Vox reports it
and refuses another turn; end and restart the call before continuing. Background
investigations remain available for inspection.

## Hands-free calling

Open the phone bubble and enable **Auto-call · Hey Vox**. This is off by default
and needs microphone permission. Keep the Suite browser tab open and awake.

| Say | Result |
| --- | --- |
| “Hey Vox” | Start a call using the selected profile and play the greeting |
| “Vox, mute” | Mute your call microphone |
| “Vox, unmute” | Restore your call microphone |
| “Vox, end” | End the call and return to wake listening |
| “Vox, go offline” | End the call and stop all microphone listening |

While auto-call is enabled, a separate microphone listener remains available for
wake and control phrases, including when your call microphone is muted. Its
amber indicator shows this access. Muting prevents ordinary speech from reaching
Whisper and the LLM; it keeps the small keyword listener available for “Vox,
unmute” or “Vox, end.” Turning auto-call off releases that listener, while an
active call can continue. Going offline, leaving the page, or losing the Suite
connection releases both listeners. Auto-call is not restored after a reload.

Idle auto-call sends audio over WebRTC to a local
[Sherpa ONNX English keyword spotter](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html#sherpa-onnx-kws-zipformer-gigaspeech-3-3m-2024-01-01-english)
in the Suite backend. It uses roughly 6 MB of model files and does not start Whisper,
Kokoro, a Codex conversation, or LLM turns. Whisper runs during an active call.
The browser still needs microphone access for wake detection; a closed tab or a
browser suspended by the operating system cannot receive the wake phrase.

Exact spoken controls bypass the LLM, including without auto-call during an
unmuted call. Other ways of asking to mute or end a call can use Vox's
`control_call` tool. The speaker button still silences Vox's voice separately.

## RAM and VRAM usage

**Measured Vox peak: ~882 MiB RAM across ten browser calls**, after reusing the
speech engines and cleaning up each call. The earlier browser test reached
**~2.4 GiB after four calls**. A call cycle means starting and ending a call;
conversation turns within a call do not count as separate cycles.

Vox lazily loads one Whisper engine and one Kokoro engine in its private Python
worker and reuses them across calls. Each call gets fresh Pipecat processors,
settings, VAD state, resamplers, audio queues, and WebRTC connections. Loading is
serialized, as is native inference within each shared engine. Ending a call
waits for its pipeline cleanup, clears pending playback and call references, and collects
processor reference cycles. Overlapping cleanup requests share the same task;
canceling a caller does not cancel that cleanup.

With the defaults, Whisper uses `base` on CPU with `int8` compute. Kokoro uses
CPU ONNX in the measured installation, and the wake detector explicitly uses CPU.
These models used **0 dedicated VRAM**. Changing Whisper's device or installing
an accelerated ONNX runtime can change GPU usage; browser GPU allocations are
separate.

Local Linux measurements on **2026-10-13**, with Python 3.12 and Pipecat 1.12.0:

| Workload | Measured worker RAM |
| --- | --- |
| Python worker has not started | 0 additional worker RAM |
| Fresh worker, no call or wake listener | ~22 MiB RSS |
| “Hey Vox” enabled before any call | ~148 MiB RSS |
| Six sequential real local WebRTC calls, after call two | ~801 MiB RSS |
| Same six-call test, after call six | ~804 MiB RSS |
| Ten-call browser test with local transcription and speech | ~882 MiB peak RSS (~872 MiB PSS) |

RSS is the resident memory of a process; summing it across processes can count
shared pages more than once. PSS apportions shared pages between processes and
is more useful for estimating the combined physical RAM usage. MiB and GiB are
binary units (1 MiB = 1,048,576 bytes; 1 GiB = 1,024 MiB).

The repeated-call regression uses real local models, silent incoming audio, and
an audible greeting on every call, without a browser or Codex turn. Calls three
through six remained around **804 MiB**. Before engine reuse and explicit cleanup,
an equivalent four-call diagnostic grew from **726 MiB to 2,174 MiB RSS**. Native
allocators may still retain their peak workspace; model reuse avoids allocating
another complete speech engine on every call.

The browser test exercises spoken and typed messages, investigations, audio
controls, and nine additional start/end cycles. At the peak of that run:

| Component | RAM at the combined peak (PSS) |
| --- | --- |
| Vox Python speech worker | ~863 MiB |
| One Chromium tab and its browser processes | ~303 MiB |
| Nest backend | ~80 MiB |
| Undercurrent runtime processes | ~73 MiB |
| Static Vite preview server used by the test | ~65 MiB |
| Agent Manager supervisor processes | ~52 MiB |
| Carrier bridge | ~42 MiB |
| Offline agent-protocol fixture | ~32 MiB |
| Chat bridge | ~20 MiB |
| **Combined measured runtime** | **~1,529 MiB (~1.49 GiB)** |

These are simultaneous readings at the combined peak; each component's
individual peak can occur at a different time. The test used local speech models,
an offline agent-protocol fixture, and a static Vite preview. It excludes the OS,
build/test tooling, and real agent-provider processes. Runner workflows, project
scans, additional active agent chats, and development watchers were not part of
this memory test.

**4 GB remains the full Suite target, not a verified minimum requirement.** The
target workload is one Vox call and several agent chats, with the OS and one
browser tab on the same machine. Validate that complete workload on a 4 GB host
before treating these measurements as system requirements. See
[RAM per profile and loaded chat](../aixand-server/docs/chat-memory.md) for the
separate Codex measurements; they are not included in the fixture's footprint.

Longer speech workloads, dependency versions, and concurrent calls can change
memory usage. Engine reuse avoids repeated model loading; it does not impose a
hard memory limit.

RAM consumption continues after a call ends:

- Opening the Vox panel starts the lightweight Python worker.
- Enabling **Auto-call · Hey Vox** loads its small keyword listener without loading
  Whisper or Kokoro on its own.
- Starting a microphone call loads the speech engines. Silence, microphone mute,
  and speaker mute keep them loaded.
- Ending the call releases its pipeline and controller. An enabled wake listener
  continues until disabled or told to go offline.
- Speech engines stay warm in the worker for subsequent calls. Disabling all
  listeners or closing the browser does not unload those cached engines.

Backend shutdown terminates the worker and reclaims its process memory. There is
currently no automatic idle-worker shutdown or separate speech-model unloading.

Run the real-audio memory regression after preparing the local models:

```sh
cd aixand-vox
VOX_TEST_SPEECH_AUDIO=1 uv run --locked python -m unittest discover -s tests -p 'test_speech_audio.py' -v
```

On Linux it checks that RSS growth after warmup stays below 128 MiB over six calls,
as well as verifying audible output, engine reuse, and session cleanup. This is
an opt-in regression threshold, not a promised deployment memory budget.

## Wake diagnostics

Open the top-right **Profile menu → Settings** and enable **Debug mode**. This
browser preference is off by default, persists across reloads, and updates other
Suite tabs. It can change during a call without disconnecting the call or wake
listener. With debug mode off, Vox does not record diagnostic events, print debug
logs, query WebRTC statistics, or collect/send backend audio measurements.
Disabling it cancels the monitors, clears the in-memory report and any report
shown in the panel, and removes the console export API.

With debug mode enabled, open browser developer tools → Console and filter for
**`[Vox]`**. Logs include microphone permission/capture, track state, WebRTC/ICE
connection changes, model loading, backend pipeline startup, detected keywords,
and call startup or playback errors. Every five seconds the browser reports
outgoing audio statistics and the backend reports received frame counts, input
RMS/peak levels, and detector processing time. These are aggregate measurements;
the report does not include audio recordings, transcripts, SDP, credentials, or
microphone device identifiers.

In the Vox panel, expand **Voice diagnostics** and click **Copy diagnostics**.
This section appears only while debug mode is enabled.
If clipboard access fails, a selectable report appears instead. You can also
export recent events and current state from the console:

```js
window.aixandVoxDiagnostics.export()
```

The rolling buffer holds at most **200 events and 128 KiB**, with **4 KiB per
event**. Details are copied with limits on strings, fields, nesting, and arrays;
cycles are handled safely. Copied reports are valid JSON capped at **256 KiB**.
Console output stops after **200 messages per page visit**, including across
debug toggles; the rolling report continues to retain the latest events. Reports
are not written to local storage. Only the debug preference is saved there.

Typical stages are `wake-server-model-ready`, `wake-ready`,
`wake-server-first-audio`, `wake-server-audio`, `wake-keyword-detected`, and
`wake-auto-call-triggered`. If backend `framesReceived` stays at zero, audio is
not reaching the pipeline. If frames arrive but `inputRms`/`inputPeak` stay near
zero while speaking, check microphone capture. If levels rise but no keyword
event appears, the detector is receiving sound but has not recognized the phrase.
A keyword followed by `call-start-failed` points to the managed profile/runtime.
`wake-server-keyword-ignored` with `call-already-active` means a call already exists.
Reports are kept only in memory until refresh and are shared only when copied.

The English wake model reports `configurationVersion: vox-wake-english-v2` in
`wake-server-model-ready`, with threshold `0.25` and one trailing blank. It accepts
“Hey Vox” followed directly by a request. This replaces the original phone-based
model after reproducible missed wake phrases across voices. Models use separate
cache subdirectories so an older worker's token files are not overwritten.
Run preparation again and restart the backend to load the updated detector.

## MVP capabilities

- Find saved Suite projects.
- Inspect Codex profiles and remaining weekly allowance.
- Start a separate read-only project investigation on the selected profile.
- List investigations, inspect progress/results, and request cancellation.
- Receive task cards and completion announcements while continuing the conversation.

Auto selection uses Agent Manager's normal choice of the profile with the most
weekly allowance remaining. A chosen profile and its saved login stay pinned for
the conversation and are shown in the panel. A changed login requires a new Vox
conversation. Local STT/TTS need no API key; Codex replies and investigations use
the chosen account's ordinary Codex allowance.

Disconnecting call audio stops its capture and playback; an enabled auto-call
listener keeps running until disabled or told to go offline. Interrupting a reply only
interrupts the controller's reply. Ending Vox or closing the browser ends that
controller; delegated investigations keep running and remain available in Chat.
Ask Vox to stop a particular investigation to cancel that work. A new Vox
conversation can list and inspect previously launched investigations.

This first tool surface covers projects, profiles, and investigations. Terminal,
workflow, prompt, and Carrier operations can be added to the same adapter/tool
dispatcher. They are not exposed by this MVP.

## Configuration

Set these in `aixand-server/.env`; unset values use the defaults below.

| Variable | Default / purpose |
| --- | --- |
| `VOX_PYTHON` | `../aixand-vox/.venv/bin/python` |
| `VOX_STATE_DIR` | `~/.local/state/aixand/vox`, private controller workspaces |
| `VOX_MODEL` | Selected profile's configured model |
| `VOX_WHISPER_MODEL` | `base`, multilingual |
| `VOX_WHISPER_DEVICE` | `cpu` |
| `VOX_WHISPER_COMPUTE` | `int8` |
| `VOX_TTS_VOICE` | `af_heart`, English Kokoro voice |
| `VOX_SPEECH_PAUSE_SECONDS` | `1.0`, spoken instruction pause window; 0.5–5 seconds |
| `VOX_WAKE_MODEL_DIR` | `~/.cache/aixand/vox/wake`, cache root for pinned keyword models; each model has its own subdirectory |
| `VOX_ICE_SERVERS` | Empty; optional comma-separated STUN URLs for the server peer |
| `HF_HOME` | Hugging Face's default model cache |
| `HF_HUB_OFFLINE` | Optional `1` after models have been cached |

Vox inherits `AGENT_MANAGER_HOME`, `AGENT_MANAGER_CONFIG`, `UNDERCURRENT_HOME`,
`UNDERCURRENT_PYTHON_BRIDGE`, and the Suite's SDK source paths. Credentials stay
on the server. Signaling uses the authenticated `/api/vox/ws` endpoint; audio
uses WebRTC. Direct connectivity is suitable for localhost, LAN, or a reachable
server; deployments behind restrictive NAT still need TURN support.

The current conversation is kept for the open browser connection. Reloading
starts a fresh Vox conversation. Investigation receipts are persisted in the
existing Suite chat database. Unconfirmed launches are retained for inspection
and are never automatically resubmitted. Raw microphone audio is not persisted.

## Architecture

```text
Browser microphone ↔ WebRTC ↔ Pipecat: VAD → Whisper → CodexSpeechBridge → Kokoro
                                     ↕
                              Agent Manager Codex SDK
                                     ↕
                              Undercurrent app-server

Codex aixand_vox tool call → private Python/Node RPC → existing Suite agent worker
                                                  → projects/profiles/chat lifecycle

Optional auto-call microphone → WebRTC → Sherpa ONNX keywords → wake/call controls
```

Tool definitions live in `src/aixand_vox/codex.py`; validation and existing Suite
operations live in `../aixand-server/agent-bridge/vox_tools.py`. Browser messages
cannot submit native tool calls or choose arbitrary working directories.

## Verification

```sh
cd aixand-vox
uv run --locked python -m unittest discover -s tests
VOX_TEST_WAKE_AUDIO=1 uv run --locked python -m unittest discover -s tests -p 'test_wake_audio.py'
cd ../aixand-web
npm run test:settings
npm run test:vox
npm run test:vox:wake
npm run test:vox:interrupt
```

The browser check uses real Whisper, Kokoro, WebRTC, SDKs, and an isolated
Undercurrent daemon with an offline Codex provider. It exercises voice input,
audible returned audio, profile selection, Suite tools, task cancellation,
navigation, microphone stop, durable tasks, and mobile accessibility. It needs
the local Undercurrent debug binaries and installed Playwright Chromium.
The wake check uses the real keyword model and synthesized microphone audio to
verify wake, microphone mute/unmute, ending and waking again, complete offline
capture release, and zero idle/control LLM turns.
The interruption check plays a long streamed reply and real microphone audio
containing a paused correction. It verifies one complete new controller turn,
late output suppression, delayed terminal cancellation, and one user draft bubble.
The opt-in acoustic check covers six English voices, continuous wake phrases,
call controls, quiet speech with background noise, and similar-word negatives.
