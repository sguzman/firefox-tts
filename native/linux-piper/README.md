# 🔌 Firefox Piper Native Messaging

This host is **separate** from the Edge extension. Its name is
`com.sguzman.firefox_tts.linux_piper`, and the exact Gecko ID is
`firefox-tts@sguzman.dev`. Firefox/Linux looks for the host manifest in
`~/.mozilla/native-messaging-hosts/`. The JSON uses `allowed_extensions`
rather than Chromium's `allowed_origins`.

The installer is opt-in and **does not download or install Piper**. It reuses
an existing CPU-only Piper Python virtual environment (prefer the Firefox
private environment, otherwise an existing Edge Piper venv), or a user-selected
`FIREFOX_TTS_PIPER_PYTHON`. Models default to
`~/.local/share/edge-natural-tts/voices/` but can be redirected with
`FIREFOX_TTS_VOICE_DIR`. **Voice files are only read, never copied or modified.**

The host makes every durable pronunciation write under
`~/.local/share/firefox-tts/`, independent of the voice directory. It never
adopts the Edge writable configuration path, even if its voice directory
points into that application. `FIREFOX_TTS_DATA_HOME` can explicitly select
the new app's writable root.

When the runtime/manifest code has passed protocol and disposable Firefox QA,
the explicit install command will be:

```bash
./native/linux-piper/install-native-host.sh
```

To unregister the Firefox host while **preserving voice models, venvs and
pronunciation data**:

```bash
./native/linux-piper/uninstall-native-host.sh
```

Neither script requires sudo, touches an existing Firefox profile, or writes
to the Edge Native Messaging path. Never run the installer as an automatic
build or test step.

## One-time pronunciation migration (opt-in)

Run **dry-run first**. It checks the existing Edge configuration, prints its
revision and SHA-256, and does not modify any files or expose the pronunciation
rules in logs:

```bash
python3 native/linux-piper/migrate-pronunciation.py
```

To copy it into Firefox's separate writable data directory:

```bash
python3 native/linux-piper/migrate-pronunciation.py --apply
```

If the Firefox configuration already exists, this command **refuses** to
overwrite it. After reviewing the situation, explicitly archive that previous
Firefox revision and replace it with the Edge source:

```bash
python3 native/linux-piper/migrate-pronunciation.py --apply --replace
```

Previous Firefox data is preserved under `pronunciation-history/`. Edge's
original configuration is only read, never modified. The migration never
touches installed ONNX voice models or either browser profile. Tests run these
paths in disposable XDG directories.
