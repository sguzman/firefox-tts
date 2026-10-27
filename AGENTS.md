# Firefox TTS stewardship contract

This repository is an independent Firefox Developer Edition / Linux / CPU-only Piper port of `sguzman/edge-tts`. GitHub ownership remains with the repository owner; ChatGPT performs delegated development stewardship via authorized tools.

## Operational rules

- Work directly on `main`, use small auditable commits, inspect existing code before editing, and do not create redundant side projects. No artificial busywork.
- Source baseline is `sguzman/edge-tts@a568fd55478d14701eaf2b9a835b6618dd9ee95b` (`development/linux-piper-v1`). Preserve attribution; do not silently replace baseline on new upstream commits.
- Existing Edge extension, original repo, Linux Piper runtime, user ONNX voice assets, personal Firefox profile and stored pronunciation configuration must remain untouched. Do not run browser automation in an everyday profile; only fresh synthetic disposable profiles.
- No automatic page injection or persistent DOM observers; explicit action only. No composer mutation or focus stealing, no massive scans or main-thread synthesis.
- Firefox platform: MV3 background scripts (not a service worker), `browser_specific_settings.gecko.id`, Gecko native host `allowed_extensions`, browser-supported audio owner (not `chrome.offscreen`). Strict host/permission minimization.
- Linux only; no Windows SAPI, Azure/Edge direct consumer service, Mac dependency, npm commands, telemetry, analytics, paid APIs, or network voices. No `sudo` installs; Piper must be CPU-only; reuse user-installed voice models read-only.
- Avoid automatic package management; use Node built-in tests and optional pnpm only where actually justified. Run checks before claiming functionality.
- Preserve user-owned pronunciation backups. Cross-browser migration must never overwrite or relocate the Edge source; explicit opt-in and reversible steps only.
- No GitHub commit may include user browser history, private conversation content, credentials, extension IDs from personal installs, medical/financial data, profile dumps or secret logs.
- Follow `docs/ROADMAP.md` and `progress.json` as the source of truth. Weight = verified completed acceptance criteria, not effort estimates. Record evidence links; show exact overall percent and delta each work round.
- Do not modify `sguzman/firefox-scripts` again: one-time index cross-link was committed as `e11fac8`.
- Ask for real Firefox smoke testing only after isolated automation is ready; never claim the latest commit works in a real browser without evidence and user's confirmation.
