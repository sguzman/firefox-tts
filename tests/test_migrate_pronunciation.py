"""Pronunciation migration tests use disposable XDG data directories only."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATE = ROOT / "native/linux-piper/migrate-pronunciation.py"


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="firefox-tts-migration-")
        self.addCleanup(self.temporary.cleanup)
        self.base = pathlib.Path(self.temporary.name)
        self.data = self.base / "xdg"
        self.old = self.data / "edge-natural-tts" / "pronunciation-config.json"
        self.new = self.data / "firefox-tts" / "pronunciation-config.json"
        self.old.parent.mkdir(parents=True)
        self.old.write_text(json.dumps({
            "schemaVersion": 2, "revision": 1, "savedAt": 100,
            "pronunciation": {"customPronunciations": {"GPU": "G P U"}}
        }))
        self.env = dict(os.environ, HOME=str(self.base),
                        XDG_DATA_HOME=str(self.data))

    def invoke(self, *args):
        return subprocess.run([sys.executable, str(MIGRATE), *args],
                              env=self.env, capture_output=True, text=True, timeout=8)

    def test_dry_run_is_read_only_and_apply_keeps_source_untouched(self):
        source = self.old.read_bytes()
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Dry run", result.stdout)
        self.assertFalse(self.new.exists())
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.old.read_bytes(), source)
        self.assertEqual(self.new.read_bytes(), source)
        self.assertEqual(self.new.stat().st_mode & 0o777, 0o600)

    def test_refuses_overwrite_without_opt_in_then_archives_old_revision(self):
        initial = self.invoke("--apply")
        self.assertEqual(initial.returncode, 0, initial.stderr)
        original_firefox = self.new.read_bytes()
        source = json.loads(self.old.read_text())
        source["revision"] = 2
        source["pronunciation"]["customPronunciations"]["CPU"] = "C P U"
        self.old.write_text(json.dumps(source))
        denied = self.invoke("--apply")
        self.assertEqual(denied.returncode, 2)
        self.assertEqual(self.new.read_bytes(), original_firefox)
        accepted = self.invoke("--apply", "--replace")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        backups = list((self.new.parent / "pronunciation-history").glob("before-edge-import-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original_firefox)
        self.assertEqual(json.loads(self.new.read_text())["revision"], 2)
        self.assertEqual(json.loads(self.old.read_text())["revision"], 2)

    def test_archived_revision_can_be_restored_without_touching_edge_source(self):
        self.assertEqual(self.invoke("--apply").returncode, 0)
        initial = self.new.read_bytes()
        incoming = json.loads(self.old.read_text())
        incoming["revision"] = 12
        self.old.write_text(json.dumps(incoming))
        self.assertEqual(self.invoke("--apply", "--replace").returncode, 0)
        before = list((self.new.parent / "pronunciation-history").glob("before-edge-import-*.json"))
        self.assertEqual(len(before), 1)
        name = before[0].name
        dry = self.invoke("--restore", name)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(json.loads(self.new.read_text())["revision"], 12)
        applied = self.invoke("--apply", "--restore", name)
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(self.new.read_bytes(), initial)
        rewinds = list((self.new.parent / "pronunciation-history").glob("before-restore-*.json"))
        self.assertEqual(len(rewinds), 1)
        self.assertEqual(json.loads(rewinds[0].read_text())["revision"], 12)
        self.assertEqual(json.loads(self.old.read_text())["revision"], 12)
        self.assertEqual(self.invoke("--apply", "--restore", "../not-a-backup.json").returncode, 2)

    def test_rejects_corrupt_input_without_creating_firefox_files(self):
        self.old.write_text('{"revision":')
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.new.exists())

    def test_rejects_symlinked_firefox_destination(self):
        self.new.parent.mkdir(parents=True)
        self.new.symlink_to(self.old)
        result = self.invoke("--apply", "--replace")
        self.assertEqual(result.returncode, 2)
        self.assertTrue(self.new.is_symlink())
        self.assertEqual(json.loads(self.old.read_text())["revision"], 1)


if __name__ == "__main__":
    unittest.main()
