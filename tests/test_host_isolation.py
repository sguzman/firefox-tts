"""Isolated stdlib-only integration tests: no user profile or voice changes."""
import importlib.util
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOST = ROOT / "native/linux-piper/linux_piper_host.py"
INSTALL = ROOT / "native/linux-piper/install-native-host.sh"
UNINSTALL = ROOT / "native/linux-piper/uninstall-native-host.sh"


def frame(message):
    data = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def parse_frames(data):
    items = []
    cursor = 0
    while cursor < len(data):
        if cursor + 4 > len(data):
            raise AssertionError("Native protocol emitted unframed bytes")
        length = struct.unpack("<I", data[cursor:cursor + 4])[0]
        cursor += 4
        if not 0 < length <= 16 * 1024 * 1024 or cursor + length > len(data):
            raise AssertionError("Native protocol emitted an invalid frame")
        items.append(json.loads(data[cursor:cursor + length]))
        cursor += length
    return items


class PiperIsolationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="firefox-tts-test-")
        self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name)
        self.data = self.home / "share"
        self.edge = self.data / "edge-natural-tts"
        self.voices = self.edge / "voices"
        self.voices.mkdir(parents=True)
        self.id = "en_US-synthetic-medium"
        (self.voices / (self.id + ".onnx")).write_bytes(b"test-not-a-real-model")
        (self.voices / (self.id + ".onnx.json")).write_text(
            json.dumps({"language": {"code": "en_US"}}), encoding="utf-8")
        self.edge_sentinel = self.edge / "pronunciation-config.json"
        self.edge_sentinel.write_text('{"edge": "untouched"}\n', encoding="utf-8")
        self.env = os.environ.copy()
        self.env.update({
            "HOME": str(self.home),
            "XDG_DATA_HOME": str(self.data),
            "EDGE_TTS_PIPER_VOICE_DIR": str(self.voices),
            "FIREFOX_TTS_DATA_HOME": str(self.data / "firefox-tts"),
        })

    def test_config_writes_never_follow_read_only_voice_directory(self):
        with patch.dict(os.environ, self.env, clear=True):
            spec = importlib.util.spec_from_file_location("firefox_tts_isolated_host", HOST)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertEqual(len(module.list_voices()), 1)
            self.assertEqual(module.VOICE_ROOT, self.voices)
            self.assertEqual(module.APP_HOME, self.data / "firefox-tts")
            module.write_pronunciation_config({"revision": 1, "savedAt": 42, "schemaVersion": 2})
            module.write_pronunciation_config({"revision": 2, "savedAt": 43, "schemaVersion": 2})
            self.assertEqual(module.read_pronunciation_config()["revision"], 2)
            self.assertTrue(module.PRONUNCIATION_HISTORY_DIR.exists())
        self.assertEqual(self.edge_sentinel.read_text(), '{"edge": "untouched"}\n')
        self.assertEqual(len(list(self.voices.glob("*.onnx"))), 1)

    def test_stdlib_native_handshake_voices_and_backup_roundtrip(self):
        messages = [
            {"type": "hello", "protocol": 1},
            {"type": "voices", "requestId": "v1"},
            {"type": "pronunciationConfigWrite", "requestId": "w1",
             "config": {"schemaVersion": 2, "revision": 4, "savedAt": 99}},
            {"type": "pronunciationConfigRead", "requestId": "r1"},
        ]
        process = subprocess.run([sys.executable, str(HOST)],
                                 input=b"".join(map(frame, messages)),
                                 env=self.env, capture_output=True, timeout=8,
                                 check=True)
        output = parse_frames(process.stdout)
        by_type = {msg["type"]: msg for msg in output}
        self.assertTrue(by_type["hello"]["cpuOnly"])
        self.assertEqual(by_type["hello"]["protocol"], 1)
        self.assertEqual(by_type["voices"]["voices"][0]["id"], self.id)
        self.assertEqual(by_type["pronunciationConfig"]["config"]["revision"], 4)
        self.assertTrue(by_type["pronunciationConfigSaved"]["path"].startswith(str(self.data / "firefox-tts")))
        self.assertEqual(self.edge_sentinel.read_text(), '{"edge": "untouched"}\n')

    def test_installer_idempotent_without_pip_or_real_browser(self):
        # Fake only the distribution metadata; no Piper import or inference.
        dist = self.home / "fake-site" / "piper_tts-1.8.0.dist-info"
        dist.mkdir(parents=True)
        (dist / "METADATA").write_text("Metadata-Version: 2.1\nName: piper-tts\nVersion: 1.8.0\n")
        env = dict(self.env, FIREFOX_TTS_PIPER_PYTHON=sys.executable,
                   PYTHONPATH=str(dist.parent))
        edge_browser = self.home / ".config/microsoft-edge/NativeMessagingHosts"
        edge_browser.mkdir(parents=True)
        sentinel = edge_browser / "edge-existing.json"
        sentinel.write_text("leave it alone")
        for _ in range(2):
            result = subprocess.run(["bash", str(INSTALL)], env=env, text=True,
                                    capture_output=True, timeout=8)
            self.assertEqual(result.returncode, 0, result.stderr)
        native = self.home / ".mozilla/native-messaging-hosts/com.sguzman.firefox_tts.linux_piper.json"
        manifest = json.loads(native.read_text())
        self.assertEqual(manifest["allowed_extensions"], ["firefox-tts@sguzman.dev"])
        self.assertNotIn("allowed_origins", manifest)
        self.assertTrue(manifest["path"].startswith(str(self.data / "firefox-tts")))
        launcher = pathlib.Path(manifest["path"])
        out = subprocess.run([str(launcher)], input=frame({"type": "hello", "protocol": 1}),
                             env=env, capture_output=True, timeout=8, check=True)
        self.assertEqual(parse_frames(out.stdout)[0]["backend"], "piper")
        subprocess.run(["bash", str(UNINSTALL)], env=env, check=True,
                       capture_output=True, timeout=8)
        self.assertFalse(native.exists())
        self.assertTrue(self.voices.exists())
        self.assertEqual(sentinel.read_text(), "leave it alone")
        self.assertEqual(self.edge_sentinel.read_text(), '{"edge": "untouched"}\n')


if __name__ == "__main__":
    unittest.main()
