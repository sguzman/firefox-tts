# 🦊 Firefox TTS: fixed-weight delivery roadmap

Target: a Firefox Developer Edition-first, Linux-only, offline Piper read-aloud WebExtension. This is a separate maintained project, not a modification of an installed Edge extension. User retains ownership; assistant stewards code and evidence in the connected repository.

## Scope and invariant contract

- Port from pinned `sguzman/edge-tts` branch `development/linux-piper-v1` at `a568fd55478d14701eaf2b9a835b6618dd9ee95b`, not from an unspecified branch tip.
- Preserve text extraction, source-to-spoken mapping, synchronized highlighting, user pronunciation rules, UI controls and Piper CPU-only behavior. **Do not** require Microsoft online speech service, Windows SAPI, `chrome.tts` or Chromium `chrome.offscreen`.
- Firefox requires an MV3 background script/event page instead of a Chromium service worker; Firefox Native Messaging uses a Gecko ID and `allowed_extensions`. Verify against Mozilla documentation and in an isolated browser.
- No sudo, npm command, Mac, payment, telemetry, hidden periodic scanning, blanket host permissions, or work on the render/UI thread. Node built-in test runner is acceptable; use pnpm only if a package install becomes necessary.
- Never run automation in, reset, inspect or modify the user's real Firefox profile. Temporary profiles contain synthetic content. User data, tokens and actual page captures stay out of Git history.
- Do not modify the Edge repo, existing Microsoft Edge extension, Piper voice model directories or its native-host manifest. Avoid reinstallation; any migration is explicit, backed up and reversible.
- Keep the `firefox-scripts` cross-reference to **one already-completed README edit**. No additional changes to that repository for this work.
- Work on `main`. All claims require code/test evidence; do not promote untested code or infer actual browser stability from passing unit tests.

## Progress mathematics

Progress = sum of weights of work items with **verified acceptance evidence** / 100. Weights are frozen, include tests and user acceptance, and are not estimates of elapsed time. `roundDelta` = new percent minus previous reported percent. Unknown, partial, untested or blocked work remains **0 credit** for its item, even when code is checked in. Fixes within existing tasks do not introduce arbitrary new work or inflate progress. Any necessary scope change needs a recorded rationale and explicit weight migration that preserves the already-reported baseline. Ledger: [`progress.json`](../progress.json).

Initial baseline: 0% (license + ignore only). Current UI/pronunciation/docs round: **82% (+9 points since 73%)**. Disposable real Firefox validates options projection, fake native speech, toolbar controls and focus safety. Real ONNX speech, audible playback and actual ChatGPT production Writing Blocks remain unverified.

| Stage | Fixed weight |
| --- | ---: |
| Governance | 8% |
| Core port | 21% |
| Firefox integration | 31% |
| User experience | 18% |
| Verification | 17% |
| Release | 5% |
| **Total** | **100%** |

## Detailed work items

### Governance — 8%

- [x] **🧭 G01** · **2%** — Audit pinned Edge source and empty Firefox repository. Acceptance: Record source commit, relevant directories and known unverified runtime behavior.
- [x] **📜 G02** · **2%** — Codify stewardship and isolation contract. Acceptance: AGENTS.md defines source boundaries, user profile protection, no package-manager installs and acceptance requirements.
- [x] **🗺️ G03** · **3%** — Establish weighted roadmap and machine-readable ledger. Acceptance: ROADMAP.md and progress.json agree, weights total exactly 100, evidence is listed.
- [x] **🔗 G04** · **1%** — Link once from firefox-scripts. Acceptance: One README link exists and is committed; no further work in firefox-scripts.

### Core port — 21%

- [x] **📥 S01** · **6%** — Import curated reader and pronunciation source. Acceptance: Copied files trace to pinned Edge commit; exclude unused Windows assets and generated binaries.
- [x] **📖 S02** · **5%** — Preserve DOM text model, highlighter and selection mappings. Acceptance: Unit tests cover multi-block reading, editable exclusion, CSS Highlight mapping, seek.
- [x] **🧹 S03** · **3%** — Remove Edge online and Windows-only playback dependencies. Acceptance: No active references to Direct Read Aloud, chrome.tts, WIN-NATURAL or Windows host.
- [x] **🧩 S04** · **4%** — Port action-triggered on-demand script and CSS injection. Acceptance: One action click installs a singleton reader, retry and stop are deterministic.
- [x] **🛡️ S05** · **3%** — Enforce low idle cost and no focus theft. Acceptance: No automatic page injection, broad observer, composer write or unbounded DOM scan.

### Firefox integration — 31%

- [x] **🦊 F01** · **5%** — Create Firefox MV3 manifest and fixed Gecko ID. Acceptance: Manifest loads without schema errors in isolated Firefox and declares only justified permissions.
- [x] **🧠 F02** · **6%** — Move orchestration to Firefox background event page. Acceptance: Messaging, active tab, native port, tab-close cleanup and suspension/restart tested.
- [x] **🔌 F03** · **6%** — Implement dedicated Firefox Native Messaging manifest and installer. Acceptance: Gecko allowed_extensions, correct per-user path and isolated installation; never modify Edge host.
- [ ] **🐍 F04** · **5%** — Reuse Piper safely as CPU-only native backend. Acceptance: Native hello, enumerate, synthesize and cancel pass; existing voices and files untouched.
- [ ] **🔊 F05** · **7%** — Replace Chromium offscreen audio playback and timing. Acceptance: Firefox-compatible extension-owned media, word events, pause/resume and autoplay recovery tested.
- [x] **⏯️ F06** · **2%** — Restore cross-tab ownership and cancellation. Acceptance: No stale audio continues on stop, tab switch, extension reload or rapid restart.

### User experience — 18%

- [x] **🎙️ U01** · **3%** — Port Piper catalog, default and preferences. Acceptance: Voice discovery works; Amy Low default with optional Ryan and other installed voices.
- [x] **🗣️ U02** · **4%** — Port pronunciation projection and live testing. Acceptance: Rules, previews, import/export, source mapping and sentence boundaries tested.
- [x] **💾 U03** · **4%** — Preserve user pronunciation rules and backups. Acceptance: Explicit migration/read-only source handling; restore, revision history and failure cases tested.
- [x] **🎚️ U04** · **3%** — Port toolbar, batching and speech controls. Acceptance: Volume, pitch-preserving speed, sentence pause, seek, highlighting and controls verified.
- [ ] **📝 U05** · **4%** — Handle ChatGPT messages and writing blocks safely. Acceptance: Synthetic and live writing-block extraction verified, without reading composer or stealing focus.

### Verification — 17%

- [x] **🧪 T01** · **3%** — Implement static and unit checks without npm. Acceptance: Node builtin test and syntax checks green from clean checkout.
- [x] **📡 T02** · **3%** — Test native messaging protocol and failure boundaries. Acceptance: Synthetic framing, malformed frames, disconnects, cancellation and timeouts pass.
- [x] **🎼 T03** · **4%** — Stress playback timing and lifecycle. Acceptance: Long text, rapid play/pause, no leaks, suspended contexts and reload failures exercised.
- [x] **🧫 T04** · **4%** — Automate disposable Firefox end-to-end tests. Acceptance: Headless isolated Firefox tests for injection, reader, settings and native mock; no real profile access.
- [x] **🔒 T05** · **3%** — Audit privacy, permissions, resource usage and license. Acceptance: No telemetry; minimum permissions; no private QA data committed; third-party notices correct.

### Release — 5%

- [x] **📘 R01** · **2%** — Write installation, migration and recovery instructions. Acceptance: Linux-only instructions tested on disposable data directories and no sudo requirement.
- [x] **📦 R02** · **1%** — Produce reproducible unsigned/signed-ready extension packaging. Acceptance: Deterministic XPI artifact and content hashes documented; no paid service.
- [ ] **✅ R03** · **2%** — Real Firefox Developer Edition user acceptance. Acceptance: Exact candidate loaded in real browser and user confirms speech, quit, settings and no focus theft.

## Work order and dependencies

1. Import only needed modules with source attribution and tests; remove inactive Windows and Edge-online engines rather than masking unsupported calls.
2. Wire Firefox manifest, background event page, dynamic injection and native helper separately. Protect tab lifecycle and page editing boundaries.
3. Rebuild Piper media ownership on a Firefox-supported extension document/media surface. A passing native self-test is not playback validation.
4. Restore voice preferences, pronunciation, backups, settings and text extraction. Treat ChatGPT Writing Block support as **unverified** until exercised.
5. Run unit, native/mock and disposable Firefox E2E tests; only then ask for an actual Firefox Developer Edition smoke test. Never silently disturb an installed profile.
6. Document safe installation/migration, complete license/permission audit, package and obtain exact-candidate browser acceptance.

## Reference architecture

```text
User extension-action click (activeTab)
    -> Firefox background script / MV3 event page
    -> scripting.executeScript into current tab (no idle content scripts)
    -> source text model + pronunciation projection
    -> Gecko Native Messaging (separate allowed_extensions entry)
    -> persistent CPU-only Piper Python helper (private runtime, existing model assets)
    -> extension-owned Firefox audio playback + media-clock word events
    -> tab reader state / CSS Custom Highlights / movable toolbar
```

The exact audio implementation remains an acceptance-driven engineering task, **not** a presumed solved port. Avoid perpetual polling; adapt message contracts, audio frame limits, native connection lifetimes, cancellation and user-gesture autoplay restrictions to Firefox.

## Promotion gate

R03 requires the user to validate a specific commit after repeatable automated evidence. Minimum manual checks: first start, voice selection, read several sentences and paragraphs, correct highlighting, pause/resume, stop/quit, change speed/volume, pronunciation test, writing blocks, no focus theft while typing or pasting, and no leaked playback after closing a tab. A known missing behavior stays open; no declaration of 100% until all weighted items meet their gates.
