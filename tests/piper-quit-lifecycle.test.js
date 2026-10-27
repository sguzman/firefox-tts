const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../src/content/linux-piper-engine.js"), "utf8"
);

function harness() {
  const players = [];
  const urls = new Set();
  let serial = 0;

  class FakeAudio {
    constructor() {
      this.paused = true;
      this.volume = 1;
      this.currentTime = 0;
      this.loadCount = 0;
      players.push(this);
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() { this.loadCount++; }
  }

  class Base {
    constructor(options = {}) {
      this.generation = 0;
      Object.assign(this, options);
    }
    clearPlaybackTimers() {}
    cancel() { this.generation++; }
    abandon() { this.generation++; }
  }

  const context = vm.createContext({
    EdgeTtsExtension: {
      SpeechEngine: { SpeechEngine: Base, createUtteranceChunks() { return []; } },
      TextModel: {},
      Pronunciation: {}
    },
    document: { createElement() { return new FakeAudio(); } },
    Audio: FakeAudio,
    Blob,
    Uint8Array,
    Map,
    Set,
    Promise,
    console,
    performance: { now() { return 0; } },
    URL: {
      createObjectURL() { const url = "blob:qa-" + ++serial; urls.add(url); return url; },
      revokeObjectURL(url) { urls.delete(url); }
    },
    requestAnimationFrame() { return ++serial; },
    cancelAnimationFrame() {},
    setTimeout() { return ++serial; },
    clearTimeout() {},
    module: { exports: {} }
  });
  vm.runInContext(source, context, { filename: "linux-piper-engine.js" });
  const Engine = context.module.exports.LinuxPiperSpeechEngine;

  function play(engine, chunkIndex = 0) {
    const payload = {
      sentenceFinal: true,
      segments: [{ text: "Sentence " + chunkIndex, segmentIndex: 0 }]
    };
    engine.directSessionMode = true;
    engine.currentChunks = [payload];
    engine.currentChunkIndex = 0;
    const prepared = {
      generation: engine.generation,
      chunkIndex: 0,
      audio: [new Uint8Array([82, 73, 70, 70])],
      audioBase64: [],
      payload,
      boundaries: [],
      boundariesArePrepared: true,
      prefetch: false
    };
    engine._playLinuxPiperPrepared(engine.generation, prepared);
    return players.at(-1);
  }

  return { Engine, play, players, urls };
}

for (const method of ["cancel", "abandon"]) {
  test(`Piper ${method} stops actual tab audio rather than just forgetting its session`, async () => {
    const h = harness();
    const engine = new h.Engine({});
    const audio = h.play(engine);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(audio.paused, false, "precondition: live Piper audio");
    assert.equal(h.urls.size, 1, "precondition: active WAV blob");

    engine[method]();

    assert.equal(audio.paused, true, "Quit/Stop must pause the live HTMLAudioElement");
    assert.equal(audio.src, "", "must release decoder source");
    assert.ok(audio.loadCount >= 1, "release browser media pipeline");
    assert.equal(engine.directAudio, null, "no orphaned media owner");
    assert.equal(engine.directSessionMode, false);
    assert.equal(h.urls.size, 0, "no leaked object URL");
    assert.equal(engine.currentChunks.length, 0);

    const resumed = h.play(engine, 1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resumed.paused, false);
    assert.equal(audio.paused, true, "old session must not overlap new session");
    assert.equal(h.players.filter(player => !player.paused).length, 1);
    engine.cancel();
    assert.equal(h.players.filter(player => !player.paused).length, 0);
    assert.equal(h.urls.size, 0);
  });
}

test("cancelling while play() promise is pending cannot revive a stale session", async () => {
  const h = harness();
  const engine = new h.Engine({});
  let resolveStart;
  const oldPlay = h.Engine.prototype;
  const audio = h.play(engine);
  // Emulate a late start completion: the promise from FakeAudio.play is
  // already pending when cancel retires its generation.
  engine.cancel();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(audio.paused, true);
  assert.equal(engine.directAudio, null);
  assert.equal(h.urls.size, 0);
  assert.equal(h.players.filter(player => !player.paused).length, 0);
});
