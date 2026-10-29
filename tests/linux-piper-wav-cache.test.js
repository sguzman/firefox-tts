const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {
  SpeechEngine: {
    SpeechEngine: class {},
    createUtteranceChunks() { return []; }
  },
  TextModel: {}
};
const { LinuxPiperSpeechEngine } = require("../src/content/linux-piper-engine.js");

function fixture() {
  const engine = Object.create(LinuxPiperSpeechEngine.prototype);
  engine.currentOptions = { voice: { voiceId: "en_US-amy-low" } };
  engine.directPlaybackRate = 1.8;
  engine.directSessionMode = true;
  engine.generation = 2;
  engine.currentChunkIndex = 0;
  engine.linuxPiperPrepared = new Map();
  engine.linuxPiperRequests = new Map();
  engine.linuxPiperWavCache = new Map();
  engine.linuxPiperWavCacheBytes = 0;
  const payload = {
    text: "The exact same clicked sentence.",
    starts: [0, 4, 10, 15, 23],
    segments: [],
    parts: null,
    configRevision: 4,
    configSavedAt: 100
  };
  engine.currentChunks = [payload];
  const audio = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 3]);
  const request = {
    payload,
    audio: [audio],
    audioBase64: ["UklGRgABAgM="],
    boundaries: [{ charIndex: 0, audioPositionMs: 0 }]
  };
  return { engine, payload, request, audio };
}

test("repeat seek reuses exactly identical WAV bytes with no native synthesis", () => {
  const { engine, request, audio } = fixture();
  engine._storeLinuxPiperCachedWav(request, 700);
  let playCount = 0;
  let played = [];
  engine._playLinuxPiperPrepared = (_generation, prepared) => {
    playCount += 1;
    played.push(prepared);
  };
  assert.equal(engine._startLinuxPiperSynthesis(2, 0), true);
  assert.equal(engine._startLinuxPiperSynthesis(2, 0), true);
  assert.equal(playCount, 2);
  assert.equal(played[0].audio[0], audio);
  assert.equal(played[0].audio[0], played[1].audio[0]);
  assert.equal(played[1].chunkIndex, 0);
  assert.equal(engine.linuxPiperRequests.size, 0);
});

test("cache keys separate voice, rate, and pronunciation revision", () => {
  const { engine, payload, request } = fixture();
  engine._storeLinuxPiperCachedWav(request, 700);
  assert.ok(engine._getLinuxPiperCachedPrepared(2, 0));
  engine.directPlaybackRate = 1.7;
  assert.equal(engine._getLinuxPiperCachedPrepared(2, 0), null);
  engine.directPlaybackRate = 1.8;
  engine.currentOptions.voice.voiceId = "en_US-ryan-high";
  assert.equal(engine._getLinuxPiperCachedPrepared(2, 0), null);
  engine.currentOptions.voice.voiceId = "en_US-amy-low";
  engine.currentChunks = [{ ...payload, configRevision: 5 }];
  assert.equal(engine._getLinuxPiperCachedPrepared(2, 0), null);
});

test("audio replay cache remains bounded with least-recently-used eviction", () => {
  const { engine, request } = fixture();
  for (let i = 0; i < 15; i += 1) {
    engine._storeLinuxPiperCachedWav({
      ...request,
      payload: { ...request.payload, text: "Phrase number " + i }
    }, 700);
  }
  assert.equal(engine.linuxPiperWavCache.size, 12);
  assert.equal(engine.linuxPiperWavCacheBytes, 12 * 20);
  engine.currentChunks = [{ ...request.payload, text: "Phrase number 0" }];
  assert.equal(engine._getLinuxPiperCachedPrepared(2, 0), null);
  engine.currentChunks = [{ ...request.payload, text: "Phrase number 14" }];
  assert.ok(engine._getLinuxPiperCachedPrepared(2, 0));
});

test("oversize WAV is not retained in the content-script cache", () => {
  const { engine, request } = fixture();
  const tooLarge = new Uint8Array(13 * 1024 * 1024);
  engine._storeLinuxPiperCachedWav({
    ...request, audio: [tooLarge], audioBase64: ["AA=="]
  }, 900);
  assert.equal(engine.linuxPiperWavCache.size, 0);
  assert.equal(engine.linuxPiperWavCacheBytes, 0);
});


test("native high-rate silent preroll shifts first highlight, including cached replay", () => {
  const { engine, request, audio } = fixture();
  const prerollMs = 96;
  const durationMs = 896;
  engine._storeLinuxPiperCachedWav(request, durationMs, prerollMs);
  const cached = engine._getLinuxPiperCachedPrepared(2, 0);
  assert.ok(cached);
  assert.equal(cached.audio[0], audio, "the original WAV is reused byte-for-byte");
  assert.equal(cached.boundariesArePrepared, true);
  assert.equal(cached.boundaries[0].offsetSeconds, 0.096);
  assert.equal(cached.boundaries[0].segment, undefined);
  const offsets = cached.boundaries.map(b => b.offsetSeconds);
  assert.ok(offsets.every(v => v >= .096), "speech must never highlight over preroll silence");
  assert.ok(offsets.at(-1) < .896, "last boundary belongs to speech, not pre-roll");
});

test("zero preroll retains original alignment for older installed native hosts", () => {
  const { engine, request } = fixture();
  engine._storeLinuxPiperCachedWav(request, 800);
  const cached = engine._getLinuxPiperCachedPrepared(2, 0);
  assert.equal(cached.boundaries[0].offsetSeconds, 0);
});
