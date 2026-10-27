#!/usr/bin/env python3
"""Disposable Gecko execution test with a QA-only localhost-permission XPI.

The production XPI is never modified. This harness can exercise actual
Firefox content-script and reader startup without a GUI toolbar, which
Geckodriver cannot reliably click in headless mode.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from threading import Thread

import firefox_headless_smoke as base
from test_fake_piper_protocol import FAKE_PIPER

ROOT = Path(__file__).resolve().parents[1]
ELEMENT = "element-6066-11e4-a52e-4f735466cecf"


def qa_package(release: Path, destination: Path) -> None:
    action = (ROOT / "src/background/action.js").read_text(encoding="utf-8")
    files = re.findall(r'"(src/content/[^"]+\.js)"', action)
    if not files or files[0] != "src/content/namespace.js" or files[-1] != "src/content/content-script.js":
        raise AssertionError("Cannot reconstruct the pinned production reader injection order")
    bridge = """/* QA-ONLY: not bundled in the released extension */\n"""
    bridge += """browser.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (change.status !== "complete" ||
          !tab.url?.startsWith("http://127.0.0.1:")) return;
      void (async () => {
        await browser.scripting.insertCSS({ target: { tabId },
          files: ["src/content/content.css"] });
        await browser.scripting.executeScript({ target: { tabId },
          files: FILE_LIST });
        await browser.tabs.sendMessage(tabId, { type: "EDGE_TTS_TOGGLE_V2" });
      })().catch(error => console.error("Firefox QA reader injection:", error));
    });""".replace("FILE_LIST", json.dumps(files))
    with zipfile.ZipFile(release) as original:
        manifest = json.loads(original.read("manifest.json"))
        manifest["host_permissions"] = ["http://127.0.0.1/*"]
        manifest["permissions"].append("tabs")
        manifest["background"]["scripts"].append("qa/bridge.js")
        with zipfile.ZipFile(destination, mode="w", compression=zipfile.ZIP_DEFLATED) as output:
            for entry in original.infolist():
                contents = original.read(entry.filename)
                if entry.filename == "manifest.json":
                    contents = json.dumps(manifest, indent=2).encode("utf-8")
                output.writestr(entry.filename, contents)
            output.writestr("qa/bridge.js", bridge)
    print("QA-only XPI: localhost host permission and an isolated synthetic-page trigger")


def install_fake_native_host(root: Path) -> None:
    """Register a fake Piper on isolated HOME; never run a real model."""
    (root / "piper.py").write_text(FAKE_PIPER, encoding="utf-8")
    voices = root / "voices"
    voices.mkdir()
    model = voices / "en_US-amy-low.onnx"
    model.write_bytes(b"synthetic-model-for-ci-only")
    (voices / "en_US-amy-low.onnx.json").write_text(
        '{"language":{"code":"en_US"}}', encoding="utf-8"
    )
    host = ROOT / "native/linux-piper/linux_piper_host.py"
    launcher = root / "piper-native-qa"
    launcher.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) +
                        " " + shlex.quote(str(host)) + ' "$@"\n', encoding="utf-8")
    launcher.chmod(0o700)
    directory = root / ".mozilla/native-messaging-hosts"
    directory.mkdir(parents=True)
    (directory / "com.sguzman.firefox_tts.linux_piper.json").write_text(
        json.dumps({
            "name": "com.sguzman.firefox_tts.linux_piper",
            "description": "Synthetic QA-only Firefox CPU Piper host",
            "path": str(launcher),
            "type": "stdio",
            "allowed_extensions": ["firefox-tts@sguzman.dev"]
        }), encoding="utf-8"
    )
    os.environ.update({
        "PYTHONPATH": str(root),
        "EDGE_TTS_PIPER_VOICE_DIR": str(voices),
        "FIREFOX_TTS_DATA_HOME": str(root / "firefox-data")
    })


def main() -> None:
    if not shutil.which("firefox") or not shutil.which("geckodriver"):
        raise RuntimeError("Runner must already provide Firefox and Geckodriver")
    with tempfile.TemporaryDirectory(prefix="firefox-tts-content-qa-") as tmp:
        root = Path(tmp)
        os.environ.update({
            "HOME": str(root), "XDG_DATA_HOME": str(root / "share"),
            "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache")
        })
        install_fake_native_host(root)
        release = root / "original.xpi"
        variant = root / "qa-only.xpi"
        subprocess.run([sys.executable, str(ROOT / "tools/build_xpi.py"),
                        "--output", str(release)], check=True)
        qa_package(release, variant)

        server = base.ThreadingHTTPServer(("127.0.0.1", 0), base.FixtureHandler)
        Thread(target=server.serve_forever, daemon=True).start()
        port = base.free_port()
        host = f"http://127.0.0.1:{port}"
        with (root / "gecko.log").open("wb") as logs:
            proc = subprocess.Popen(["geckodriver", "--port", str(port)], env=os.environ.copy(),
                                    stdout=logs, stderr=subprocess.STDOUT)
            session = None
            try:
                base.eventually(lambda: base.request(host + "/status").get("value", {}).get("ready"),
                                timeout=15, explanation="QA driver did not start")
                caps = {"capabilities": {"alwaysMatch": {
                    "browserName": "firefox",
                    "moz:firefoxOptions": {"args": ["-headless"]}
                }}}
                created = base.request(host + "/session", "POST", caps, timeout=55)
                session = created["value"]["sessionId"]
                installed = base.webdriver(host, session, "POST", "moz/addon/install",
                                            {"path": str(variant), "temporary": True})
                assert installed == "firefox-tts@sguzman.dev", installed
                base.webdriver(host, session, "POST", "url",
                               {"url": f"http://127.0.0.1:{server.server_address[1]}/index.html"})
                base.eventually(lambda: base.execute(host, session,
                    "return Boolean(document.querySelector('#edge-tts-toolbar'))"),
                    timeout=18, explanation="Synthetic QA injection failed in real Firefox")
                title = base.execute(host, session,
                    "return document.querySelector('#edge-tts-toolbar').textContent")
                assert "Firefox TTS" in title
                base.eventually(lambda: base.execute(host, session,
                    """return [...document.querySelector('[data-edge-tts-voice]').options]
                       .some(o => o.textContent.includes('Amy Low'))"""),
                    timeout=20, explanation="Real Firefox did not discover fake local Piper voice")
                print("PASS: Firefox Native Messaging discovered synthetic CPU Piper voice")
                # Exercise live settings without modifying any real profile.
                speed = base.execute(host, session,
                    """const x=document.querySelector('[data-edge-tts-rate]');
                       x.value='1.3'; x.dispatchEvent(new Event('input',{bubbles:true}));
                       x.dispatchEvent(new Event('change',{bubbles:true}));
                       return document.querySelector('[data-edge-tts-rate-value]').value""")
                assert "1.3" in speed, speed
                assert base.execute(host, session,
                    "return document.querySelector('#editor').value") == "Private editable text must not be read."
                controls = base.execute(host, session,
                    """const changes=[
                         ['[data-edge-tts-volume]', '65', '[data-edge-tts-volume-value]'],
                         ['[data-edge-tts-batch-chars]', '800', '[data-edge-tts-batch-chars-value]'],
                         ['[data-edge-tts-sentence-pause]', '450', '[data-edge-tts-sentence-pause-value]']
                       ];
                       return changes.map(([field,val,output])=>{
                         const element=document.querySelector(field);
                         if(!element) return {field,error:'absent'};
                         element.value=val;
                         element.dispatchEvent(new Event('input',{bubbles:true}));
                         element.dispatchEvent(new Event('change',{bubbles:true}));
                         return {field, actual:element.value, output:document.querySelector(output)?.value};
                       });""")
                assert [row["actual"] for row in controls] == ["65", "800", "450"], controls
                assert "65%" in controls[0]["output"], controls
                assert "800" in controls[1]["output"], controls
                assert "450" in controls[2]["output"], controls
                print("PASS: Firefox volume, batching and sentence-pause controls respond")
                print("PASS: Real Firefox synthetic voice catalog and speed controls")
                print("PASS: Actual Firefox installed modules, built reader and mounted toolbar")

                base.execute(host, session,
                    "document.querySelector('#editor').focus(); return document.activeElement.id")
                base.execute(host, session,
                    "document.querySelector('#edge-tts-toolbar [data-edge-tts-action=stop]').click()")
                assert base.execute(host, session, "return document.activeElement.id") == "editor"
                base.execute(host, session,
                    "document.querySelector('#edge-tts-toolbar [data-edge-tts-action=quit]').click()")
                base.eventually(lambda: base.execute(host, session,
                    "return document.querySelector('#edge-tts-toolbar') === null"),
                    timeout=8, explanation="Quit did not remove toolbar in real Firefox")
                print("PASS: Real Firefox synthetic reader stop/quit did not steal editor focus")
            except Exception:
                logs.flush()
                print("QA geckodriver log tail:", file=sys.stderr)
                print("\n".join((root / "gecko.log").read_text(errors="replace").splitlines()[-70:]),
                      file=sys.stderr)
                raise
            finally:
                if session:
                    try:
                        base.request(host + f"/session/{session}", "DELETE", timeout=8)
                    except Exception:
                        pass
                proc.terminate()
                try:
                    proc.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    proc.kill()
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    main()
