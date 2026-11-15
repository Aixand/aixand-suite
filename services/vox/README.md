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

Prepare Suite dependencies first with `./dev.sh prepare` from the Suite root.
Vox has a separate speech environment. Its adapter currently uses Agent Manager
and Undercurrent; this voice path needs separate qualification from managed chat.
Use the same OS user and deliberately selected manager/runtime homes.
From the Suite root:

```sh
cd services/vox
uv sync --locked --python 3.12
uv run --locked aixand-vox-prepare
```

Restart the development Server after changing the Vox environment. Use the
locked dependency metadata; do not regenerate locks merely to start a call.

Preparation downloads Whisper, Kokoro, and the lightweight keyword model into
the server user's model cache, and loads the speech models. It needs internet on
the first run. Models also load automatically when enabling their microphone
listener; preparation avoids downloading them during that request.
Python 3.12 is recommended; the speech dependencies support Python 3.11–3.13.

Build/restart `apps/server` and start/refresh `apps/web`. Click the phone bubble,
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
[shared conversation tools](../../apps/server/docs/conversation-tools.md) for scope,
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

Memory depends on model choice, concurrent calls and browser/provider workloads.
Measure the worker and its child processes under the intended workload; cached
engines remain loaded after calls. No complete-Suite minimum RAM is qualified by
this guide. See [capacity planning](../../apps/server/docs/chat-memory.md).
