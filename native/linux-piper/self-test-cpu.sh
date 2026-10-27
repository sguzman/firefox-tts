#!/usr/bin/env bash
# Explicit opt-in local CPU Piper self-check; read-only model access, no install.
set -euo pipefail
VOICE_ID="${1:-en_US-amy-low}"
[[ "$VOICE_ID" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "Invalid Piper voice ID; expected a filename-safe model identifier" >&2
  exit 2
}
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_HOME="${FIREFOX_TTS_DATA_HOME:-$DATA_HOME/firefox-tts}"
EDGE_HOME="$DATA_HOME/edge-natural-tts"
VOICE_DIR="${FIREFOX_TTS_VOICE_DIR:-$EDGE_HOME/voices}"
PYTHON="${FIREFOX_TTS_PIPER_PYTHON:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ -z "$PYTHON" ]]; then
  for candidate in "$APP_HOME/runtime/linux-piper/venv/bin/python" \
                   "$EDGE_HOME/runtime/linux-piper/venv/bin/python"; do
    if [[ -x "$candidate" ]]; then PYTHON="$candidate"; break; fi
  done
fi
[[ -n "$PYTHON" && -x "$PYTHON" ]] || {
  echo "No existing Piper interpreter. Point FIREFOX_TTS_PIPER_PYTHON to a CPU-only Piper venv." >&2
  exit 2
}
[[ -f "$VOICE_DIR/$VOICE_ID.onnx" && -f "$VOICE_DIR/$VOICE_ID.onnx.json" ]] || {
  echo "Required existing model and .onnx.json metadata not found for $VOICE_ID" >&2
  exit 2
}
"$PYTHON" - <<'PY'
import importlib.metadata as metadata
try:
    version = metadata.version("piper-tts")
except metadata.PackageNotFoundError:
    raise SystemExit("Piper distribution is missing from selected interpreter")
try:
    gpu = metadata.version("onnxruntime-gpu")
except metadata.PackageNotFoundError:
    gpu = None
if gpu:
    raise SystemExit("Refusing GPU runtime: use an existing CPU-only Piper interpreter")
print("Existing CPU-only Piper distribution:", version)
PY
export CUDA_VISIBLE_DEVICES=""
export EDGE_TTS_PIPER_VOICE_DIR="$VOICE_DIR"
export FIREFOX_TTS_DATA_HOME="$APP_HOME"
exec "$PYTHON" "$SCRIPT_DIR/linux_piper_host.py" --self-test "$VOICE_ID"
