# Develop Vox

Use the locked Python environment and the same deliberately chosen OS user, manager homes and runtime homes as Server. Preparation can download models and contact package/model hosts; the commands below are setup instructions, not checks performed by these docs.

## Setup contract

From the Suite root run `./dev.sh prepare`, then preserve these existing commands:

```sh
cd services/vox
uv sync --locked --python 3.12
uv run --locked aixand-vox-prepare
```

Python metadata supports 3.11–3.13; the retained README recommends 3.12. Restart development Server after environment changes and refresh Web. Do not regenerate `uv.lock` simply to start a call. Model preparation loads speech engines and prepares keyword files; there is no additional public Python port.

```mermaid
flowchart LR
  accTitle: Diagnose startup by boundary
  accDescr: Check inclusion and interpreter first, then worker import, managed profile, Suite conversation tool compatibility, and finally speech and browser media. Each stage has different evidence and does not prove later stages.
  Inclusion[Voice inclusion and interpreter] --> Import[Worker imports]
  Import --> Profile[Managed profile connection]
  Profile --> Tools[Conversation tool compatibility]
  Tools --> Audio[Speech models and WebRTC]
  Audio --> Browser[Capture and audible playback]
```

## Source reading and change map

| Change | Read first | Focused verification |
| --- | --- | --- |
| IPC/ownership | `worker.py`, gateway/service | [Worker tests](../../tests/test_worker.py), [gateway tests](../../../../apps/server/test/vox.e2e-spec.ts) |
| Streaming/cache/cleanup | `speech.py` | [Speech tests](../../tests/test_speech.py), opt-in audio regression |
| Pause/correction timing | `turns.py` | [Turn tests](../../tests/test_turns.py) |
| Wake controls/cache | `wake.py`, `wake_model.py`, `controls.py`, `prepare.py` | [Diagnostics](../../tests/test_wake_diagnostics.py), [controls](../../tests/test_controls.py), opt-in wake audio |
| Model tool/turn handling | `codex.py`, Server VoxTools, current SuiteChats | [Adapter tests](../../tests/test_codex.py) and compatibility inspection |
| Capability/media UI | Server capabilities, Web capability provider/model | [Web voice fixture](../../../../apps/web/tests/voice.spec.ts) |

Concrete sources: [worker](../../src/aixand_vox/worker.py), [speech](../../src/aixand_vox/speech.py), [turns](../../src/aixand_vox/turns.py), [wake](../../src/aixand_vox/wake.py), [model preparation](../../src/aixand_vox/wake_model.py), [controls](../../src/aixand_vox/controls.py), [prepare CLI](../../src/aixand_vox/prepare.py), [adapter](../../src/aixand_vox/codex.py), [metadata](../../pyproject.toml), [lock](../../uv.lock).

## Capability gates are not readiness probes

[Server capabilities](../../../../apps/server/src/capabilities.ts) enables voice when `AIXAND_VOICE_ENABLED=1`, or by default only in nonpackaged development when that variable is absent. `voxInstalled()` checks the interpreter path/PATH without starting Python or loading models. [Web capabilities](../../../../apps/web/src/capabilities.tsx) defaults false and requires both voice and vox true; [App](../../../../apps/web/src/App.tsx) then mounts Vox. The call button separately waits for the agent catalog connection.

| Observation | Does not establish |
| --- | --- |
| Vox visible | Import compatibility or prepared models |
| Worker ready | Selected profile, controller or tool availability |
| Greeting audible | Model turn completion |
| Fixture test passes | Real capture, target platform or paid provider readiness |

Read [status](../reference/implementation-status.md) before debugging media: this checkout can fail before it reaches audio. Use [configuration](../reference/configuration.md) for forwarded variables and [verification](verification.md) for check scope.

## Model preparation and diagnostics

Preparation downloads Whisper, Kokoro and keyword files into the Server user's model cache and loads speech engines. First preparation needs internet. Models can also load when their listener is enabled. Use deliberately selected manager/runtime homes and restart Server after environment changes.

The retained controller selects profiles after the allowance cache expires (60 seconds by default), with up to four concurrent account checks. This is a source contract, not a measured startup guarantee. Once compatibility is restored, use **Settings → Debug mode → Voice diagnostics → Copy diagnostics** for startup timings and microphone/WebRTC milestones without conversation text. Follow the [browser first-call procedure](first-call.md).
