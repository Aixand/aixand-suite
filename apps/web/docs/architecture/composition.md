# Application composition

App composes authentication, startup, capability checks, recovery and hash-routed workspace pages. Lazy feature entry points keep heavy editors outside the initial route.

```mermaid
flowchart LR
  accTitle: Application composition
  accDescr: App composes authentication, startup, capability checks, recovery and hash-routed workspace pages. Lazy feature entry points keep heavy editors outside the initial route.
  Boot[main.tsx] --> App[App providers]
  App --> Gate[Authentication and onboarding]
  Gate --> Routes[Hash routes]
  Routes --> Pages[Feature pages]
```

## State and boundaries

| Concern | Contract |
| --- | --- |
| Routing | Read and canonicalize routes in App; retained legacy URLs can map to current chat routes. |
| Startup | Crash capture is installed before React mounts. Recovery boundaries keep failures actionable. |
| Navigation | Use the resource navigation guard when leaving an editor; route changes must respect active drafts. |

## Source and verification

[src/main.tsx](../../src/main.tsx), [src/App.tsx](../../src/App.tsx), [src/resources/editor/drafts.tsx](../../src/resources/editor/drafts.tsx).

Relevant checks: [app.spec.ts](../../tests/app.spec.ts), [chat-navigation.spec.ts](../../tests/chat-navigation.spec.ts). Fixture tests verify presentation and interaction; they do not establish live service availability.
