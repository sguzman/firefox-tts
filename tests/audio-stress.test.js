const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background/audio.js"), "utf8");

function harness() {
  const urls = new Set(), sent = [], ticks = new Map(), pauses = new Map();
  let serial = 0, audio;
  const players = [];
  class FakeAudio {
    constructor() {
      this.currentTime = 0; this.volume = 1; this.playbackRate = 1;
      this.paused = true; audio = this; players.push(this);
    }
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
    setInterval(fn, ms) { const id = ++serial; ticks.set(id, { fn, ms }); return id; },
    clearInterval(id) { ticks.delete(id); },
    setTimeout(fn) { const id = ++serial; pauses.set(id, fn); return id; },
    clearTimeout(id) { pauses.delete(id); }
  });
  vm.runInContext(source, global);
  const player = global.FirefoxTtsBackground.player;
  const audioChunks = [Buffer.from("RIFF" + "x".repeat(250)).toString("base64")];
  return {
    player, sent, urls, ticks, pauses, audioChunks, players,
    get audio() { return audio; },
    tickAll() { for (const { fn } of [...ticks.values()]) fn(); },
    pauseAll() { for (const fn of [...pauses.values()]) fn(); },
    flushOnePause() {
      const first = pauses.entries().next().value;
      if (!first) return false;
      pauses.delete(first[0]);
      first[1]();
      return true;
    },
    timerDurations() { return [...ticks.values()].map(t => t.ms); }
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

test("1.8x and 2.0x reader WAVs use fresh clean-test-bench decoders with no overlap", async () => {
  const h = harness();
  for (const rate of [1.7, 1.8, 2.0]) {
    const first = msg("first-" + rate, h.audioChunks);
    first.playbackRate = rate;
    assert.equal((await h.player.handle(first, 15)).accepted, true);
    const former = h.audio;
    assert.equal(former.paused, false);
    assert.equal(former.preservesPitch, true);
    assert.equal(h.urls.size, 1);

    const second = msg("second-" + rate, h.audioChunks);
    second.playbackRate = rate;
    assert.equal((await h.player.handle(second, 15)).accepted, true);
    assert.notEqual(h.audio, former, "each WAV must start with a fresh Gecko decoder");
    assert.equal(former.paused, true, "old WAV must be stopped before new starts");
    assert.equal(former.src, "", "old decoder source must be released");
    assert.equal(h.audio.paused, false);
    assert.equal(h.audio.playbackRate, rate);
    assert.equal(h.players.filter(p => !p.paused).length, 1,
      "only one audio element can be playing");
    assert.equal(h.urls.size, 1, "no orphaned WAV blobs");
    assert.equal(h.player.stopTab(15), true);
    assert.equal(h.players.filter(p => !p.paused).length, 0);
  }
  assert.equal(h.urls.size, 0);
  assert.equal(h.ticks.size, 0);
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
  // Initial boundary for the *previous* owner is now intentionally sent on
  // audio start; after preemption its count must remain unchanged.
  const formerOwnerCount = h.sent.filter(e => e.tabId === 3 &&
    e.message.event?.type === "boundary").length;
  h.audio.currentTime = .8;
  h.tickAll();
  assert.equal(h.sent.filter(e => e.tabId === 3 &&
    e.message.event?.type === "boundary").length, formerOwnerCount);
  assert.ok(h.sent.some(e=>e.tabId===4 && e.message.event?.type==="boundary"));
  assert.equal(h.player.stopTab(4), true);
  assert.equal(h.urls.size, 0);
});

test("Long synthetic boundaries are bounded per tick; pausing disarms active clock", async () => {
  const h = harness();
  const offsets = Array.from({ length: 4000 }, (_, index) => index / 100);
  await h.player.handle(msg("long", h.audioChunks, offsets), 9);
  h.audio.currentTime = 10;
  const beforeTick = h.sent.filter(e => e.message.event?.type === "boundary").length;
  h.tickAll();
  const oneTick = h.sent.filter(e => e.message.event?.type === "boundary").length - beforeTick;
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

test("2x background playback matches clean test-bench gain, with no stepped attack", async () => {
  const h = harness();
  const high = msg("high-rate", h.audioChunks);
  high.playbackRate = 2;
  high.volume = .8;
  assert.equal((await h.player.handle(high, 12)).accepted, true);
  assert.equal(h.audio.volume, .8, "2x playback starts at normal volume; no initial mute");
  assert.deepEqual(h.timerDurations(), [16], "only the media boundary clock runs");

  const second = msg("high-rate-2", h.audioChunks);
  second.playbackRate = 2;
  second.volume = .8;
  assert.equal((await h.player.handle(second, 12)).accepted, true);
  assert.equal(h.audio.volume, .8, "second sentence does not repeat an audible gain staircase");
  assert.equal(h.ticks.size, 1);
  assert.equal(h.player.stopTab(12), true);
  assert.equal(h.ticks.size, 0);
  assert.equal(h.urls.size, 0);
  await h.player.handle(high, 12);
  await h.player.handle({ type: "EDGE_TTS_PIPER_OFFSCREEN_PAUSE",
    playbackId: "high-rate" }, 12);
  assert.equal(h.ticks.size, 0);
  const resumed = await h.player.handle({
    type: "EDGE_TTS_PIPER_OFFSCREEN_RESUME",
    playbackId: "high-rate"
  }, 12);
  assert.equal(resumed.accepted, true);
  assert.equal(h.audio.volume, .8, "Resume remains audible");
  h.player.stopAll();
  assert.equal(h.ticks.size, 0);
});

test("2x volume changes never install a gain-stepping timer", async () => {
  const h = harness();
  const fast = msg("volume", h.audioChunks);
  fast.playbackRate = 2;
  await h.player.handle(fast, 3);
  assert.deepEqual(h.timerDurations(), [16]);
  const update = await h.player.handle({
    type: "EDGE_TTS_PIPER_OFFSCREEN_VOLUME",
    playbackId: "volume",
    volume: .25
  }, 3);
  assert.equal(update.accepted, true);
  assert.equal(h.audio.volume, .25);
  assert.deepEqual(h.timerDurations(), [16]);
  h.player.stopAll();
});

test("first word highlighted immediately and 2x boundary timer is 16ms", async () => {
  const h = harness();
  const fast = msg("fast-clock", h.audioChunks, [0, .04, .09, .2]);
  fast.playbackRate = 2;
  await h.player.handle(fast, 17);
  const hits = h.sent.filter(x => x.message.event?.type === "boundary");
  assert.ok(hits.some(x => x.message.event.index === 0),
    "source boundary zero is never discarded during fresh playback");
  assert.ok(h.timerDurations().includes(16), "2x media clock uses a 16ms timer");
  h.audio.currentTime = .05;
  h.tickAll();
  assert.ok(h.sent.some(x => x.message.event?.type === "boundary" &&
    x.message.event.index === 1));
  const rate = await h.player.handle({
    type: "EDGE_TTS_PIPER_OFFSCREEN_RATE",
    playbackId: "fast-clock", playbackRate: 1
  }, 17);
  assert.equal(rate.accepted, true);
  assert.ok(h.timerDurations().includes(50));
  h.player.stopAll();
  assert.equal(h.timerDurations().length, 0);
});

test("extension audio emits clock progress between word boundaries", async () => {
  const h = harness();
  const request = msg("progress", h.audioChunks, [0, 10]);
  request.playbackRate = 2;
  assert.equal((await h.player.handle(request, 5)).accepted, true);
  h.audio.currentTime = .3;
  h.tickAll();
  h.audio.currentTime = .8;
  h.tickAll();
  const times = h.sent.filter(e => e.message.event?.type === "time")
    .map(e => e.message.event.currentTime);
  assert.ok(times.includes(.3));
  assert.ok(times.includes(.8));
  assert.equal(h.player.stopTab(5), true);
});

test("background seek fades to silence without cutting live WAV early", async () => {
  const h = harness();
  const input = msg("seek-wav", h.audioChunks);
  input.volume = .8;
  assert.equal((await h.player.handle(input, 5)).accepted, true);
  const audio = h.audio;
  const fading = h.player.handle({
    type: "EDGE_TTS_PIPER_OFFSCREEN_FADE_FOR_SEEK", playbackId: "seek-wav"
  }, 5);
  for (let step = 0; step < 6; step += 1) {
    assert.equal(h.flushOnePause(), true, "each gain step has a short timer");
    await Promise.resolve();
  }
  const result = await fading;
  assert.equal(result.accepted, true);
  assert.equal(audio.paused, false, "only caller's authoritative cancel stops audio");
  assert.ok(audio.volume <= 1e-9);
  assert.equal(h.player.stopTab(5), true);
});

test("background fade exits when hard Stop supersedes the old WAV", async () => {
  const h = harness();
  assert.equal((await h.player.handle(msg("old", h.audioChunks), 3)).accepted, true);
  const fading = h.player.handle({
    type: "EDGE_TTS_PIPER_OFFSCREEN_FADE_FOR_SEEK", playbackId: "old"
  }, 3);
  assert.equal(h.player.stopTab(3), true);
  assert.equal(h.flushOnePause(), true);
  assert.equal((await fading).accepted, false);
  assert.equal(h.urls.size, 0);
});
