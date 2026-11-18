# Aixand Vox

Source voice interaction for Aixand Suite, using local transcription and speech synthesis with a managed agent controller.

## When to use Vox

Use Vox source to develop speech interaction with a Suite workspace. Local speech processing does not imply a local agent model. Published alpha.3 downloads exclude Vox and voice runtimes; controller and legacy tool integration currently have compatibility gaps.

[Read the guide](docs/reference/implementation-status.md).

## Run locally

Use the locked speech environment and selected Server user/homes. Setup commands and model preparation are maintained in the development guide.

[Read the guide](docs/development/README.md#setup-contract).

## Verify a first call

Resolve the integration gaps before following the browser UI and microphone/provider qualification procedure.

[Read the guide](docs/development/first-call.md).

## Interruptions and pauses

Read the turn lifecycle for pause coalescing, cancellation barriers and accepted background work. Configure `VOX_SPEECH_PAUSE_SECONDS` through the configuration reference.

[Read the guide](docs/lifecycles/turns.md).

## Hands-free calling

Read the wake lifecycle for Auto-call, exact spoken controls and microphone release. Keep the browser tab open and awake.

[Read the guide](docs/lifecycles/wake.md).

## RAM and VRAM usage

Shared speech engines remain cached after calls. Measure worker and child processes under the intended workload; no whole-Suite RAM minimum is qualified here. Prior README memory figures lacked reproducible environment and run provenance and have been removed. See also [capacity planning](../../apps/server/docs/development/capacity.md).

[Read the guide](docs/architecture/audio.md).

## Component architecture

Read the ownership, lifecycle, integration and verification guides.

[Read the guide](docs/README.md).

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
