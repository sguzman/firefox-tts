#!/usr/bin/env bash
# Firefox TTS Native Messaging setup. No sudo, no downloads, no Edge writes.
set -euo pipefail
umask 077

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
APP_HOME="$DATA_HOME/firefox-tts"
EDGE_HOME="$DATA_HOME/edge-natural-tts"
VOICE_DIR="${FIREFOX_TTS_VOICE_DIR:-$EDGE_HOME/voices}"
PYTHON="${FIREFOX_TTS_PIPER_PYTHON:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE="$SCRIPT_DIR/linux_piper_host.py"
RUNTIME="$APP_HOME/runtime/linux-piper"
HOST="$RUNTIME/linux_piper_host.py"
LAUNCHER="$RUNTIME/firefox-tts-piper-host"
# Firefox/Linux per-user manifest, not Chromium's NativeMessagingHosts path.
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
MANIFEST="$MANIFEST_DIR/com.sguzman.firefox_tts.linux_piper.json"
GECKO_ID="firefox-tts@sguzman.dev"

[[ -f "$SOURCE" ]] || { echo "Missing Python host source: $SOURCE" >&2; exit 1; }
[[ -d "$VOICE_DIR" ]] || { echo "No voice directory: $VOICE_DIR" >&2; exit 1; }

if [[ -z "$PYTHON" ]]; then
  for candidate in \
    "$APP_HOME/runtime/linux-piper/venv/bin/python" \
    "$EDGE_HOME/runtime/linux-piper/venv/bin/python"; do
    if [[ -x "$candidate" ]]; then PYTHON="$candidate"; break; fi
  done
fi
[[ -n "$PYTHON" && -x "$PYTHON" ]] || {
  echo "Piper Python environment missing. Set FIREFOX_TTS_PIPER_PYTHON to an existing CPU-only Piper Python executable." >&2
  exit 1
}
# Validate without downloading or mutating the interpreter's installation.
"$PYTHON" - <<'PY'
import importlib.metadata as metadata
name = metadata.version("piper-tts")
try:
    gpu = metadata.version("onnxruntime-gpu")
except metadata.PackageNotFoundError:
    gpu = None
if gpu:
    raise SystemExit("Refusing onnxruntime-gpu; Firefox TTS must stay CPU-only.")
print(f"Reusing existing CPU-only Piper runtime: {name}")
PY

if [[ -e "$MANIFEST" ]]; then
  # Never overwrite a manifest owned by an unrelated application.
  "$PYTHON" - "$MANIFEST" "$GECKO_ID" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
if value.get("name") != "com.sguzman.firefox_tts.linux_piper" or value.get("allowed_extensions") != [sys.argv[2]]:
    raise SystemExit("Existing native host manifest differs; refusing overwrite.")
PY
fi

mkdir -p "$RUNTIME" "$MANIFEST_DIR"
install -m 0644 "$SOURCE" "$HOST"
printf -v PYTHON_Q '%q' "$PYTHON"
printf -v HOST_Q '%q' "$HOST"
printf -v VOICE_Q '%q' "$VOICE_DIR"
printf -v APP_Q '%q' "$APP_HOME"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CUDA_VISIBLE_DEVICES=""
export EDGE_TTS_PIPER_VOICE_DIR=$VOICE_Q
export FIREFOX_TTS_DATA_HOME=$APP_Q
exec $PYTHON_Q $HOST_Q "\$@"
EOF
chmod 0755 "$LAUNCHER"
python3 - "$MANIFEST" "$LAUNCHER" "$GECKO_ID" <<'PY'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
manifest = {
    "name": "com.sguzman.firefox_tts.linux_piper",
    "description": "Firefox TTS local CPU-only Piper speech host",
    "path": str(pathlib.Path(sys.argv[2]).resolve()),
    "type": "stdio",
    "allowed_extensions": [sys.argv[3]],
}
with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as output:
    json.dump(manifest, output, indent=2)
    output.write("\n")
    temp = output.name
os.chmod(temp, 0o600)
os.replace(temp, path)
PY
echo "Firefox TTS native host installed separately from Edge."
if command -v ffmpeg >/dev/null 2>&1; then
  echo "  High-speed speech: offline FFmpeg tempo available (Firefox media stays at 1x)."
else
  echo "  WARNING: 1.8x+ speed requires FFmpeg. On Arch/EndeavourOS: sudo pacman -S ffmpeg" >&2
fi
echo "  Host manifest: $MANIFEST"
echo "  Voices (read-only): $VOICE_DIR"
echo "  Firefox data: $APP_HOME"
echo "No Edge files, model assets, or Edge browser profile were changed."
