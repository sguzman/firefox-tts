"""Native-message speech tests using a fake Python Piper module, no ONNX/runtime download."""
import base64
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import wave
import io

HOST = Path(__file__).resolve().parents[1] / "native/linux-piper/linux_piper_host.py"
FAKE_PIPER = '''
import time
class SynthesisConfig:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
class PiperVoice:
    @classmethod
    def load(cls, model_path, use_cuda=False):
        if use_cuda:
            raise RuntimeError("GPU inference forbidden")
        return cls()
    def synthesize(self, text, config, include_alignments=False):
        count = 25 if "cancel" in text else 4
        for i in range(count):
            time.sleep(0.016)
            yield type("Chunk", (), {
                "sample_rate": 16000, "sample_width": 2, "sample_channels": 1,
                "audio_int16_bytes": b"\\x01\\x00" * 160
            })()
'''


def native_frame(data):
    raw = json.dumps(data).encode("utf-8")
    return struct.pack("<I", len(raw)) + raw


class FakePiperProtocolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="firefox-tts-fake-piper-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / "piper.py").write_text(FAKE_PIPER)
        dist = root / "piper_tts-1.8.0.dist-info"
        dist.mkdir()
        (dist / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: piper-tts\nVersion: 1.8.0\n")
        self.voices = root / "edge-voices-readonly"
        self.voices.mkdir()
        (self.voices / "en_US-amy-low.onnx").write_bytes(b"synthetic-model")
        (self.voices / "en_US-amy-low.onnx.json").write_text('{"language":{"code":"en_US"}}')
        self.voice_bytes = (self.voices / "en_US-amy-low.onnx").read_bytes()
        env = dict(os.environ)
        env.update(PYTHONPATH=str(root), HOME=str(root), XDG_DATA_HOME=str(root / "data"),
                   EDGE_TTS_PIPER_VOICE_DIR=str(self.voices),
                   FIREFOX_TTS_DATA_HOME=str(root / "firefox-data"))
        self.env = env
        self.proc = subprocess.Popen([sys.executable, str(HOST)], env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0)
        self.addCleanup(self.cleanup_proc)

    def cleanup_proc(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)

    def send(self, value):
        self.proc.stdin.write(native_frame(value))
        self.proc.stdin.flush()

    def read_exact(self, size, deadline):
        chunks = bytearray()
        while len(chunks) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("Native host timed out; stderr=" +
                                     str(self.proc.stderr.read(2048) if self.proc.poll() is not None else ""))
            ready, _, _ = select.select([self.proc.stdout], [], [], remaining)
            if not ready:
                raise AssertionError("Timed out reading Native Messaging host")
            block = os.read(self.proc.stdout.fileno(), size - len(chunks))
            if not block:
                raise AssertionError("Native host exited before response")
            chunks.extend(block)
        return bytes(chunks)

    def read(self, deadline=None):
        deadline = deadline or time.monotonic() + 4
        length = struct.unpack("<I", self.read_exact(4, deadline))[0]
        self.assertLessEqual(length, 1024 * 1024)
        return json.loads(self.read_exact(length, deadline))

    def handshake(self):
        self.send({"type": "hello", "protocol": 1})
        hello = self.read()
        self.assertEqual(hello["type"], "hello")
        self.assertTrue(hello["cpuOnly"])
        self.send({"type": "voices", "requestId": "v"})
        voice = self.read()
        self.assertEqual(voice["voices"][0]["id"], "en_US-amy-low")

    def test_synthesized_wav_frames_are_playable_and_edge_models_unchanged(self):
        self.handshake()
        self.send({"type": "synthesize", "requestId": "s", "voiceId": "en_US-amy-low",
                   "text": "synthetic Firefox Piper speech"})
        audio, events = bytearray(), []
        deadline = time.monotonic() + 6
        while True:
            msg = self.read(deadline)
            events.append(msg["type"])
            self.assertEqual(msg["requestId"], "s")
            if msg["type"] == "audioChunk":
                audio.extend(base64.b64decode(msg["data"]))
            if msg["type"] == "synthesisEnd":
                self.assertGreater(msg["durationMs"], 0)
                break
            if msg["type"] == "error":
                self.fail(msg["message"])
        self.assertIn("boundary", events)
        self.assertIn("audioChunk", events)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            self.assertEqual(wav.getframerate(), 16000)
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertGreater(wav.getnframes(), 0)
        self.assertEqual((self.voices / "en_US-amy-low.onnx").read_bytes(), self.voice_bytes)

    def test_explicit_cpu_self_check_uses_existing_fake_model_read_only(self):
        script = HOST.parent / "self-test-cpu.sh"
        finished = subprocess.run(["bash", str(script), "en_US-amy-low"],
                                  env=self.env, capture_output=True, text=True, timeout=8)
        self.assertEqual(finished.returncode, 0, finished.stderr)
        self.assertIn("Piper self-test OK", finished.stdout)
        self.assertIn("16000 Hz", finished.stdout)
        self.assertEqual((self.voices / "en_US-amy-low.onnx").read_bytes(), self.voice_bytes)
        wrong = subprocess.run(["bash", str(script), "../traversal"], env=self.env,
                               capture_output=True, text=True, timeout=8)
        self.assertEqual(wrong.returncode, 2)

    def test_cancel_request_does_not_emit_completed_speech(self):
        self.handshake()
        self.send({"type": "synthesize", "requestId": "cancel-me",
                   "voiceId": "en_US-amy-low", "text": "cancel the fake Piper task"})
        deadline = time.monotonic() + 6
        while True:
            event = self.read(deadline)
            if event["type"] == "status" and "Synthesizing" in event.get("status", ""):
                break
            if event["type"] == "error":
                self.fail(event["message"])
        self.send({"type": "cancel", "requestId": "cancel-me"})
        while True:
            event = self.read(deadline)
            if event.get("requestId") == "cancel-me" and event["type"] in ("cancelled", "synthesisEnd"):
                self.assertEqual(event["type"], "cancelled")
                break
        self.assertEqual((self.voices / "en_US-amy-low.onnx").read_bytes(), self.voice_bytes)


if __name__ == "__main__":
    unittest.main()
