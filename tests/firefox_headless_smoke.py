#!/usr/bin/env python3
"""Disposable Firefox/Geckodriver MV3 test with the host system's existing tools.

No pip, npm, browser downloads, external network or real profile.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

ROOT = Path(__file__).resolve().parents[1]
ALT = "\ue00a"
SHIFT = "\ue008"
PAGE = b"""<!doctype html><html><head><meta charset='utf-8'>
<title>Firefox TTS synthetic fixture</title></head><body>
<h1>Alpha paragraph</h1><p>First sentence. Second sentence.</p>
<textarea id='editor'>Private editable text must not be read.</textarea>
</body></html>"""


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        contents = PAGE
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(contents)))
        self.end_headers()
        self.wfile.write(contents)

    def log_message(self, *args) -> None:
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request(url: str, method: str = "GET", payload=None, timeout: float = 15):
    raw = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=raw, method=method,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"WebDriver {method} {url}: {error.code}: {details[:1500]}") from error


def webdriver(base: str, session: str, method: str, route: str, payload=None):
    return request(f"{base}/session/{session}/{route}", method, payload)["value"]


def execute(base: str, session: str, script: str):
    return webdriver(base, session, "POST", "execute/sync", {"script": script, "args": []})


def eventually(condition, *, timeout: float = 12, explanation: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = condition()
            if value:
                return value
        except (urllib.error.URLError, ConnectionError):
            # Geckodriver may not yet have bound its loopback socket.
            pass
        time.sleep(0.25)
    raise AssertionError(explanation)


def main() -> None:
    for tool in ("firefox", "geckodriver"):
        if shutil.which(tool) is None:
            raise SystemExit(f"Missing preinstalled {tool}; no package download allowed")
    with tempfile.TemporaryDirectory(prefix="firefox-tts-real-qa-") as temporary:
        home = Path(temporary)
        xpi = home / "extension.xpi"
        subprocess.run([sys.executable, str(ROOT / "tools/build_xpi.py"),
                        "--output", str(xpi)], check=True)
        # Geckodriver does not allow -remote-allow-system-access as a
        # moz:firefoxOptions argument. Use a disposable launcher confined to
        # this synthetic CI profile to inspect/click Firefox's real toolbar.
        firefox_binary = shutil.which("firefox")
        launcher = home / "firefox-qa-launcher"
        launcher.write_text('#!/bin/sh\nexec ' + firefox_binary + ' -remote-allow-system-access "$@"\n')
        launcher.chmod(0o700)
        os.environ["HOME"] = str(home)
        os.environ["XDG_CONFIG_HOME"] = str(home / ".config")
        os.environ["XDG_DATA_HOME"] = str(home / ".local/share")
        os.environ["XDG_CACHE_HOME"] = str(home / ".cache")

        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        server_thread = Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        port = free_port()
        driver_base = f"http://127.0.0.1:{port}"
        log_path = home / "geckodriver.log"
        with log_path.open("wb") as logs:
            driver = subprocess.Popen(["geckodriver", "--port", str(port)],
                                      cwd=home, env=os.environ.copy(),
                                      stdout=logs, stderr=subprocess.STDOUT)
            session = None
            try:
                eventually(lambda: request(driver_base + "/status").get("value", {}).get("ready"),
                           timeout=15, explanation="Geckodriver never became ready")
                capabilities = {"capabilities": {"alwaysMatch": {
                    "browserName": "firefox",
                    "moz:firefoxOptions": {"binary": str(launcher), "args": ["-headless"]},
                    "acceptInsecureCerts": False
                }}}
                create = request(driver_base + "/session", "POST", capabilities, timeout=35)
                session = create.get("value", {}).get("sessionId") or create.get("sessionId")
                if not session:
                    raise AssertionError(f"WebDriver did not provide session ID: {str(create)[:800]}")
                result = webdriver(driver_base, session, "POST", "moz/addon/install",
                                   {"path": str(xpi), "temporary": True})
                if result != "firefox-tts@sguzman.dev":
                    raise AssertionError(f"Unexpected temporary addon ID {result!r}")
                print("PASS: Firefox loaded unsigned MV3 extension in disposable browser")

                fixture_url = f"http://127.0.0.1:{server.server_address[1]}/index.html"
                webdriver(driver_base, session, "POST", "url", {"url": fixture_url})
                assert execute(driver_base, session, "return document.title") == "Firefox TTS synthetic fixture"
                assert execute(driver_base, session, "return document.querySelector('#edge-tts-toolbar') === null")
                print("PASS: No passive DOM injection before user shortcut")

                execute(driver_base, session,
                        "window.__ttsQaKeys=[]; window.addEventListener('keydown', e=>window.__ttsQaKeys.push([e.key,e.altKey,e.shiftKey,e.ctrlKey]),true); document.querySelector('#editor').focus(); return document.activeElement.id")
                webdriver(driver_base, session, "POST", "actions", {"actions": [
                    {"type": "key", "id": "keyboard", "actions": [
                        {"type": "keyDown", "value": ALT},
                        {"type": "keyDown", "value": SHIFT},
                        {"type": "keyDown", "value": "r"},
                        {"type": "keyUp", "value": "r"},
                        {"type": "keyUp", "value": SHIFT},
                        {"type": "keyUp", "value": ALT}
                    ]}
                ]})
                print("Shortcut diagnostics:", execute(driver_base, session,
                      "return { keys: window.__ttsQaKeys, active:document.activeElement?.id, value:document.querySelector('#editor').value, hasFocus:document.hasFocus() }"), flush=True)
                try:
                    webdriver(driver_base, session, "POST", "moz/context", {"context":"chrome"})
                    toolbar_buttons = execute(driver_base, session,
                      "return [...document.querySelectorAll('toolbarbutton')].map(x=>({id:x.id,label:x.getAttribute('label'),tooltip:x.getAttribute('tooltiptext')})).filter(x=>JSON.stringify(x).toLowerCase().includes('tts'))")
                    print("Firefox toolbar widgets:", toolbar_buttons, flush=True)
                    button = execute(driver_base, session,
                      "return document.getElementById('unified-extensions-button')")
                    if button:
                        key = "element-6066-11e4-a52e-4f735466cecf"
                        webdriver(driver_base, session, "POST",
                                  "element/" + button[key] + "/click", {})
                    time.sleep(0.5)
                    menu = execute(driver_base, session,
                      """return {
                         button:Boolean(document.getElementById('unified-extensions-button')),
                         panel: document.getElementById('unified-extensions-panel')?.outerHTML.slice(0,5000),
                         items:[...document.querySelectorAll('[extension-id], unified-extensions-item')]
                           .map(x=>({tag:x.tagName,id:x.id,ext:x.getAttribute('extension-id'),
                                    html:x.outerHTML.slice(0,1400)})).slice(0,12)};""")
                    print("Unified extension menu:", menu, flush=True)
                except Exception as exc:
                    print("Privileged chrome toolbar inspection unavailable:", str(exc)[:300], flush=True)
                finally:
                    try:
                        webdriver(driver_base, session, "POST", "moz/context", {"context":"content"})
                    except Exception:
                        pass
                eventually(lambda: execute(driver_base, session,
                    "return Boolean(document.querySelector('#edge-tts-toolbar'))"),
                    explanation="Firefox action shortcut did not inject reader toolbar")
                title = execute(driver_base, session,
                    "return document.querySelector('#edge-tts-toolbar').textContent")
                assert "Firefox TTS" in title, title
                focus = execute(driver_base, session, "return document.activeElement.id")
                assert focus == "editor", f"Reader stole focus from text editor: {focus}"
                print("PASS: Explicit action injected reader without focus theft")

                # Simulate the toolbar's own Quit button. No native engine needed.
                execute(driver_base, session,
                    "document.querySelector('#edge-tts-toolbar [data-edge-tts-action=quit]').click()")
                eventually(lambda: execute(driver_base, session,
                    "return document.querySelector('#edge-tts-toolbar') === null"),
                    explanation="Quit failed to remove reader UI")
                print("PASS: Quit tears down reader UI")
                print("PASS: Disposable Firefox smoke suite")
            except Exception:
                logs.flush()
                print("Geckodriver diagnostics (last 80 lines):", file=sys.stderr)
                if log_path.exists():
                    print("\n".join(log_path.read_text(errors="replace").splitlines()[-80:]),
                          file=sys.stderr)
                raise
            finally:
                if session:
                    try:
                        request(driver_base + f"/session/{session}", "DELETE", timeout=8)
                    except Exception:
                        pass
                driver.terminate()
                try:
                    driver.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    driver.kill()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
