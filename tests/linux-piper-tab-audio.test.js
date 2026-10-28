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
    assert.equal(second.playbackRate, 2);
    assert.equal(elements.length, 2);
  } finally {
    engine.directAudio?.pause();
  }
});

test.after(() => {
  global.URL = originalURL;
  global.Blob = originalBlob;
});
