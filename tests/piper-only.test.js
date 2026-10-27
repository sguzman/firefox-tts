const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const fakePiper = { name: "Amy Low", lang: "en-US", voiceId: "en_US-amy-low",
  __edgeTtsSource: "linux-piper" };
const remote = { name: "Online Natural", lang: "en-US", localService: false, remote: true };

test("Firefox voice UI excludes all non-Piper classes and retains search", () => {
  const context = vm.createContext({ module: { exports: {} }, console });
  vm.runInContext(read("src/content/voice-ui.js"), context);
  const api = context.module.exports;
  assert.equal(api.voiceLabel(fakePiper), "[PIPER] Amy Low — en-US");
  assert.equal(api.voiceClass(remote), "unsupported");
  const choices = api.filterVoicesByClass([remote, fakePiper], "amy");
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name, "Amy Low");
  assert.equal(api.filterVoicesByClass([remote, fakePiper], "", "online").length, 0);
});

test("Piper engine ignores any browser/remote voice catalog", () => {
  class Base {
    constructor() {}
    getVoices() { return [remote]; }
    onVoicesChanged() { throw new Error("Browser voiceschanged must not be subscribed"); }
  }
  const context = vm.createContext({
    EdgeTtsExtension: {
      SpeechEngine: { SpeechEngine: Base, createUtteranceChunks() {} },
      TextModel: {},
      Pronunciation: {}
    },
    console, module: { exports: {} },
    Promise, Set, Map
  });
  vm.runInContext(read("src/content/linux-piper-engine.js"), context);
  const { LinuxPiperSpeechEngine } = context.module.exports;
  const engine = new LinuxPiperSpeechEngine({});
  engine.linuxPiperVoices = [fakePiper];
  const result = engine.getVoices();
  assert.equal(result.length, 1);
  assert.equal(result[0].voiceId, "en_US-amy-low");
  let callbacks = 0;
  const off = engine.onVoicesChanged(() => callbacks++);
  assert.equal(engine.linuxPiperVoiceListeners.size, 1);
  off();
  assert.equal(engine.linuxPiperVoiceListeners.size, 0);
});

test("Reader selection rejects remote voices even when an adapter accidentally returns them", () => {
  class FakeSpeech {
    constructor() {}
    onVoicesChanged() { return () => {}; }
    chooseVoices() { return [remote, fakePiper]; }
  }
  class FakeToolbar {
    setVoices(voices) { this.voices = voices; }
    setRate() {}
  }
  const context = vm.createContext({
    EdgeTtsExtension: {
      TextModel: {},
      Highlighter: { DEFAULT_SENTENCE_COLOR: "#fff", DEFAULT_WORD_COLOR: "#fff",
        Highlighter: class {}, normalizeColor: c => c },
      SpeechEngine: { SpeechEngine: FakeSpeech, createSpeechBatch() {} },
      Toolbar: { Toolbar: FakeToolbar }
    },
    document: { documentElement: { lang: "en" } },
    navigator: { language: "en-US" },
    console
  });
  vm.runInContext(read("src/content/reader.js"), context);
  const app = new context.EdgeTtsExtension.Reader.ReaderApp();
  app.refreshVoices();
  assert.equal(app.voices.length, 1);
  assert.equal(app.selectedVoice.voiceId, "en_US-amy-low");
  assert.equal(app.toolbar.voices.length, 1);
});

test("Active injected Firefox sources do not depend on Windows or Chromium offscreen APIs", () => {
  const action = read("src/background/action.js");
  const files = [...action.matchAll(/"src\/content\/[^"]+\.js"/g)].map(m => m[0].slice(1, -1));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const content = read(file);
    assert.ok(!content.includes("chrome.tts"), file + " uses Chromium tts");
    assert.ok(!content.includes("chrome.offscreen"), file + " uses Chromium offscreen");
    assert.ok(!content.includes("NaturalVoiceSAPIAdapter"), file + " uses Windows SAPI");
  }
  assert.ok(!files.includes("src/content/win-natural-engine.js"));
  assert.ok(!files.includes("src/content/direct-audio-engine.js"));
});

test("Piper voice preferences pick Amy Low by default and explicitly saved Ryan", () => {
  const amy = fakePiper;
  const ryan = { name: "Ryan High", lang: "en-US", voiceId: "en_US-ryan-high",
    __edgeTtsSource: "linux-piper" };
  class Speech {
    onVoicesChanged() { return () => {}; }
    chooseVoices() { return [ryan, remote, amy]; }
  }
  class Toolbar {
    setVoices(voices) { this.voices = voices; }
    setRate() {}
  }
  const context = vm.createContext({
    EdgeTtsExtension: {
      TextModel: {},
      Highlighter: { DEFAULT_SENTENCE_COLOR:"#fff", DEFAULT_WORD_COLOR:"#fff",
        Highlighter: class {}, normalizeColor: c => c },
      SpeechEngine: { SpeechEngine: Speech, createSpeechBatch() {} },
      Toolbar: { Toolbar }
    },
    document: { documentElement: { lang: "en-US" } },
    navigator: { language: "en-US" }, console
  });
  vm.runInContext(read("src/content/reader.js"), context);
  const app = new context.EdgeTtsExtension.Reader.ReaderApp();
  app.refreshVoices();
  assert.equal(app.selectedVoice.voiceId, "en_US-amy-low");
  assert.equal(app.voices.length, 2);
  app.settings.voiceSource = "linux-piper";
  app.settings.voiceId = "en_US-ryan-high";
  app.settings.voiceName = "Ryan High";
  app.refreshVoices();
  assert.equal(app.selectedVoice.voiceId, "en_US-ryan-high");
  assert.ok(!app.toolbar.voices.some(v => v.remote === true));
});
