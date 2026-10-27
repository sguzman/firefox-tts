const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background/audio.js"), "utf8");

function harness() {
  const urls = new Set(), sent = [], ticks = new Map(), pauses = new Map();
  let serial = 0, audio;
  class FakeAudio {
    constructor() { this.currentTime = 0; this.volume = 1; this.playbackRate = 1; audio = this; }
    play() {
      if (this.failNextPlay) {
        this.failNextPlay = false;
        return Promise.reject(new Error("QA synthetic autoplay blocked"));
      }
      this.paused = false;
      this.onplaying?.();
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name) { if (name === "src") this.src = ""; }
  }
  const global = vm.createContext({
    Audio: FakeAudio, Blob, Uint8Array, atob, console,
    browser: { tabs: { sendMessage(tabId, message) {
      sent.push({ tabId, message }); return Promise.resolve();
    } } },
    URL: {
      createObjectURL() { const name = "blob:fake-" + (++serial); urls.add(name); return name; },
      revokeObjectURL(name) { urls.delete(name); }
    },
    setInterval(fn) { const id = ++serial; ticks.set(id, fn); return id; },
    clearInterval(id) { ticks.delete(id); },
    setTimeout(fn) { const id = ++serial; pauses.set(id, fn); return id; },
    clearTimeout(id) { pauses.delete(id); }
  });
  vm.runInContext(source, global);
  const player = global.FirefoxTtsBackground.player;
  const audioChunks = [Buffer.from("RIFF" + "x".repeat(250)).toString("base64")];
  return {
    player, sent, urls, ticks, pauses, audioChunks,
    get audio() { return audio; },
    tickAll() { for (const fn of [...ticks.values()]) fn(); },
    pauseAll() { for (const fn of [...pauses.values()]) fn(); }
  };
}

function msg(playbackId, chunks, boundaries = [0, .1, .3]) {
  return { type:"EDGE_TTS_PIPER_OFFSCREEN_PLAY", playbackId,
    audioChunks: chunks, boundaryOffsets: boundaries,
    playbackRate: 1, volume: .5, sentencePauseMs: 0 };
}

test("150 rapid cross-tab play/stop cycles release every blob and timer", async () => {
  const h = harness();
  for (let i = 0; i < 150; i++) {
    const tabId = i % 3 + 1;
    const result = await h.player.handle(msg("batch-" + i, h.audioChunks), tabId);
    assert.equal(result.accepted, true);
    assert.equal(h.urls.size, 1);
    assert.equal(h.ticks.size, 1);
    assert.equal(h.player.stopTab(tabId), true);
    assert.equal(h.urls.size, 0);
    assert.equal(h.ticks.size, 0);
    assert.equal(h.pauses.size, 0);
    assert.equal(h.player.getSession(), null);
  }
});

test("Superseding old playback prevents stale owner emissions and cleans media", async () => {
  const h = harness();
  await h.player.handle(msg("old", h.audioChunks), 3);
  assert.equal(h.urls.size, 1);
  await h.player.handle(msg("new", h.audioChunks), 4);
  assert.equal(h.urls.size, 1);
  h.audio.currentTime = .5;
  h.tickAll();
  assert.equal(h.player.getSession().id, "new");
  assert.equal(h.player.getSession().tabId, 4);
  assert.equal(h.player.stopTab(3), false);
  assert.ok(!h.sent.some(e=>e.tabId===3 && e.message.event?.type==="boundary"));
  assert.ok(h.sent.some(e=>e.tabId===4 && e.message.event?.type==="boundary"));
  assert.equal(h.player.stopTab(4), true);
  assert.equal(h.urls.size, 0);
});

test("Long synthetic boundaries are bounded per tick; pausing disarms active clock", async () => {
  const h = harness();
  const offsets = Array.from({ length: 4000 }, (_, index) => index / 100);
  await h.player.handle(msg("long", h.audioChunks, offsets), 9);
  h.audio.currentTime = 10;
  h.tickAll();
  const oneTick = h.sent.filter(e => e.message.event?.type === "boundary").length;
  assert.ok(oneTick <= 40, "one event-loop tick may emit at most 40 word events");
  for (let i = 0; i < 30; i++) {
    const paused = await h.player.handle({ type:"EDGE_TTS_PIPER_OFFSCREEN_PAUSE",
      playbackId:"long" }, 9);
    assert.equal(paused.accepted, true);
    assert.equal(h.ticks.size, 0);
    const resumed = await h.player.handle({ type:"EDGE_TTS_PIPER_OFFSCREEN_RESUME",
      playbackId:"long" }, 9);
    assert.equal(resumed.accepted, true);
    assert.equal(h.ticks.size, 1);
  }
  h.player.stopAll();
  assert.equal(h.ticks.size, 0);
  assert.equal(h.urls.size, 0);
});

test("A newly constructed event page begins without the old audio session", async () => {
  const old = harness();
  await old.player.handle(msg("old-generation", old.audioChunks), 7);
  // Browser unload must destroy the previous page; a fresh event-page scope
  // must never resurrect a session merely because another tab once played.
  const fresh = harness();
  assert.equal(fresh.player.getSession(), null);
  assert.equal(fresh.urls.size, 0);
  old.player.stopAll();
});

test("background WAV player survives autoplay denial and explicit resume", async () => {
  const h = harness();
  await h.player.handle(msg("autoplay", h.audioChunks), 11);
  const paused = await h.player.handle({
    type:"EDGE_TTS_PIPER_OFFSCREEN_PAUSE", playbackId:"autoplay"
  }, 11);
  assert.equal(paused.accepted, true);
  assert.equal(h.ticks.size, 0);
  h.audio.failNextPlay = true;
  const blocked = await h.player.handle({
    type:"EDGE_TTS_PIPER_OFFSCREEN_RESUME", playbackId:"autoplay"
  }, 11);
  assert.equal(blocked.accepted, false);
  assert.match(blocked.error, /autoplay blocked/);
  assert.equal(h.player.getSession().paused, true);
  assert.equal(h.ticks.size, 0, "blocked media must not keep an active timer");
  const resumed = await h.player.handle({
    type:"EDGE_TTS_PIPER_OFFSCREEN_RESUME", playbackId:"autoplay"
  }, 11);
  assert.equal(resumed.accepted, true);
  assert.equal(h.player.getSession().paused, false);
  assert.equal(h.ticks.size, 1);
  h.player.stopAll();
  assert.equal(h.urls.size, 0);
  assert.equal(h.ticks.size, 0);
});

test("high-speed extension audio ramps output after decoder starts and clears on Stop", async () => {
  const h = harness();
  const high = msg("high-rate", h.audioChunks);
  high.playbackRate = 1.9;
  high.volume = .8;
  assert.equal((await h.player.handle(high, 12)).accepted, true);
  assert.equal(h.audio.volume, 0, "start high-speed output muted until decoder starts");
  assert.equal(h.ticks.size, 2, "one word clock and one short fade timer");
  h.tickAll();
  assert.equal(h.audio.volume, .2);
  h.tickAll();
  h.tickAll();
  h.tickAll();
  assert.equal(h.audio.volume, .8);
  assert.equal(h.ticks.size, 1, "fade timer expires after 32 ms");

  const second = msg("high-rate-2", h.audioChunks);
  second.playbackRate = 1.9;
  second.volume = .8;
  await h.player.handle(second, 12);
  assert.equal(h.ticks.size, 2);
  assert.equal(h.audio.volume, 0);
  assert.equal(h.player.stopTab(12), true);
  assert.equal(h.audio.paused, true);
  assert.equal(h.ticks.size, 0, "Quit clears both playback and fade timers");
  assert.equal(h.urls.size, 0);

  // Pause during the first 32ms must not cause Resume to stay silent.
  await h.player.handle(high, 12);
  await h.player.handle({ type:"EDGE_TTS_PIPER_OFFSCREEN_PAUSE",
    playbackId:"high-rate" }, 12);
  assert.equal(h.ticks.size, 0);
  const resumed = await h.player.handle({ type:"EDGE_TTS_PIPER_OFFSCREEN_RESUME",
    playbackId:"high-rate" }, 12);
  assert.equal(resumed.accepted, true);
  assert.equal(h.audio.volume, .8);
  h.player.stopAll();
  assert.equal(h.ticks.size, 0);
});

