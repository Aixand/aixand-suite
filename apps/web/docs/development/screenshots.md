# Screenshot evidence

Screenshots show the real Web interface with simulated data. They illustrate structure and interaction states without asserting backend or provider readiness.

## State and boundaries

| Concern | Contract |
| --- | --- |
| Capture | scripts/docs/capture-workspace.mjs intercepts API requests and WebSockets; no model requests or shell commands are executed. |
| Inputs | Deterministic Studio project, conversation, approval, resource, terminal and workflow fixtures. |
| Viewport | 1440 × 1000, light theme, reduced motion. |
| Provenance | The capture manifest records screenshot names and hashes of selected source inputs. |
| Refresh | Start the loopback Vite fixture server on 127.0.0.1:5347, run the capture script, then copy the documented selection with its manifest into this component assets directory. |

## Reproduce

From the Suite root:

```sh
npm --prefix apps/web run dev -- --host 127.0.0.1 --port 5347 --strictPort
```

In a second shell:

```sh
node scripts/docs/capture-workspace.mjs
```

Copy the documented selection and its provenance from the Suite root:

```sh
mkdir -p apps/web/docs/assets/screenshots
cp docs/assets/screenshots/workspace/{approval,permissions,resources,terminal,workflow,project-files,conversation,new-conversation}.png apps/web/docs/assets/screenshots/
cp docs/assets/screenshots/workspace/capture.json apps/web/docs/assets/screenshots/
```

Capture source: [workspace fixture](../../../../scripts/docs/capture-workspace.mjs). Selected assets retain their original names; [capture manifest](../assets/screenshots/capture.json) describes the fixture run. Do not substitute account data or screenshots containing credentials.

## Source and verification

[package.json](../../package.json).

