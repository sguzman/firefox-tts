"""Deterministic byte-level regression tests for native Piper sentence joins."""
import importlib.util
from pathlib import Path
import struct
import unittest

HOST = Path(__file__).resolve().parents[1] / "native/linux-piper/linux_piper_host.py"
spec = importlib.util.spec_from_file_location("firefox_tts_pcm_host", HOST)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def samples(pcm):
    return list(struct.unpack("<" + "h" * (len(pcm) // 2), pcm))


class EdgeFadeTest(unittest.TestCase):
    def test_mono_edges_reach_silence_without_altering_middle_or_duration(self):
        values = [24000] * 1600  # 100 ms of audio at 16 kHz
        pcm = bytearray(struct.pack("<" + "h" * len(values), *values))
        before = bytes(pcm)
        host.taper_pcm_edges(pcm, 16000, 2, 1)
        after = samples(pcm)
        self.assertEqual(len(pcm), len(before))
        self.assertEqual(after[0], 0)
        self.assertEqual(after[-1], 0)
        self.assertEqual(after[192], 24000)
        self.assertEqual(after[-193], 24000)
        self.assertEqual(after[800], 24000)
        self.assertTrue(all(0 <= a <= b for a,b in zip(after[:192],after[1:193])))
        self.assertTrue(all(a >= b for a,b in zip(after[-193:-1],after[-192:])))

    def test_stereo_ramps_both_channels_without_swapping_or_clipping(self):
        frames = 320
        raw = [v for _ in range(frames) for v in (32767, -32768)]
        pcm = bytearray(struct.pack("<" + "h" * len(raw), *raw))
        host.taper_pcm_edges(pcm, 16000, 2, 2)
        out = samples(pcm)
        self.assertEqual(out[:2], [0, 0])
        self.assertEqual(out[-2:], [0, 0])
        self.assertEqual(out[200:202], [32767, -32768])
        self.assertTrue(all(-32768 <= v <= 32767 for v in out))

    def test_tiny_clip_and_invalid_format_are_safe(self):
        for count in (0, 1, 2, 3, 4, 8):
            pcm = bytearray(struct.pack("<" + "h" * count, *([1000] * count)))
            host.taper_pcm_edges(pcm, 16000, 2, 1)
            self.assertEqual(len(pcm), count * 2)
        pcm = bytearray(struct.pack("<hhhh", 100, 100, 100, 100))
        before = bytes(pcm)
        host.taper_pcm_edges(pcm, 16000, 1, 1)
        self.assertEqual(pcm, before)
        host.taper_pcm_edges(pcm, 16000, 2, 1, 0)
        self.assertEqual(pcm, before)
        with self.assertRaisesRegex(ValueError, "incomplete PCM"):
            host.taper_pcm_edges(bytearray(b"\x01"), 16000, 2, 1)


if __name__ == "__main__":
    unittest.main()
