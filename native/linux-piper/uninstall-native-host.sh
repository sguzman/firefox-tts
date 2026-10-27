#!/usr/bin/env bash
set -euo pipefail
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/firefox-tts/runtime/linux-piper"
MANIFEST="$HOME/.mozilla/native-messaging-hosts/com.sguzman.firefox_tts.linux_piper.json"
if [[ -f "$MANIFEST" ]] && grep -q '"name": "com.sguzman.firefox_tts.linux_piper"' "$MANIFEST"; then
  rm -- "$MANIFEST"
fi
rm -f -- "$ROOT/firefox-tts-piper-host" "$ROOT/linux_piper_host.py"
echo "Firefox TTS host unregistered. Pronunciation data, venvs and voices were preserved."
