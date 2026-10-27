const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, name), "utf8");

function fixture() {
  const highlights = new Map();
  const createdRanges = [];
  class Text {
    constructor(value) {
      this.nodeValue = value;
      this.isConnected = true;
      this.parentElement = { scrollIntoView() { throw new Error("No scroll expected"); } };
    }
  }
  class Element {
    constructor(editable = false) { this.editable = editable; }
    closest(selector) {
      if (selector === "[data-edge-tts-ui]") return null;
      return this.editable && selector.includes("textarea") ? this : null;
    }
    get isContentEditable() { return this.editable; }
  }
  class Highlight {
    constructor(...ranges) { this.ranges = ranges; this.priority = 0; }
  }
  const document = {
    documentElement: { lang: "en-US", appendChild(el) { el.isConnected = true; } },
    getElementById() { return null; },
    createElement(tag) {
      assert.equal(tag, "style");
      return { dataset: {}, isConnected: false, textContent: "" };
    },
    createRange() {
      const range = {
        setStart(node, offset) { this.startNode = node; this.start = offset; },
        setEnd(node, offset) { this.endNode = node; this.end = offset; },
        getBoundingClientRect() { throw new Error("Unexpected layout read"); }
      };
      createdRanges.push(range);
      return range;
    }
  };
  const context = vm.createContext({
    EdgeTtsExtension: { TextModel: {
      segmentIsLive(segment) {
        const s = String(segment?.node?.nodeValue || "");
        return Boolean(segment?.node?.isConnected) &&
          s.slice(segment.nodeStart, segment.nodeEnd) === segment.text;
      }
    } },
    document, Text, Element, Highlight,
    CSS: { highlights },
    performance: { now: () => 1000 }, console
  });
  vm.runInContext(source("src/content/highlighter.js"), context);
  return {
    context, Text, Element, document, highlights, createdRanges,
    api: context.EdgeTtsExtension.Highlighter
  };
}
function segment(node, text, start, index, sentenceIndex = 0) {
  return { node, text, nodeStart: start, nodeEnd: start + text.length,
    blockIndex: 0, segmentIndex: index, sentenceIndex };
}

test("CSS Highlights preserve exact DOM text offsets and original node identity", () => {
  const f = fixture();
  const node = new f.Text("One two three");
  const one = segment(node, "One", 0, 0);
  const two = segment(node, "two", 4, 1);
  const three = segment(node, "three", 8, 2);
  const block = { sentences: [{ segments: [one, two, three] }] };
  const h = new f.api.Highlighter();
  h.setAutoScroll(false);
  assert.equal(h.highlight(block, two), true);
  const word = f.highlights.get("edge-tts-current-word");
  assert.equal(word.priority, 2);
  assert.equal(word.ranges[0].startNode, node);
  assert.equal(word.ranges[0].start, 4);
  assert.equal(word.ranges[0].end, 7);
  const sentence = f.highlights.get("edge-tts-current-sentence");
  assert.equal(sentence.priority, 1);
  assert.equal(sentence.ranges[0].start, 0);
  assert.equal(sentence.ranges[0].end, 13);
  assert.equal(node.nodeValue, "One two three", "must not wrap/mutate page text");
  assert.equal(f.createdRanges.length, 2);
});

test("Detached and rewritten nodes are rejected without destroying last good highlight", () => {
  const f = fixture();
  const node = new f.Text("Hello world");
  const hello = segment(node, "Hello", 0, 0);
  const world = segment(node, "world", 6, 1);
  const block = { sentences: [{ segments: [hello, world] }] };
  const h = new f.api.Highlighter();
  h.setAutoScroll(false);
  assert.equal(h.highlight(block, hello), true);
  const originalWord = f.highlights.get("edge-tts-current-word");
  node.nodeValue = "Hello changed";
  assert.equal(h.highlight(block, world), false);
  assert.equal(f.highlights.get("edge-tts-current-word"), originalWord);
  node.isConnected = false;
  assert.equal(h.highlight(block, hello), false);
  assert.equal(f.highlights.get("edge-tts-current-word"), originalWord);
  h.clear();
  assert.equal(f.highlights.size, 0);
});

test("Click-to-seek ignores editable inputs; accepted click maps exact segment without focus", async () => {
  const f = fixture();
  let seekStarted = 0, preventions = 0, stops = 0;
  const node = new f.Text("Alpha beta");
  const first = segment(node, "Alpha", 0, 0);
  const second = segment(node, "beta", 6, 1);
  const block = { index: 0, segments: [first, second] };
  f.context.EdgeTtsExtension.TextModel = {
    ...f.context.EdgeTtsExtension.TextModel,
    findSegmentInNode(_block, _node, off) { return off >= 6 ? second : first; }
  };
  f.context.EdgeTtsExtension.SpeechEngine = {
    SpeechEngine: class {
      onVoicesChanged() { return () => {}; }
    }, createSpeechBatch() {}
  };
  f.context.EdgeTtsExtension.Toolbar = { Toolbar: class {} };
  vm.runInContext(source("src/content/reader.js"), f.context);
  const app = new f.context.EdgeTtsExtension.Reader.ReaderApp();
  app.readerSessionToken = "";
  app.enabled = true;
  app.settings.clickToSeek = true;
  app.model = { blocks: [block], nodeToBlock: new Map([[node, block]]) };
  app.caretFromPoint = () => ({ node, offset: 7 });
  app.clearResumeWatchdog = () => {};
  app.discardLocalSpeechState = () => { stops++; };
  app.forceStopTabAudio = async () => ({ stopped: true });
  app.claimAudioOwnership = async () => true;
  app.speakCurrentPosition = () => { seekStarted++; };
  app.highlighter = { clear() {} };
  app.toolbar = { setPaused() {}, setStatus() {} };
  const click = target => ({
    target, clientX: 1, clientY: 1,
    preventDefault() { preventions++; },
    stopImmediatePropagation() {}
  });
  await app.handlePageClick(click(new f.Element(true)));
  assert.equal(preventions, 0);
  assert.equal(seekStarted, 0);
  await app.handlePageClick(click(new f.Element(false)));
  assert.equal(preventions, 1);
  assert.equal(app.currentSegmentIndex, 1);
  assert.equal(stops, 1);
  assert.equal(seekStarted, 1);
});
