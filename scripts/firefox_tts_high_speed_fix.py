#!/usr/bin/env python3
"""Targeted, checked source patch for sguzman/firefox-tts.

Applies high-rate Piper sentence coalescing and per-part native WAV assembly,
without altering the already-accelerated highlight clock. No downloads, no imports beyond stdlib, no
browser profiles, no voice model writes. All source edits verified first.
Usage: from existing firefox-tts checkout: python3 scripts/firefox_tts_high_speed_fix.py
"""
from __future__ import annotations

import pathlib
import sys
import subprocess

root = pathlib.Path.cwd()
if not (root / 'src/content/linux-piper-engine.js').is_file() or not (root / 'native/linux-piper/linux_piper_host.py').is_file():
    sys.exit('Error: run from the root of the existing firefox-tts checkout.')
paths = (
    'src/content/linux-piper-engine.js',
    'src/background/native.js',
    'native/linux-piper/linux_piper_host.py',
    'tests/linux-piper-sentence-chunks.test.js',
    'tests/test_fake_piper_protocol.py',
)
if subprocess.run(['git', 'rev-parse', '--is-inside-work-tree'],
                  capture_output=True, text=True).stdout.strip() != 'true':
    sys.exit('Error: this must be an existing Git checkout.')
if subprocess.run(['git', 'branch', '--show-current'],
                  capture_output=True, text=True).stdout.strip() != 'main':
    sys.exit('Error: switch to your existing main branch first.')
changed = subprocess.run(['git', 'status', '--porcelain', '--', *paths],
                         capture_output=True, text=True, check=True).stdout.strip()
if changed:
    sys.exit('Error: targeted source files contain local changes; refusing to overwrite:\n' + changed)
original = {name: (root / name).read_text(encoding='utf-8') for name in paths}
modified = dict(original)


def replace(path: str, before: str, after: str) -> None:
    source = modified[path]
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'Precondition mismatch: {path}, expected 1 anchor, found {count}: {before[:90]!r}')
    modified[path] = source.replace(before, after, 1)


def append(path: str, content: str) -> None:
    modified[path] += content


js = 'src/content/linux-piper-engine.js'
replace(js, '  if (!BaseSpeechEngine || typeof createUtteranceChunks !== "function") {', '''  // At high rates, a separate WAV/decoder for every brief sentence costs
  // enough wall time to underrun Piper prefetch and delays the word clock.
  // Preserve the first sentence for fast startup. Bundle the following
  // adjacent sentences in bounded groups, keeping their source indices.
  function coalesceHighRatePiperChunks(chunks, rate, sentencePauseMs) {
    if (!Array.isArray(chunks) || chunks.length < 3 || Number(rate) < 1.8) {
      return chunks;
    }
    const result = [chunks[0]];
    const pause = Math.max(0, Math.min(1200, Number(sentencePauseMs) || 0));
    for (let index = 1; index < chunks.length;) {
      const first = chunks[index];
      const group = [first];
      const block = first.segments?.[0]?.blockIndex;
      let chars = String(first.text || "").length;
      let words = first.segments?.length || 0;
      while (group.length < 3 && index + group.length < chunks.length) {
        const next = chunks[index + group.length];
        const nextText = String(next.text || "");
        if (
          next.segments?.[0]?.blockIndex !== block ||
          chars + 1 + nextText.length > PIPER_HARD_CLAUSE_CHARS ||
          words + (next.segments?.length || 0) > PIPER_HARD_CLAUSE_WORDS
        ) break;
        group.push(next);
        chars += nextText.length + 1;
        words += next.segments?.length || 0;
      }
      if (group.length === 1) {
        result.push(first);
        index += 1;
        continue;
      }
      let text = "";
      const starts = [];
      const segments = [];
      const parts = [];
      for (let partIndex = 0; partIndex < group.length; partIndex++) {
        const original = group[partIndex];
        if (partIndex) text += " ";
        const charStart = text.length;
        text += original.text;
        for (const start of original.starts) starts.push(charStart + start);
        segments.push(...original.segments);
        parts.push({
          text: original.text,
          charStart,
          pauseAfterMs: partIndex + 1 < group.length && original.sentenceFinal
            ? pause : 0
        });
      }
      result.push({
        text, starts, segments, parts,
        sentenceFinal: group[group.length - 1].sentenceFinal,
        emergencyClauseSplit: group[group.length - 1].emergencyClauseSplit,
        transformations: []
      });
      index += group.length;
    }
    return result;
  }

  if (!BaseSpeechEngine || typeof createUtteranceChunks !== "function") {''')
replace(js, '''      const chunks = createPiperSentenceChunks(block, startSegmentIndex);
      if (!chunks.length) {''', '''      const sentenceChunks = createPiperSentenceChunks(block, startSegmentIndex);
      const chunks = coalesceHighRatePiperChunks(
        sentenceChunks, options.rate, options.sentencePauseMs
      );
      if (!chunks.length) {''')
replace(js, '''          text: payload.text,
          voiceId: this.currentOptions?.voice?.voiceId,''', '''          text: payload.text,
          textParts: payload.parts || null,
          voiceId: this.currentOptions?.voice?.voiceId,''')
replace(js, '''      const improvedBoundaries = approximatePiperBoundaries(
        request.payload,
        event.durationMs
      );''', '''      // Grouped WAVs contain real PCM pauses. The native worker computes
      // per-part word offsets using actual sub-sentence frame lengths.
      const improvedBoundaries = request.payload?.parts?.length
        ? [] : approximatePiperBoundaries(request.payload, event.durationMs);''')
replace(js, '''    createPiperSentenceChunks,
    payloadForPiperSegments''', '''    createPiperSentenceChunks,
    coalesceHighRatePiperChunks,
    payloadForPiperSegments''')

bg = 'src/background/native.js'
replace(bg, '''          connected.postMessage({ type: "synthesize", requestId: id, text, voiceId,
            lang: String(message.lang || ""),
            playbackRate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)) });''', '''          connected.postMessage({ type: "synthesize", requestId: id, text, voiceId,
            textParts: Array.isArray(message.textParts) ? message.textParts : null,
            lang: String(message.lang || ""),
            playbackRate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)) });''')

py = 'native/linux-piper/linux_piper_host.py'
replace(py, '''def synthesize_worker(
    request_id: str,''', '''def validate_text_parts(raw_parts: Any, text: str) -> list[dict[str, Any]] | None:
    """Accept only bounded, source-offset-consistent high-speed sentence groups."""
    if raw_parts is None:
        return None
    if not isinstance(raw_parts, list) or not 2 <= len(raw_parts) <= 3:
        raise ValueError("Piper sentence group must have two or three parts")
    result: list[dict[str, Any]] = []
    previous_end = 0
    for item in raw_parts:
        if not isinstance(item, dict):
            raise ValueError("Malformed Piper sentence group")
        part_text = item.get("text")
        start = item.get("charStart")
        pause = item.get("pauseAfterMs")
        if (not isinstance(part_text, str) or not part_text.strip() or
                not isinstance(start, int) or isinstance(start, bool) or
                not isinstance(pause, (int, float)) or isinstance(pause, bool) or
                not math.isfinite(pause) or pause < 0 or pause > 1200 or
                start < previous_end or text[start:start + len(part_text)] != part_text):
            raise ValueError("Invalid Piper sentence source offsets or pause")
        result.append({"text": part_text, "charStart": start,
                       "pauseAfterMs": float(pause)})
        previous_end = start + len(part_text)
    if result[0]["charStart"] != 0 or result[-1]["pauseAfterMs"] != 0:
        raise ValueError("Invalid Piper sentence group boundaries")
    return result


def synthesize_worker(
    request_id: str,''')
replace(py, '''    playback_rate: float = 1.0,
) -> None:
    global _active_request_id''', '''    playback_rate: float = 1.0,
    text_parts: list[dict[str, Any]] | None = None,
) -> None:
    global _active_request_id''')
start = '''        config = synthesis_config_for_text(text)
        pcm = bytearray()
        sample_rate: int | None = None
        sample_width: int | None = None
        channels: int | None = None

        for chunk in voice.synthesize(text, config, include_alignments=False):
            if cancel.is_set():
                send_message({"type": "cancelled", "requestId": request_id})
                return
            if sample_rate is None:
                sample_rate = int(chunk.sample_rate)
                sample_width = int(chunk.sample_width)
                channels = int(chunk.sample_channels)
            pcm.extend(chunk.audio_int16_bytes)

        if cancel.is_set():
            send_message({"type": "cancelled", "requestId": request_id})
            return
        if not pcm or not sample_rate or not sample_width or not channels:
            raise RuntimeError("Piper produced no audio")

        taper_pcm_edges(pcm, sample_rate, sample_width, channels,
                        fade_ms=edge_fade_ms_for_rate(playback_rate))
        frames = len(pcm) / (sample_width * channels)
        duration_ms = (frames / sample_rate) * 1000.0
'''
new = '''        pcm = bytearray()
        sample_rate: int | None = None
        sample_width: int | None = None
        channels: int | None = None
        boundaries: list[dict[str, Any]] = []
        parts = text_parts or [{"text": text, "charStart": 0, "pauseAfterMs": 0}]

        for part_index, part in enumerate(parts):
            part_pcm = bytearray()
            for chunk in voice.synthesize(
                    part["text"], synthesis_config_for_text(part["text"]),
                    include_alignments=False):
                if cancel.is_set():
                    send_message({"type": "cancelled", "requestId": request_id})
                    return
                new_format = (int(chunk.sample_rate), int(chunk.sample_width),
                              int(chunk.sample_channels))
                if sample_rate is None:
                    sample_rate, sample_width, channels = new_format
                elif new_format != (sample_rate, sample_width, channels):
                    raise RuntimeError("Piper changed PCM format within a sentence group")
                part_pcm.extend(chunk.audio_int16_bytes)

            if cancel.is_set():
                send_message({"type": "cancelled", "requestId": request_id})
                return
            if not part_pcm or not sample_rate or not sample_width or not channels:
                raise RuntimeError("Piper produced no audio")
            frame_bytes = sample_width * channels
            start_ms = (len(pcm) / frame_bytes / sample_rate) * 1000.0
            part_duration_ms = (len(part_pcm) / frame_bytes / sample_rate) * 1000.0
            # Suppress hard joins into a configured silence, but only apply
            # the long high-rate fade to the group onset/ending. Otherwise
            # repeated 48ms fades themselves cause sluggish word starts.
            edge_ms = edge_fade_ms_for_rate(playback_rate) if (
                part_index == 0 or part_index == len(parts) - 1
            ) else PCM_EDGE_FADE_MS
            taper_pcm_edges(part_pcm, sample_rate, sample_width, channels,
                            fade_ms=edge_ms)
            for boundary in approximate_boundaries(part["text"], part_duration_ms):
                boundary["charIndex"] += part["charStart"]
                boundary["audioPositionMs"] += start_ms
                boundaries.append(boundary)
            pcm.extend(part_pcm)
            if part_index + 1 < len(parts) and part["pauseAfterMs"] > 0:
                # Keep the configured pause in *wall-clock* milliseconds.
                # The media element will consume twice as many source samples
                # per wall second at 2.0x playback.
                effective_rate = min(4.0, max(0.25, float(playback_rate)))
                silence_frames = round(sample_rate * part["pauseAfterMs"] * effective_rate / 1000)
                pcm.extend(b"\\x00" * (silence_frames * frame_bytes))

        frames = len(pcm) / (sample_width * channels)
        duration_ms = (frames / sample_rate) * 1000.0
'''
replace(py, start, new)
replace(py, '''        for boundary in approximate_boundaries(text, duration_ms):
            if cancel.is_set():''', '''        for boundary in boundaries:
            if cancel.is_set():''')
replace(py, '''    playback_rate = message.get("playbackRate", 1.0)

    if not request_id''', '''    playback_rate = message.get("playbackRate", 1.0)
    try:
        text_parts = validate_text_parts(message.get("textParts"), text)
    except ValueError as error:
        send_message({"type": "error", "requestId": request_id, "message": str(error)})
        return

    if not request_id''')
replace(py, '''            args=(request_id, voice_id, text, cancel, playback_rate),''', '''            args=(request_id, voice_id, text, cancel, playback_rate, text_parts),''')

js_test = 'tests/linux-piper-sentence-chunks.test.js'
replace(js_test, '''  createPiperSentenceChunks
} = require''', '''  createPiperSentenceChunks, coalesceHighRatePiperChunks
} = require''')
append(js_test, '''

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
''')

native_test = 'tests/test_fake_piper_protocol.py'
replace(native_test, '''    def test_explicit_cpu_self_check_uses_existing_fake_model_read_only(self):''', '''    def test_high_rate_grouped_sentence_wav_has_real_pcm_pause_and_native_offsets(self):
        self.handshake()
        parts = [
            {"text": "First.", "charStart": 0, "pauseAfterMs": 300},
            {"text": "Second.", "charStart": 7, "pauseAfterMs": 0},
        ]
        self.send({"type": "synthesize", "requestId": "group", "voiceId": "en_US-amy-low",
                   "text": "First. Second.", "textParts": parts, "playbackRate": 2.0})
        audio, boundaries = bytearray(), []
        deadline = time.monotonic() + 7
        while True:
            msg = self.read(deadline)
            if msg["type"] == "audioChunk":
                audio.extend(base64.b64decode(msg["data"]))
            elif msg["type"] == "boundary":
                boundaries.append(msg)
            elif msg["type"] == "error":
                self.fail(msg["message"])
            elif msg["type"] == "synthesisEnd":
                self.assertAlmostEqual(msg["durationMs"], 2200, delta=1)
                break
        with wave.open(io.BytesIO(audio), "rb") as wav:
            self.assertEqual(wav.getnframes(), 16000 * 22 // 10)
            pcm = wav.readframes(wav.getnframes())
        # Fake voice synthesizes four 3200-frame chunks per sentence (800ms),
        # with exactly 9600 zero frames (600ms of source = 300ms at 2x).
        self.assertEqual(pcm[12800*2 : (12800+9600)*2], b"\\x00" * (9600*2))
        self.assertEqual([x["charIndex"] for x in boundaries], [0, 7])
        self.assertAlmostEqual(boundaries[1]["audioPositionMs"], 1400, delta=1)
        self.assertEqual((self.voices / "en_US-amy-low.onnx").read_bytes(), self.voice_bytes)

    def test_explicit_cpu_self_check_uses_existing_fake_model_read_only(self):''')

# Write only if every source precondition and transform has succeeded.
for name, text in modified.items():
    if text == original[name]:
        raise RuntimeError('No modifications were prepared: ' + name)
try:
    for name, text in modified.items():
        (root / name).write_text(text, encoding='utf-8')
    print('Running offline, dependency-free regression checks...', flush=True)
    subprocess.run(['node', '--test', 'tests/linux-piper-sentence-chunks.test.js',
                    'tests/audio-stress.test.js'], cwd=root, check=True)
    subprocess.run(['python3', '-m', 'unittest', 'discover', '-s', 'tests',
                    '-p', 'test_*.py'], cwd=root, check=True)
    subprocess.run(['git', 'diff', '--check', '--', *paths], cwd=root, check=True)
except Exception:
    # Never leave a partly edited working tree after a failed validation.
    for name, source in original.items():
        (root / name).write_text(source, encoding='utf-8')
    print('Validation failed; all five modified files were restored.', file=sys.stderr)
    raise
print('PASS: high-speed grouping and native PCM pauses; existing highlight-clock fixes remain unchanged.')
print('Changed: ' + ', '.join(paths))
subprocess.run(['git', 'diff', '--stat'], cwd=root, check=True)
print('Native Python source changed, so refresh only the dedicated Firefox host:')
print('  ./native/linux-piper/install-native-host.sh')
print('Then reload the temporary add-on at about:debugging and refresh the tab.')