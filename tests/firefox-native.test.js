const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const audioSource = fs.readFileSync(path.join(root, "src/background/audio.js"), "utf8");
const nativeSource = fs.readFileSync(path.join(root, "src/background/native.js"), "utf8");

function makeHarness() {
  const sent = [];
  const outgoing = [];
  const nativeListeners = [];
  let runtimeListener, removeListener;
  let pendingAudio;
  class FakeAudio {
    constructor() { this.currentTime = 0; this.volume = 1; this.playbackRate = 1; pendingAudio = this; }
    async play() { this.paused = false; this.onplaying?.(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() { this.src = ""; }
  }
  const port = {
    onMessage: { addListener(fn) { nativeListeners.push(fn); } },
    onDisconnect: { addListener() {} },
    postMessage(value) {
      outgoing.push(value);
      if (value.type === "hello") queueMicrotask(() =>
        nativeListeners.forEach(fn => fn({ type: "hello", protocol: 1, platform: "linux", backend: "piper", cpuOnly: true })));
      if (value.type === "voices") queueMicrotask(() =>
        nativeListeners.forEach(fn => fn({ type: "voices", requestId: value.requestId,
          voices: [{ id: "en_US-amy-low", name: "Amy Low", lang: "en-US" }] })));
      if (value.type === "pronunciationConfigRead") queueMicrotask(() =>
        nativeListeners.forEach(fn => fn({ type: "pronunciationConfig",
          requestId: value.requestId, config: { revision: 5 }, path: "/isolated/config.json" })));
    },
    disconnect() {}
  };
  const browser = {
    tabs: {
      async sendMessage(tabId, message) { sent.push({ tabId, message }); return { accepted: true }; },
      onRemoved: { addListener(fn) { removeListener = fn; } }
    },
    runtime: {
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      connectNative(host) {
        assert.equal(host, "com.sguzman.firefox_tts.linux_piper");
        return port;
      },
      openOptionsPage: async () => {}
    }
  };
  let objectCount = 0;
  const urls = new Set();
  const url = {
    createObjectURL(blob) {
      assert.ok(blob.size > 0);
      const next = `blob:synthetic-${++objectCount}`;
      urls.add(next);
      return next;
    },
    revokeObjectURL(next) { urls.delete(next); }
  };
  const fakeBase64 = Buffer.from("synthetic WAV bytes").toString("base64");
  const context = vm.createContext({
    browser, Audio: FakeAudio, Blob, URL: url, atob,
    Uint8Array, setInterval: () => 11, clearInterval: () => {},
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    console, module: { exports: {} },
  });
  vm.runInContext(audioSource, context, { filename: "audio.js" });
  vm.runInContext(nativeSource, context, { filename: "native.js" });
  const native = context.module.exports;
  return {
    native, port, outgoing, sent, urls, fakeBase64,
    get audio() { return pendingAudio; },
    get player() { return context.FirefoxTtsBackground.player; },
    async message(type, data = {}, tabId = 3) {
      return runtimeListener({ type, ...data }, { tab: { id: tabId } });
    },
    remove(tabId) { removeListener(tabId); }
  };
}

test("Firefox native helper is lazy, offline and uses a separate host name", async () => {
  const h = makeHarness();
  assert.equal(h.outgoing.length, 0, "no native call on extension startup");
  const response = await h.message("EDGE_TTS_LINUX_PIPER_VOICES");
  assert.equal(response.voices[0].name, "Amy Low");
  assert.deepEqual(h.outgoing.map(x => x.type), ["hello", "voices"]);
  const backup = await h.message("EDGE_TTS_PRONUNCIATION_BACKUP_READ");
  assert.equal(backup.config.revision, 5);
  assert.equal(backup.path, "/isolated/config.json");
});

test("Native synth frames are forwarded only to owning tab with the original request id", async () => {
  const h = makeHarness();
  const result = await h.message("EDGE_TTS_LINUX_PIPER_SYNTHESIZE",
    { requestId: "reader-44", voiceId: "en_US-amy-low", text: "Hello Firefox." }, 44);
  assert.equal(result.accepted, true);
  const frame = h.outgoing.find(m => m.type === "synthesize");
  assert.equal(frame.voiceId, "en_US-amy-low");
  // Native helper retains its own request ID. Browser forwards the client ID.
  const listener = h.port.onMessage;
  assert.ok(listener);
  h.remove(44);
  assert.ok(h.outgoing.some(m => m.type === "cancel" && m.requestId === frame.requestId));
});

test("Cross-tab preemption and release do not give old tabs ownership", async () => {
  const h = makeHarness();
  assert.equal((await h.message("EDGE_TTS_AUDIO_CLAIM", {}, 4)).granted, true);
  assert.equal((await h.message("EDGE_TTS_AUDIO_CLAIM", {}, 5)).granted, true);
  assert.equal(h.native.audioOwnerTabId, 5);
  assert.ok(h.sent.some(e => e.tabId === 4 && e.message.type === "EDGE_TTS_AUDIO_PREEMPT"));
  assert.equal((await h.message("EDGE_TTS_AUDIO_RELEASE", {}, 4)).released, false);
  assert.equal((await h.message("EDGE_TTS_AUDIO_RELEASE", {}, 5)).released, true);
});

test("Firefox event-page WAV player enforces owner, revokes blobs and stops on tab close", async () => {
  const h = makeHarness();
  const result = await h.message("EDGE_TTS_PIPER_OFFSCREEN_PLAY", {
    playbackId: "p1", audioChunks: [h.fakeBase64],
    boundaryOffsets: [0, 0.15, 0.30], playbackRate: 1.2, volume: 0.7
  }, 6);
  assert.equal(result.accepted, true);
  assert.equal(h.player.getSession().tabId, 6);
  assert.equal(h.urls.size, 1);
  assert.equal(h.audio.playbackRate, 1.2);
  assert.equal(h.audio.volume, 0.7);
  assert.equal((await h.message("EDGE_TTS_PIPER_OFFSCREEN_PAUSE", { playbackId: "p1" }, 7)).accepted, false);
  assert.equal((await h.message("EDGE_TTS_PIPER_OFFSCREEN_PAUSE", { playbackId: "p1" }, 6)).accepted, true);
  assert.equal((await h.message("EDGE_TTS_PIPER_OFFSCREEN_RESUME", { playbackId: "p1" }, 6)).accepted, true);
  h.remove(6);
  assert.equal(h.player.getSession(), null);
  assert.equal(h.urls.size, 0);
  assert.ok(h.sent.some(e => e.tabId === 6 && e.message.event?.type === "stopped"));
});

test("Player rejects malformed chunk lists without allocating media", async () => {
  const h = makeHarness();
  const response = await h.message("EDGE_TTS_PIPER_OFFSCREEN_PLAY", {
    playbackId: "bad", audioChunks: ["!not-base64"]
  }, 3);
  assert.equal(response.accepted, false);
  assert.equal(h.urls.size, 0);
  assert.equal(h.player.getSession(), null);
});
