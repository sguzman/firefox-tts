# 🦊 Firefox TTS

Firefox Developer Edition-first read-aloud WebExtension, porting the Linux **offline CPU-only Piper** capability and reading UI from [Edge Natural TTS](https://github.com/sguzman/edge-tts). This is a **development build; final real-browser user acceptance is still pending**.

The project is independent of the Edge extension and does **not** depend on Edge's online speech protocol, Windows voices, `chrome.tts`, or Chromium offscreen documents. The existing Edge installation, installed voices, pronunciation files and real Firefox profile must remain untouched.

## Status — October 27, 2026

**94% (+5 percentage points since 89%)**. The pinned source import, Gecko background code, disposable native host integration tests, and governance tasks, plus the one-time [firefox-scripts index cross-link](https://github.com/sguzman/firefox-scripts/commit/e11fac830231b6fcdfb9406ebca1cb468cfbbb5e) have been completed. **The Firefox-specific reader, background bridge and synthetic audio path have passed disposable real-Firefox tests. A real installed CPU-only Piper 1.8.0 model also passed its local synthesis self-test.** Audible Firefox playback on the user's machine and the live authenticated Writing Block are still unverified.

- [📍 Detailed weighted roadmap](docs/ROADMAP.md)
- [📊 Machine-readable progress ledger](progress.json)
- [📜 Stewardship and safety contract](AGENTS.md)

## Intended capabilities

Explicit action-to-read, CPU-only Linux Piper voice selection, speech playback with highlights and pause/resume/stop, selectable speed and sentence pauses, high-quality text extraction (including ChatGPT messages and writing blocks), safe pronunciation editing with durable backups, low idle overhead and no focus theft.

## Source provenance

Pinned source snapshot: [`sguzman/edge-tts` `a568fd554`](https://github.com/sguzman/edge-tts/tree/a568fd55478d14701eaf2b9a835b6618dd9ee95b), development/Linux Piper v1. This repository does not overwrite that source. See [the privacy, permissions and provenance audit](docs/SECURITY.md) for the source/license review.

## Installation

**Development testing only; not a final release.** See [Linux setup, temporary testing and recovery](docs/INSTALLATION.md). Keep the original Edge extension and user data untouched.
