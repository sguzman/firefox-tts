const test = require("node:test");
const assert = require("node:assert/strict");

global.EdgeTtsExtension = {
  SpeechEngine: {
    SpeechEngine: class {},
    createUtteranceChunks() { return []; }
  },
  TextModel: {}
};

const {
  createPiperSentenceChunks, coalesceHighRatePiperChunks
} = require("../src/content/linux-piper-engine.js");

test("Piper chunks follow actual block+sentence boundaries", () => {
  const segments = [
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 0, text: "This" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 1, text: "is" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 2, text: "one." },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 3, text: "This" },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 4, text: "is" },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 5, text: "two." },
    { blockIndex: 1, sentenceIndex: 0, segmentIndex: 0, text: "Third" },
    { blockIndex: 1, sentenceIndex: 0, segmentIndex: 1, text: "sentence." }
  ];

  const chunks = createPiperSentenceChunks({ segments }, 0);
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    "This is one.",
    "This is two.",
    "Third sentence."
  ]);
});

test("Piper sentence chunking honors a mid-sentence resume cursor", () => {
  const segments = [
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 0, text: "Skip" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 1, text: "to" },
    { blockIndex: 0, sentenceIndex: 0, segmentIndex: 2, text: "here." },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 3, text: "Next" },
    { blockIndex: 0, sentenceIndex: 1, segmentIndex: 4, text: "sentence." }
  ];

  const chunks = createPiperSentenceChunks({ segments }, 1);
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    "to here.",
    "Next sentence."
  ]);
});


test("oversized press-release sentence splits at clauses without becoming fake sentences", () => {
  const text = "WASHINGTON, D.C. — Ways and Means Committee Chairman Jason Smith (MO-08) is demanding records from The People’s Forum, a New York-based 501(c)(3) organization, in a letter today following mounting evidence that shows that this organization has acted as a foreign agent of the Chinese Communist Party (CCP) and has received millions of dollars in funding from a known CCP ally, Neville Roy Singham, while enjoying the benefits of U.S. tax-exempt status.";
  const segments = (text.match(/\S+/g) || []).map((token, index) => ({
    blockIndex: 0,
    sentenceIndex: 0,
    segmentIndex: index,
    text: token
  }));

  const chunks = createPiperSentenceChunks({ segments }, 0);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.at(-1).sentenceFinal, true);
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(chunk.sentenceFinal, false);
    assert.ok(chunk.text.length <= 320);
  }
  assert.ok(chunks.every((chunk) => chunk.text.length <= 320));
});


test("2x sentence coalescing retains a fast first sentence and precise source offsets", () => {
  const words = ["First.", "Second.", "Third.", "Fourth."];
  const segments = words.map((text, index) => ({
    blockIndex: 0, sentenceIndex: index, segmentIndex: index, text
  }));
  const input = createPiperSentenceChunks({ segments }, 0);
  const normal = coalesceHighRatePiperChunks(input, 1.7, 300);
  assert.equal(normal.length, 4);
  const grouped = coalesceHighRatePiperChunks(input, 2.0, 300);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0], input[0], "first sentence stays instant");
  assert.deepEqual(grouped[1].parts.map(p => p.text),
    ["Second.", "Third.", "Fourth."]);
  assert.deepEqual(grouped[1].parts.map(p => p.pauseAfterMs), [300, 300, 0]);
  assert.deepEqual(grouped[1].parts.map(p => p.charStart), [0, 8, 15]);
  assert.deepEqual(grouped[1].starts, [0, 8, 15]);
  assert.deepEqual(grouped[1].segments.map(x => x.text),
    ["Second.", "Third.", "Fourth."]);
});

test("high rate never bundles across separate source block boundaries", () => {
  const segments = ["One.", "Two.", "Three.", "Four."].map((text, index) => ({
    text, blockIndex: index < 2 ? 0 : 1, sentenceIndex: index, segmentIndex: index
  }));
  const input = createPiperSentenceChunks({ segments }, 0);
  const grouped = coalesceHighRatePiperChunks(input, 2, 250);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[1].text, "Two.");
  assert.equal(grouped[2].parts.length, 2);
});
