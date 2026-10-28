const test = require("node:test");
const assert = require("node:assert/strict");

class FakeText {}
class FakeElement {}
global.Text = FakeText;
global.Element = FakeElement;
const segment = { blockIndex: 0, segmentIndex: 1, text: "Clicked" };
global.EdgeTtsExtension = {
  TextModel: {
    buildReadableModel() {}, findSegmentInNode() { return segment; },
    firstBlockNearViewport() {}, relocateCursorAfterRebuild() {},
    relocateSegmentByLocalContext() {}, segmentIsLive() { return true; }
  },
  Highlighter: {
    DEFAULT_SENTENCE_COLOR: "#fff", DEFAULT_WORD_COLOR: "#fff",
    Highlighter: class {}, normalizeColor(value) { return value; }
  },
  SpeechEngine: { SpeechEngine: class {}, createSpeechBatch() {} },
  Toolbar: { Toolbar: class {} }
};
require("../src/content/reader.js");
const { ReaderApp } = global.EdgeTtsExtension.Reader;

function makeReader(events, fade) {
  const node = new FakeText();
  const block = { index: 0, segments: [segment] };
  const app = Object.create(ReaderApp.prototype);
  Object.assign(app, {
    enabled: true, stopped: true, paused: false, quitRequested: false,
    settings: { clickToSeek: true }, modelStale: false,
    model: { nodeToBlock: new Map([[node, block]]) },
    caretFromPoint() { return { node, offset: 1 }; },
    retireStaleReaderGeneration() { return false; },
    lifecycleSerial: 0, audioClaimSerial: 0, audioOwner: false,
    highlighter: { clear() { events.push("clear"); } },
    toolbar: { setPaused() {}, setStatus() {} },
    speech: { fadeOutForSeek() { events.push("fade"); return fade(); } },
    clearResumeWatchdog() {},
    discardLocalSpeechState() { events.push("cancel"); },
    forceStopTabAudio() { events.push("stop"); return Promise.resolve(); },
    claimAudioOwnership() { events.push("claim"); return Promise.resolve(true); },
    speakCurrentPosition() { events.push("speak"); }
  });
  return app;
}
function click() {
  return { target: { closest() { return null; } }, clientX: 1, clientY: 2,
    preventDefault() {}, stopImmediatePropagation() {} };
}

test("text seek waits for audio fade before hard stop, including stopped reader", async () => {
  const events = [];
  let finishFade;
  const fading = new Promise(resolve => { finishFade = resolve; });
  const app = makeReader(events, () => fading);
  const seeking = app.handlePageClick(click());
  assert.deepEqual(events, ["fade"], "audio must not be cut before taper");
  finishFade(true);
  await seeking;
  assert.deepEqual(events, ["fade", "cancel", "clear", "stop", "claim", "speak"]);
  assert.equal(app.currentSegmentIndex, 1);
});

test("only latest click can cancel and restart transport during overlapping fades", async () => {
  const events = [];
  let finishOldFade;
  let calls = 0;
  const app = makeReader(events, () => {
    calls += 1;
    return calls === 1
      ? new Promise(resolve => { finishOldFade = resolve; })
      : Promise.resolve(true);
  });
  const older = app.handlePageClick(click());
  const newer = app.handlePageClick(click());
  await newer;
  finishOldFade(true);
  await older;
  assert.equal(events.filter(e => e === "cancel").length, 1);
  assert.equal(events.filter(e => e === "speak").length, 1);
});
