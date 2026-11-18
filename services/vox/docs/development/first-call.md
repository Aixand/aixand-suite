# Qualify a browser call

Use this procedure only after resolving the [controller and SDK gaps](../reference/implementation-status.md). It preserves the source UI walkthrough for a future qualification; the current checkout does not establish a working call. Prepare the [locked environment](README.md#setup-contract) first. Voice is excluded from published alpha.3 downloads.

## Open the call interface

| Interaction | Effect |
| --- | --- |
| Open the floating phone button | Shows conversation and microphone, speaker and end-call controls |
| Drag with mouse or touch | Snaps to nearest edge; position is remembered |
| Focus bubble, then Left/Right, Up/Down or Home | Dock, adjust position or restore bottom right |
| Connected call | Phone becomes call head; panel minimizes; previews follow the bubble |
| Preview bubbles | Blue user text and teal replies; latest exchange only; dismiss after twelve idle seconds |
| Change pages or minimize | Keeps the call active; [call lifecycle](../lifecycles/calls.md) distinguishes panel and session lifetime |


Build/restart `apps/server` and start/refresh `apps/web`. Click the phone bubble, then **Start call**. The expected local greeting is “Hi, I'm Vox, your virtual assistant. How can I help?” It uses local TTS once per call without an LLM turn. Microphone access requires HTTPS or localhost. Typed input is available in the panel.

## Verify a first call

After preparation and Server/frontend restart, open Vox and start a call. Confirm
microphone permission, the local greeting, visible transcription, and an agent
reply. Ask a read-only question before requesting file changes. A greeting alone
checks TTS and connection setup; it does not establish provider access.

If the call fails, check interpreter/import compatibility and provider sign-in.
Worker stderr is not guaranteed to appear in Server logs. Use
**Settings → Debug mode → Voice diagnostics → Copy diagnostics** for browser evidence.
End the call when finished. If auto-call is enabled, choose **Vox, go offline**
or disable it to release the wake listener too. Prepared model caches remain.

Clear spoken microphone checks should receive a natural acknowledgment; garbled transcriptions should prompt repetition. This infers clarity from text and does not measure microphone volume or quality.

See [verification](verification.md) for fixture tests and the evidence needed for a real call.
