<div align="center">
  <img src="src/icons/fox-tts-128.svg" width="128" height="128" alt="Firefox TTS fox speaking with sound waves">
</div>

# 🦊 Firefox TTS

Firefox Developer Edition-first read-aloud WebExtension, porting the Linux **offline CPU-only Piper** capability and reading UI from [Edge Natural TTS](https://github.com/sguzman/edge-tts). This is a **development build; final real-browser user acceptance is still pending**.

The project is independent of the Edge extension and does **not** depend on Edge's online speech protocol, Windows voices, `chrome.tts`, or Chromium offscreen documents. The existing Edge installation, installed voices, pronunciation files and real Firefox profile must remain untouched.

## Status — October 29, 2026

**94% evidence-backed roadmap completion.** User-confirmed Firefox Developer Edition playback is now smooth at 1.8× after moving high-speed processing into local CPU-based FFmpeg (`atempo`), with Firefox playing the processed WAVs at 1×. The existing Piper 1.8.0 voice models and independent Edge extension are unchanged. Final authenticated ChatGPT Writing Block and general release acceptance checks remain open.

- [📍 Detailed weighted roadmap](docs/ROADMAP.md)
- [📊 Machine-readable progress ledger](progress.json)
- [📜 Stewardship and safety contract](AGENTS.md)

## Intended capabilities

Explicit action-to-read, CPU-only Linux Piper voice selection, speech playback with highlights and pause/resume/stop, selectable speed and sentence pauses, high-quality text extraction (including ChatGPT messages and writing blocks), safe pronunciation editing with durable backups, low idle overhead and no focus theft.

## Source provenance

Pinned source snapshot: [`sguzman/edge-tts` `a568fd554`](https://github.com/sguzman/edge-tts/tree/a568fd55478d14701eaf2b9a835b6618dd9ee95b), development/Linux Piper v1. This repository does not overwrite that source. See [the privacy, permissions and provenance audit](docs/SECURITY.md) for the source/license review.

## Installation

**Development testing only; not a final release.** See [Linux setup, temporary testing and recovery](docs/INSTALLATION.md). Keep the original Edge extension and user data untouched.
