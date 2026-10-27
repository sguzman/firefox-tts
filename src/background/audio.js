/* Firefox MV3 event pages are DOM documents: own the audio there.
   This is the Firefox replacement for Chromium's chrome.offscreen API. */
(() => {
  "use strict";
  const bridge = globalThis.FirefoxTtsBackground || (globalThis.FirefoxTtsBackground = {});
  const audio = new Audio();
  audio.preload = "auto";
  audio.preservesPitch = true;
  let session = null;
  let tickTimer = null;
  let pauseTimer = null;
  // Firefox's pitch-preserving high-speed playback can emit a transient at
  // the beginning of a newly loaded WAV, *after* the source PCM edge taper.
  // A 32 ms post-decoder volume ramp masks that transient without changing
  // model output, audio length, pitch or the media clock.
  let attackTimer = null;
  function clearAttack() {
    if (attackTimer !== null) clearInterval(attackTimer);
    attackTimer = null;
  }
  function startAttack(current) {
    clearAttack();
    if (current.playbackRate < 1.8) {
      audio.volume = current.targetVolume;
      return;
    }
    audio.volume = 0;
    let step = 0;
    attackTimer = setInterval(() => {
      if (session !== current || current.paused) {
        clearAttack();
        return;
      }
      step += 1;
      audio.volume = Math.min(1, current.targetVolume * step / 4);
      if (step >= 4) clearAttack();
    }, 8);
  }

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
    if (!current || current.paused) return;
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
    clearAttack();
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    try { audio.pause(); } catch {}
    try { audio.removeAttribute("src"); audio.load(); } catch {}
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
        attackStarted: false,
        sentencePauseMs: Math.min(1200, Math.max(0, Number(message.sentencePauseMs) || 0))
      };
      if (session.nextBoundary < 0) session.nextBoundary = boundaries.length;
      const current = session;
      audio.src = url;
      audio.playbackRate = current.playbackRate;
      audio.volume = current.playbackRate >= 1.8 ? 0 : current.targetVolume;
      if (checkpoint) audio.currentTime = checkpoint;
      audio.onplaying = () => {
        if (session !== current || current.paused) return;
        if (!current.attackStarted) {
          current.attackStarted = true;
          startAttack(current);
        }
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
      if (!current.attackStarted) {
        current.attackStarted = true;
        startAttack(current);
      }
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
      clearAttack();
      emit(current, { type: "paused", currentTime: audio.currentTime });
      return { accepted: true, currentTime: audio.currentTime };
    }
    if (type === "EDGE_TTS_PIPER_OFFSCREEN_RESUME") {
      try {
        current.paused = false;
        // A pause during the attack must never strand the output at 0 volume.
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
      if (attackTimer === null) audio.volume = current.targetVolume;
      return { accepted: true };
    }
    return { accepted: false, error: "Unsupported playback action" };
  }
  bridge.player = { handle, stopTab, stopAll: stopCurrent, getSession: () => session };
})();
