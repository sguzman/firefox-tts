/* Firefox MV3 event pages are DOM documents: own the audio there.
   This is the Firefox replacement for Chromium's chrome.offscreen API. */
(() => {
  "use strict";
  const bridge = globalThis.FirefoxTtsBackground || (globalThis.FirefoxTtsBackground = {});
  // A WAV is a complete independent decode session. Reusing a media element
  // across new sources repeatedly tears down/restarts Firefox's 2x pitch
  // processor; the clean pronunciation test bench uses a new element for
  // each synthesized WAV instead. Give each WAV its own media element and
  // retire the previous owner before starting the next, with no overlap.
  let audio = null;
  let session = null;
  let tickTimer = null;
  let pauseTimer = null;
  // Match the clean pronunciation test bench: never step the output gain
  // during audible playback. The former four abrupt 8ms gain changes could
  // themselves cause clicks at >=1.8x, while muting the first 8ms of speech.
  // The native helper already supplies a short, sample-by-sample PCM taper.
  function emit(current, event) {
    if (!current || !Number.isInteger(current.tabId)) return;
    void browser.tabs.sendMessage(current.tabId, {
      type: "EDGE_TTS_PIPER_OFFSCREEN_EVENT",
      playbackId: current.id,
      event
    }).catch(() => {});
  }
  function endTick() {
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = null;
  }
  function clearPause() {
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  function tick() {
    const current = session;
    if (!current || current.paused || !audio) return;
    const time = Math.max(0, Number(audio.currentTime) || 0);
    // More frequent source-clock sampling at high playback rates.
    const lead = current.playbackRate >= 1.8 ? 0.025 : 0.015;
    let emitted = 0;
    while (current.nextBoundary < current.boundaries.length &&
           current.boundaries[current.nextBoundary] <= time + lead &&
           emitted < 40) {
      emit(current, { type: "boundary", index: current.nextBoundary, currentTime: time });
      current.nextBoundary += 1;
      emitted += 1;
    }
  }
  function startTick() {
    endTick();
    tick(); // Highlight the initial boundary without timer latency.
    tickTimer = setInterval(tick, session?.playbackRate >= 1.8 ? 16 : 50);
  }
  function stopCurrent({ notify = true } = {}) {
    const previous = session;
    session = null;
    endTick();
    clearPause();
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    const retiredAudio = audio;
    audio = null;
    try { retiredAudio?.pause?.(); } catch {}
    try { retiredAudio?.removeAttribute?.("src"); retiredAudio?.load?.(); } catch {}
    if (previous?.url) URL.revokeObjectURL(previous.url);
    if (previous && notify) emit(previous, { type: "stopped" });
    return Boolean(previous);
  }
  function stopTab(tabId) {
    if (!session || session.tabId !== tabId) return false;
    return stopCurrent();
  }
  function decodeChunks(encoded) {
    if (!Array.isArray(encoded) || !encoded.length || encoded.length > 256)
      throw new Error("Invalid Piper audio chunks");
    const chunks = [];
    let total = 0;
    for (const piece of encoded) {
      const base64 = String(piece || "");
      if (!base64 || base64.length > 1_000_000) throw new Error("Invalid Piper WAV chunk length");
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      total += bytes.byteLength;
      if (total > 64 * 1024 * 1024) throw new Error("Piper WAV exceeds playback limit");
      chunks.push(bytes);
    }
    return chunks;
  }
  async function play(message, tabId) {
    const id = String(message.playbackId || "");
    if (!id || !Number.isInteger(tabId)) return { accepted: false, error: "Invalid playback owner" };
    let url;
    try {
      const chunks = decodeChunks(message.audioChunks);
      const blob = new Blob(chunks, { type: "audio/wav" });
      stopCurrent();
      // The same fresh-media lifecycle used by the clean test bench.
      audio = new Audio();
      audio.preload = "auto";
      audio.preservesPitch = true;
      url = URL.createObjectURL(blob);
      const boundaries = (Array.isArray(message.boundaryOffsets) ? message.boundaryOffsets : [])
        .slice(0, 20_000)
        .map(value => Math.max(0, Number(value) || 0));
      const checkpoint = Math.max(0, Number(message.startTimeSeconds) || 0);
      session = {
        id, tabId, url, boundaries,
        nextBoundary: checkpoint === 0
          ? 0
          : boundaries.findIndex(offset => offset > checkpoint + 0.025),
        paused: false,
        playbackRate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)),
        targetVolume: Math.min(1, Math.max(0, Number(message.volume ?? 1))),
        sentencePauseMs: Math.min(1200, Math.max(0, Number(message.sentencePauseMs) || 0))
      };
      if (session.nextBoundary < 0) session.nextBoundary = boundaries.length;
      const current = session;
      audio.src = url;
      audio.playbackRate = current.playbackRate;
      audio.volume = current.targetVolume;
      if (checkpoint) audio.currentTime = checkpoint;
      audio.onplaying = () => {
        if (session !== current || current.paused) return;
        emit(current, { type: "started", currentTime: audio.currentTime });
        startTick();
      };
      audio.onended = () => {
        if (session !== current) return;
        endTick();
        tick();
        // Sentence pause applies to *completed audio*, not synthesis speed.
        clearPause();
        pauseTimer = setTimeout(() => {
          if (session !== current) return;
          emit(current, { type: "ended", currentTime: audio.duration || audio.currentTime });
          stopCurrent({ notify: false });
        }, current.sentencePauseMs);
      };
      audio.onerror = () => {
        if (session !== current) return;
        emit(current, { type: "error", message: "Firefox extension WAV playback failed" });
        stopCurrent({ notify: false });
      };
      await audio.play();
      if (session !== current) return { accepted: false, error: "Playback superseded" };
      return { accepted: true };
    } catch (error) {
      if (session?.id === id) {
        emit(session, { type: "error", message: error.message || String(error) });
        stopCurrent({ notify: false });
      } else if (url) URL.revokeObjectURL(url);
      return { accepted: false, error: error.message || String(error) };
    }
  }
  async function handle(message, tabId) {
    const type = message?.type;
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_PLAY") return play(message, tabId);
    const current = session;
    if (!current || current.id !== String(message.playbackId || "") || current.tabId !== tabId)
      return { accepted: false, error: "Playback session is not owned by this tab" };
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_STOP") return { accepted: stopCurrent() };
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_PAUSE") {
      current.paused = true;
      audio.pause();
      endTick();
      clearPause();
      emit(current, { type: "paused", currentTime: audio.currentTime });
      return { accepted: true, currentTime: audio.currentTime };
    }
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_RESUME") {
      try {
        current.paused = false;
        audio.volume = current.targetVolume;
        await audio.play();
        if (session !== current) return { accepted: false, error: "Session superseded" };
        emit(current, { type: "resumed", currentTime: audio.currentTime });
        startTick();
        return { accepted: true, currentTime: audio.currentTime };
      } catch (error) {
        current.paused = true;
        return { accepted: false, error: error.message || String(error) };
      }
    }
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_RATE") {
      current.playbackRate = Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1));
      audio.playbackRate = current.playbackRate;
      if (tickTimer !== null) startTick();
      return { accepted: true };
    }
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_VOLUME") {
      current.targetVolume = Math.min(1, Math.max(0, Number(message.volume ?? 1)));
      audio.volume = current.targetVolume;
      return { accepted: true };
    }
    return { accepted: false, error: "Unsupported playback action" };
  }
  bridge.player = { handle, stopTab, stopAll: stopCurrent, getSession: () => session };
})();
