const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSpeechBatch, createPayloadFromSegments } =
  require("../src/content/speech-engine.js");
const { segmentIndexForCharIndex } = require("../src/content/text-model.js");

function block(index, words) {
  return {
    index,
    segments: words.map((text, segmentIndex) =>
      ({ blockIndex: index, sentenceIndex: 0, segmentIndex, text }))
  };
}

test("multi-block speech batching maps source words through correct paragraph separators", () => {
  const blocks = [block(0, ["Alpha", "beta."]), block(1, ["Third", "sentence."])];
  const batch = createSpeechBatch(blocks, 0, 0, { minChars: 8, maxChars: 100 });
  assert.equal(batch.startBlockIndex, 0);
  assert.equal(batch.endBlockIndex, 0, "a completed first paragraph can stand alone at small target");
  const combined = createPayloadFromSegments([...blocks[0].segments, ...blocks[1].segments]);
  assert.equal(combined.text, "Alpha beta.\n\nThird sentence.");
  assert.deepEqual(combined.starts, [0, 6, 13, 19]);
  assert.equal(segmentIndexForCharIndex(combined.starts, 21), 3);
  assert.strictEqual(combined.segments[2], blocks[1].segments[0]);
});

test("reader batches can cross paragraphs without mixing each original block identity", () => {
  const blocks = [block(0, ["Hello", "there."]), block(1, ["General", "Kenobi."])];
  const batch = createSpeechBatch(blocks, 0, 0, { minChars: 100, maxChars: 200 });
  assert.equal(batch.endBlockIndex, 1);
  assert.equal(batch.segments.length, 4);
  assert.equal(batch.segments[0].blockIndex, 0);
  assert.equal(batch.segments[3].blockIndex, 1);
});

test("batching from an interior token preserves the source cursor", () => {
  const blocks = [block(0, ["Skip", "these", "words."]), block(1, ["Start", "next."])];
  const batch = createSpeechBatch(blocks, 0, 2, { minChars: 50, maxChars: 300 });
  assert.equal(batch.segments[0].text, "words.");
  assert.equal(batch.endBlockIndex, 1);
});
