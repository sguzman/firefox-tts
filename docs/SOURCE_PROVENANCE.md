# 📥 Pinned source import and exclusions

This file records the first **source-only** migration, without claiming Firefox compatibility.

Source: [`sguzman/edge-tts` at `a568fd55478d14701eaf2b9a835b6618dd9ee95b`](https://github.com/sguzman/edge-tts/tree/a568fd55478d14701eaf2b9a835b6618dd9ee95b), branch `development/linux-piper-v1`.

Target import: [`sguzman/firefox-tts` `b368f56089649c8414a9fa18a337b7fc3f61c84d`](https://github.com/sguzman/firefox-tts/commit/b368f56089649c8414a9fa18a337b7fc3f61c84d).

The import copied 21 source files, verifying each generated Git blob SHA against the pinned source. The resulting target tree was inspected: 21 imported files, no Windows, Edge online audio or Chromium offscreen files.

## Imported

- `src/content/`: reader orchestration, safe text model, highlighting, UI, voice selection, Piper engine, speech/reliability adapters and dynamic injection modules (15 files).
- `src/pronunciation/`: defaults and rule engine (2 files).
- `src/options/`: pronunciation page, style and controller (3 files).
- `native/linux-piper/linux_piper_host.py`: Python helper source only (1 file). **No native host has been installed or connected.** This file still contains the Edge-era default data directory pending safe Firefox adaptation.

## Deliberate exclusions

- `native/win-natural/`, `src/content/win-natural-engine.js`: Windows SAPI.
- `src/content/direct-audio-engine.js`: undocumented Edge online consumer protocol.
- `src/content/local-tts-engine.js`: Edge/Chromium extension-level `chrome.tts` path.
- `src/offscreen/`: Chromium offscreen audio mechanism.
- Edge `manifest.json`, Edge `src/background.js`, and Edge native install/uninstall scripts: browser-specific and unsafe to reuse without adaptation.
- External voice models, personal pronunciation configuration and private Piper runtime.

Source files retain internal `EDGE_TTS_*` names and references; they are **migration material**, not yet the target's production entry point. Cross-browser adaptation, tests and removal of unsupported runtime branches remain separate roadmap gates.
