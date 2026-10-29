const { test } = require("node:test");
const assert = require("node:assert/strict");

const elements = [];
class FakeAudio {
  constructor() {
    this.currentTime = 0;
    this.paused = true;
    this.duration = 1;
    this.volume = 1;
    elements.push(this);
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() {}
}

global.EdgeTtsExtension = {
  SpeechEngine: {
    SpeechEngine: class {},
    createUtteranceChunks() { return []; }
  },
  TextModel: {}
};
global.document = { createElement(name) {
  assert.equal(name, "audio");
  return new FakeAudio();
} };
const originalURL = global.URL;
global.URL = {
  createObjectURL() { return "blob:synthetic-test"; },
  revokeObjectURL() {}
};
const originalBlob = global.Blob;
global.Blob = class SyntheticBlob {
  constructor(parts, options) { this.parts = parts; this.type = options.type; }
};

const { LinuxPiperSpeechEngine } = require("../src/content/linux-piper-engine.js");

test("2x page-owned reader creates a new decoder for each WAV, releasing old media", async () => {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  Object.assign(engine, {
    generation: 5,
    currentChunkIndex: 0,
    linuxPiperPlaybackIndex: -1,
    linuxPiperUseExtensionAudio: false,
    directAudio: null,
    directObjectUrl: "",
    directPlaybackRate: 2,
    directOutputGain: 1,
    requestedAt: 0,
    currentOptions: { sentencePauseMs: 0 },
    directBoundaries: [],
    directBoundaryIndex: 0
  });
  for (const name of [
    "_clearLinuxPiperProgressWatchdog", "_startLinuxPiperBoundaryClock",
    "_armLinuxPiperProgressWatchdog", "_fillLinuxPiperPrefetch",
    "_clearBoundaryClock", "onStatus", "onStart", "onBoundary"
  ]) engine[name] = () => {};

  function prepared(index) {
    return {
      generation: 5,
      chunkIndex: index,
      nativeTempoApplied: true,
      payload: { segments: [{ text: "Word.", blockIndex: 0, segmentIndex: index }] },
      audio: [new Uint8Array([0, 0])],
      boundaries: [],
      boundariesArePrepared: true,
      prefetch: false
    };
  }

  try {
    engine._playLinuxPiperPrepared(5, prepared(0));
    const first = engine.directAudio;
    assert.equal(first.paused, false);
    engine.currentChunkIndex = 1;
    engine._playLinuxPiperPrepared(5, prepared(1));
    const second = engine.directAudio;
    await Promise.resolve();
    assert.notEqual(first, second, "never reuse tab-owned media across WAVs");
    assert.equal(first.paused, true, "previous WAV must be retired");
    assert.equal(first.src, "", "previous decoder source must be removed");
    assert.equal(second.paused, false);
    assert.equal(second.playbackRate, 1,
      "2x content must already be accelerated by CPU FFmpeg");
    assert.equal(elements.length, 2);
  } finally {
    engine.directAudio?.pause();
  }
});


test("native-accelerated 1.8x WAV always plays at 1x in the Firefox tab", async () => {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  Object.assign(engine, {
    generation: 8, currentChunkIndex: 0, linuxPiperPlaybackIndex: -1,
    linuxPiperUseExtensionAudio: false, directAudio: null, directObjectUrl: "",
    directPlaybackRate: 1.8, directOutputGain: 1, requestedAt: 0,
    directBoundaries: [], directBoundaryIndex: 0,
    currentOptions: { sentencePauseMs: 0 }
  });
  for (const name of [
    "_clearLinuxPiperProgressWatchdog", "_startLinuxPiperBoundaryClock",
    "_armLinuxPiperProgressWatchdog", "_fillLinuxPiperPrefetch",
    "_clearBoundaryClock", "onStatus", "onStart", "onBoundary"
  ]) engine[name] = () => {};
  engine._playLinuxPiperPrepared(8, {
    generation: 8, chunkIndex: 0, nativeTempoApplied: true,
    payload: { segments: [{ text: "Accelerated." }] },
    audio: [new Uint8Array([0, 0])], boundaries: [],
    boundariesArePrepared: true, prefetch: false
  });
  assert.equal(engine.directPlaybackRate, 1.8,
    "requested speed remains available for synthesizing the next WAV");
  assert.equal(engine.directMediaPlaybackRate, 1,
    "the time-stretched WAV must never pass through Gecko's high-rate playback");
  assert.equal(engine.directAudio.playbackRate, 1);
  engine.directAudio.pause();
});

test("outdated native host cannot silently feed 1.8x WAV to Gecko", () => {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  engine.generation = 31;
  engine.currentChunkIndex = 0;
  engine.directPlaybackRate = 1.8;
  let failed = "";
  engine._failLinuxPiper = message => { failed = message; };
  const before = elements.length;
  engine._playLinuxPiperPrepared(31, {
    generation: 31, chunkIndex: 0, nativeTempoApplied: false,
    payload: { segments: [{ text: "Word" }] }, audio: [new Uint8Array([0, 0])]
  });
  assert.match(failed, /Re-run: bash native\/linux-piper\/install-native-host\.sh/);
  assert.equal(elements.length, before, "outdated high-rate audio must not play");
});

test("speed changes require native resynthesis, not a second Gecko time-stretch", () => {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  engine.directSessionMode = true;
  assert.equal(engine.setPlaybackRate(2), false);
});
test("click-to-seek tapers a playing page WAV to silence before hard cancellation", async () => {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  const audio = new FakeAudio();
  audio.paused = false;
  audio.volume = .75;
  engine.directSessionMode = true;
  engine.linuxPiperOffscreenPlayback = null;
  engine.directAudio = audio;
  const faded = await engine.fadeOutForSeek();
  assert.equal(faded, true);
  assert.equal(audio.paused, false, "do not hard-cut the WAV during taper");
  assert.ok(audio.volume <= 1e-9, "audio must reach silence before cancel");
  assert.equal(elements.at(-1), audio);
});

test("click-to-seek skips taper when no audio is playing", async () => {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  engine.directSessionMode = true;
  engine.linuxPiperOffscreenPlayback = null;
  engine.directAudio = new FakeAudio();
  assert.equal(await engine.fadeOutForSeek(), false);
});

test.after(() => {
  global.URL = originalURL;
  global.Blob = originalBlob;
});
