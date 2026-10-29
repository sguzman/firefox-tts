"""No-network release packaging tests; all outputs are disposable."""
import importlib.util
import json
import struct
import pathlib
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_firefox_xpi", ROOT / "tools/build_xpi.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class XpiPackagingTest(unittest.TestCase):
    def test_rebuild_has_identical_bytes_and_no_native_or_private_sources(self):
        with tempfile.TemporaryDirectory(prefix="firefox-tts-xpi-") as directory:
            first = pathlib.Path(directory) / "first.xpi"
            second = pathlib.Path(directory) / "second.xpi"
            digest_a, names_a = MOD.build(first)
            digest_b, names_b = MOD.build(second)
            self.assertEqual(digest_a, digest_b)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(names_a, names_b)
            self.assertIn("manifest.json", names_a)
            self.assertIn("src/background/action.js", names_a)
            self.assertIn("src/options/pronunciation.html", names_a)
            for icon in ("src/icons/fox-tts-16.png", "src/icons/fox-tts-32.png",
                         "src/icons/fox-tts-128.svg"):
                self.assertIn(icon, names_a)
            self.assertNotIn("native/linux-piper/linux_piper_host.py", names_a)
            self.assertFalse(any(n.startswith(("tests/", "native/", ".git/", "tools/")) for n in names_a))
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), names_a)
                manifest = json.loads(archive.read("manifest.json"))
                icon_paths = set(manifest["icons"].values())
                icon_paths.update(manifest["action"]["default_icon"].values())
                self.assertTrue(icon_paths.issubset(names_a))
                for pixel_size in (16, 32):
                    png = archive.read(f"src/icons/fox-tts-{pixel_size}.png")
                    self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
                    self.assertEqual(struct.unpack(">II", png[16:24]),
                                     (pixel_size, pixel_size))
                svg = archive.read("src/icons/fox-tts-128.svg")
                self.assertTrue(svg.startswith(b"<svg "))
                self.assertIn(b"data:image/png;base64,", svg)
                self.assertTrue(all(i.date_time[:3] == (1980, 1, 1)
                                    for i in archive.infolist()))
                self.assertTrue(all(i.external_attr >> 16 == 0o100644
                                    for i in archive.infolist()))


if __name__ == "__main__":
    unittest.main()
