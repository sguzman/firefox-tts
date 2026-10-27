# 🦊 Firefox TTS — Linux installation and recovery

**Status: development candidate, 94% verified as of October 27, 2026; not a finished release.** Real Firefox injection, synthetic CPU Piper Native Messaging, and controls have been tested in disposable profiles. The user's actual installed CPU-only Piper 1.8.0 model also passed a read-only local synthesis test (`en_US-amy-low`, 16 kHz, 93,184 PCM bytes). **Audible playback in the user's Firefox Developer Edition, the authenticated ChatGPT Writing Block, and final acceptance remain open.** The steps below are for explicit, opt-in local acceptance testing; no automatic install or migration occurs.

## Requirements

Firefox Developer Edition on Linux, an existing CPU-only Piper Python environment, and already-installed ONNX voice files with corresponding .onnx.json metadata. No Mac, Windows, sudo, npm, subscription, cloud TTS or model download is required.

If no local checkout already exists, clone the repository:

~~~bash
git clone https://github.com/sguzman/firefox-tts.git ~/Code/Source/Extensions/firefox-tts
cd ~/Code/Source/Extensions/firefox-tts
git rev-parse HEAD
~~~

The immutable development tasks and evidence are listed in [ROADMAP.md](ROADMAP.md) and [progress.json](../progress.json). Verify the commit before accepting any release claims.

## CPU-only Piper runtime

By default the installer reuses an existing Python interpreter in either:
- `$XDG_DATA_HOME/firefox-tts/runtime/linux-piper/venv/bin/python`
- `$XDG_DATA_HOME/edge-natural-tts/runtime/linux-piper/venv/bin/python`

If your existing Piper Python is somewhere else, point to it explicitly, without installing or changing any dependencies:

~~~bash
export FIREFOX_TTS_PIPER_PYTHON=/absolute/path/to/existing/venv/bin/python
~~~

By default, the voices are read from `$XDG_DATA_HOME/edge-natural-tts/voices` (normally `~/.local/share/edge-natural-tts/voices`), strictly read-only. To select a different existing voice directory:

~~~bash
export FIREFOX_TTS_VOICE_DIR=/absolute/path/to/your/onnx/voices
~~~

The installer rejects `onnxruntime-gpu` and performs no `pip` installation. It never modifies the models or the existing Edge native host.

## Register the Firefox native helper

~~~bash
./native/linux-piper/install-native-host.sh
~~~

Only two Firefox-specific artifacts are installed: a copied Python source/launcher under `$XDG_DATA_HOME/firefox-tts/runtime/linux-piper/` and a native host manifest under `~/.mozilla/native-messaging-hosts/com.sguzman.firefox_tts.linux_piper.json`. **When the native Python source changes, run this installer again after updating the repository**; reloading the extension alone does not update the separate installed host copy.

Its allowed extension ID is `firefox-tts@sguzman.dev` using `allowed_extensions`. It never writes Chromium `allowed_origins` or any Edge browser profile data. Repeated installation is covered by disposable-home automated tests.

## Temporary development installation in Firefox Developer Edition

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select this checkout's `manifest.json`. This is a user-triggered operation, **not** part of building or CI. A temporary add-on disappears on browser restart. Permanent installation in normal Firefox may require Mozilla signing; the project does not claim otherwise.

To build a reproducible unsigned XPI separately:

~~~bash
python3 tools/build_xpi.py --output /tmp/firefox-tts-unsigned.xpi
~~~

See [PACKAGING.md](PACKAGING.md). Do **not** install the QA-only localhost-permission variant produced inside CI: it is not shipped and is used only in fresh, isolated Firefox test profiles.

## Pronunciation and text-mapping options

Open Firefox's `about:addons` page, select **Firefox TTS** under Extensions, then choose its **Preferences** / **Options** page. The editor is registered as `options_ui.page` and does not belong inside the in-page playback toolbar. No migration occurs unless you explicitly request it.

The reader HUD follows an explicit website light/dark theme (including ChatGPT's theme class), or the browser/system preference when there is no site choice. Switching modes needs no reload and does not affect playback or page-editor focus.

## Optional pronunciation migration and rollback

Nothing is migrated without explicit opt-in. First validate the original source and checksum with a dry run:

~~~bash
python3 native/linux-piper/migrate-pronunciation.py
~~~

Only after reviewing the source and destination, copy the configuration to Firefox-owned storage:

~~~bash
python3 native/linux-piper/migrate-pronunciation.py --apply
~~~

If a Firefox configuration already exists, the command refuses to overwrite. `--apply --replace` explicitly archives the old Firefox revision before replacement. Its archive lives under `~/.local/share/firefox-tts/pronunciation-history/`, with private permissions. A chosen archived revision can be restored:

~~~bash
python3 native/linux-piper/migrate-pronunciation.py --restore 'before-edge-import-1234567890-012345abcdef.json'
python3 native/linux-piper/migrate-pronunciation.py --apply --restore 'before-edge-import-1234567890-012345abcdef.json'
~~~

The filenames above are examples; substitute the actual basename. Restoration preserves another backup before replacement. All operations leave the original Edge configuration unchanged. See [the native host guide](../native/linux-piper/README.md).

## Optional CPU speech preflight when the candidate is ready

To verify the existing installed Amy Low ONNX model without opening either browser or changing the Edge environment:

~~~bash
./native/linux-piper/self-test-cpu.sh en_US-amy-low
~~~

Other installed Piper voice IDs can be given as the only argument. This explicit check uses the already-installed CPU interpreter, rejects GPU runtimes, validates model metadata, reads the model, synthesizes a fixed harmless test phrase and reports its sample rate/PCM peak. It performs no model, profile, pronunciation or native manifest writes and no download. CI tests this command against disposable **fake** Piper assets; successful CI does not substitute for running it with the owner's actual model.

## Operation and recovery

When ready for real acceptance, click the Firefox extension action to inject the toolbar into the current tab. Only local Piper voices are offered (Amy Low by default if installed, with Ryan or HFC as optional alternatives). Stop cancels native synthesis and playback; Quit removes the toolbar. Editable controls should never lose focus during normal read-aloud.

If a tab is stuck, use Stop and Quit, then activate the extension again. If Piper discovery fails, inspect the Firefox native host allowlist and the existing interpreter/model paths. Do not delete or reinstall Edge voices to troubleshoot. Runtime errors are not evidence that the user must reinstall everything.

To unregister the Firefox helper only:

~~~bash
./native/linux-piper/uninstall-native-host.sh
~~~

That script preserves all voice assets, Python environments, Edge data and both apps' pronunciation configurations. User-owned rules are never deleted automatically.

## Safe automated verification

~~~bash
node --test
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 tests/firefox_headless_smoke.py
python3 tests/firefox_reader_integration.py
~~~

The last two require preinstalled Firefox and Geckodriver, use a disposable profile and only synthetic data. They do not touch the user's everyday profile.

**Release gate:** Real CPU-only model synthesis is verified; synthetic Firefox audio timing and the reader controls have passed CI. Audible real-voice speech, the live authenticated Writing Block, and exact-candidate focus/Stop/Quit/settings acceptance in Firefox Developer Edition still need confirmation before claiming 100%.
