# 🔒 Firefox TTS privacy and permission audit

This Firefox Developer Edition extension is local-first and offline-only. The
runtime runs entirely on Linux and uses a CPU-only Piper native helper, not
Edge's online voice endpoint or any third-party telemetry service.

## Browser permissions (Manifest V3)

| Permission | Why |
| --- | --- |
| `activeTab` | User explicitly clicks the toolbar button to read the active page |
| `scripting` | Inject the reader/stylesheet into only that granted tab |
| `storage` | Persist the user's local reading and pronunciation preferences |
| `nativeMessaging` | Communicate with the separate CPU-only Piper helper |

The manifest has **no host_permissions**, `content_scripts`,
`externally_connectable` or remote endpoints. The Gecko ID is fixed for the
native helper allowlist. Firefox data collection is explicitly declared
`none`. The code never sends spoken text to an external network service:
static CI rejects network and dynamic-code APIs in runtime sources.

## Sensitive surfaces and behavior

- The reader builds a local text model when the user activates it. The browser
  DOM is neither uploaded nor committed; editable controls and hidden status
  areas are excluded, and click-to-seek does not target input fields.
- Only the requested text crosses the local Native Messaging pipe to Piper.
  The helper is CPU-only. The voice models in the existing Edge voice directory
  are **read-only**, and no Edge installation or browser profile is modified.
- Pronunciation settings live under `$XDG_DATA_HOME/firefox-tts/`, with
  private 0600 writes, archived revisions and explicit migration/rollback.
- The existing pronunciation UI includes an ephemeral session-only diagnostic
  trace of synthesized text for troubleshooting. This stays in local browser
  session storage; it is **not** telemetry and is not uploaded.
- Audio playback resides in a Firefox extension event page; its audio timer
  starts only during playback and is cleaned on Stop, Quit or tab close.
- No passive content injection, blanket mutation observer, network voice
  fallback, installation-on-import, or UI-thread synthesis.
- GitHub CI uses only **synthetic** text, test model filenames and ephemeral
  home/profile directories. No private captures, credentials, user source files
  or real voice assets are shipped in the XPI.

## Licensing and provenance

The application carries its own MIT LICENSE. Imported reader, pronunciation
and native Piper sources were copied from the same owner's
`sguzman/edge-tts` at pinned commit
`a568fd55478d14701eaf2b9a835b6618dd9ee95b`.
The pinned upstream tree has no separate license/NOTICE file. No embedded
third-party code, bundled voices, Piper runtime, ONNX model, npm dependencies
or binary assets are redistributed in this repository. A future release
must preserve any independently licensed dependencies if later included.

## Evidence and limits

`tests/privacy-static.test.js`, `tests/idle-safety.test.js`,
`tests/test_host_isolation.py`, `tests/test_migrate_pronunciation.py`,
and the deterministic XPI package test enforce these properties in CI.
A real Firefox MV3 installation/no-idle-injection smoke passed.
**Real-world audible Piper playback, focus preservation during speech and
browser action activation remain release gates**, not inferred from this audit.
