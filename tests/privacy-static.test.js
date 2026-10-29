const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

function sources(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(current, files);
    else if (entry.isFile() && /\.(js|html)$/.test(entry.name)) files.push(current);
  }
  return files;
}

test("Firefox permission model is explicit and no page-wide access is granted", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "nativeMessaging", "scripting", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.id, "firefox-tts@sguzman.dev");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
});

test("Bundled JS cannot introduce network reporting, eval or runtime downloads", () => {
  const forbidden = [
    /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
    /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\s*\(/,
    /\beval\s*\(/, /\bnew\s+Function\s*\(/
  ];
  for (const file of sources(path.join(ROOT, "src"))) {
    const data = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(data), `${path.relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

test("CPU-local native helper has no HTTP clients or bootstrap packages", () => {
  const host = fs.readFileSync(path.join(ROOT, "native/linux-piper/linux_piper_host.py"), "utf8");
  assert.match(host, /CUDA_VISIBLE_DEVICES/);
  assert.match(host, /use_cuda=False/);
  assert.match(host, /FIREFOX_TTS_DATA_HOME/);
  for (const forbidden of [/import requests\b/, /import urllib\b/, /import http\b/,
                           /import socket\b/, /os\.system\(/]) {
    assert.ok(!forbidden.test(host), `native helper contains prohibited action ${forbidden}`);
  }
  // Offline FFmpeg atempo is the one permitted local subprocess.
  // It is argv-based (no shell), needs no network, and changes no voice models.
  assert.equal((host.match(/subprocess\.run\(/g) || []).length, 1);
  assert.match(host, /ffmpeg = shutil\.which\("ffmpeg"\)/);
  assert.match(host, /command = \[\s*ffmpeg,/);
  assert.ok(!/shell\s*=\s*True/.test(host));
  const manifestJSON = fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8");
  assert.ok(!manifestJSON.includes("https://"), "No network host permissions or servers");
});
