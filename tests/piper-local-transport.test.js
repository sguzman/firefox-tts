const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/content/linux-piper-engine.js"), "utf8");

function create() {
  const revoked = [], cancelledFrames = [], stopped = [];
  class FakeBase {
    constructor() {
      this.currentChunks = [];
      this.currentChunkIndex = 0;
      this.currentOptions = {};
      this.currentUtterance = null;
    }
    clearPlaybackTimers() { stopped.push("timers"); }
  }
  const global = vm.createContext({
    EdgeTtsExtension: {
      TextModel: {},
      Pronunciation: {},
      SpeechEngine: { SpeechEngine: FakeBase, createUtteranceChunks() {} }
    },
    URL: { revokeObjectURL(url) { revoked.push(url); } },
    cancelAnimationFrame(id) { cancelledFrames.push(id); },
    console, module: { exports: {} }, Promise, Set, Map
  });
  vm.runInContext(source, global);
  const Klass = global.module.exports.LinuxPiperSpeechEngine;
  return { engine: new Klass({}), revoked, cancelledFrames, stopped };
}

test("offline Piper has self-contained URL, RAF and cleanup methods without Edge DirectAudio", () => {
  const { engine, revoked, cancelledFrames, stopped } = create();
  assert.equal(typeof engine._revokeObjectUrl, "function");
  assert.equal(typeof engine._clearBoundaryClock, "function");
  assert.equal(typeof engine._resetDirectState, "function");
  let paused = 0, removed = 0, loaded = 0;
  engine.directSessionMode = true;
  engine.directObjectUrl = "blob:synthetic";
  engine.directBoundaryFrame = 9;
  engine.directAudio = {
    pause() { paused++; },
    removeAttribute(name) { if(name==="src") removed++; },
    load() { loaded++; }
  };
  engine.directBoundaries = [{ offsetSeconds:0.1 }];
  engine.directActive = true;
  engine.currentChunks = ["synthetic"];
  engine._resetDirectState({ keepMode: true });
  assert.deepEqual(revoked, ["blob:synthetic"]);
  assert.deepEqual(cancelledFrames, [9]);
  assert.equal(stopped.length, 1);
  assert.equal(paused, 1);
  assert.equal(removed, 1);
  assert.equal(loaded, 1);
  assert.equal(engine.directSessionMode, true);
  assert.equal(engine.directObjectUrl, "");
  assert.equal(engine.directAudio, null);
  assert.equal(engine.directBoundaryFrame, null);
  assert.equal(engine.currentChunks.length, 0);
  engine._resetDirectState({ keepMode: false });
  assert.equal(engine.directSessionMode, false);
  assert.equal(revoked.length, 1, "one URL must be revoked only once");
});

test("Piper failure resets local transport and emits original error, never a cleanup exception", () => {
  const { engine } = create();
  const errors = [];
  engine.onError = error => errors.push(error.message);
  engine.currentChunks = [{ text:"hello" }];
  engine.currentChunkIndex = 0;
  engine.generation = 1;
  engine.directSessionMode = true;
  assert.doesNotThrow(() => engine._failLinuxPiper("native model missing"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /native model missing/);
  assert.equal(engine.currentChunks.length, 0);
});
