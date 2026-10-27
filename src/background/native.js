/* Firefox-only background protocol. All native work is explicit and local. */
(() => {
  "use strict";
  const HOST = "com.sguzman.firefox_tts.linux_piper";
  const NATIVE_TIMEOUT_MS = 15_000;
  const MAX_SPEECH_CHARS = 12_000;
  const bridge = globalThis.FirefoxTtsBackground || (globalThis.FirefoxTtsBackground = {});
  const requests = new Map();
  let port = null;
  let ready = null;
  let handshakeResolve = null;
  let handshakeReject = null;
  let handshakeTimer = null;
  let audioOwnerTabId = null;
  let serial = 0;

  function freshId(prefix) {
    serial += 1;
    return `${prefix}-${Date.now()}-${serial}`;
  }
  function errorText(error) {
    return error?.message || String(error || "Unknown Firefox TTS failure");
  }
  function resetPort(reason) {
    const old = port;
    port = null;
    ready = null;
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    handshakeReject?.(new Error(reason));
    handshakeReject = null;
    handshakeResolve = null;
    for (const [id, request] of requests) {
      clearTimeout(request.timer);
      requests.delete(id);
      request.reject(new Error(reason));
    }
    try { old?.disconnect(); } catch { /* already closed */ }
  }
  function onNativeMessage(message) {
    if (message?.type === "hello") {
      if (message.protocol !== 1 || message.platform !== "linux" ||
          message.backend !== "piper" || message.cpuOnly !== true) {
        resetPort("Native Piper helper protocol/platform mismatch.");
        return;
      }
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      const resolve = handshakeResolve;
      handshakeResolve = null;
      handshakeReject = null;
      resolve?.(true);
      return;
    }
    const id = String(message?.requestId || "");
    const request = requests.get(id);
    if (!request) return;
    if (message?.type === "error") {
      clearTimeout(request.timer);
      requests.delete(id);
      request.reject(new Error(errorText(message.message)));
      return;
    }
    try { request.onMessage?.(message); } catch (error) {
      clearTimeout(request.timer);
      requests.delete(id);
      request.reject(error);
    }
  }
  function ensureNative() {
    if (port && ready) return ready.then(() => port);
    let next;
    try { next = browser.runtime.connectNative(HOST); }
    catch (error) { return Promise.reject(error); }
    port = next;
    ready = new Promise((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;
    });
    next.onMessage.addListener(onNativeMessage);
    next.onDisconnect.addListener((disconnected) => {
      if (port === next) resetPort(errorText(disconnected?.error || next.error || "Piper helper disconnected"));
    });
    handshakeTimer = setTimeout(() => {
      if (port === next) resetPort("Piper helper handshake timed out.");
    }, NATIVE_TIMEOUT_MS);
    try { next.postMessage({ type: "hello", protocol: 1 }); }
    catch (error) { resetPort(errorText(error)); }
    return ready?.then(() => next) || Promise.reject(new Error("Piper helper unavailable"));
  }
  async function requestNative(type, payload = {}, { timeout = NATIVE_TIMEOUT_MS, tabId = null, onEvent } = {}) {
    const connected = await ensureNative();
    const requestId = freshId(type);
    return new Promise((resolve, reject) => {
      const request = {
        type, tabId, resolve, reject, onEvent,
        onMessage(message) {
          onEvent?.(message);
          if (type === "voices" && message.type === "voices") done(message.voices || []);
          if (type === "pronunciationConfigRead" && message.type === "pronunciationConfig") done(message);
          if (type === "pronunciationConfigWrite" && message.type === "pronunciationConfigSaved") done(message);
          if (type === "synthesize" && ["synthesisEnd", "cancelled"].includes(message.type)) done(message);
        },
        timer: null
      };
      function done(result) {
        if (requests.get(requestId) !== request) return;
        clearTimeout(request.timer);
        requests.delete(requestId);
        resolve(result);
      }
      request.timer = setTimeout(() => {
        if (requests.get(requestId) !== request) return;
        requests.delete(requestId);
        try { connected.postMessage({ type: "cancel", requestId }); } catch {}
        reject(new Error(`${type} request timed out`));
      }, timeout);
      requests.set(requestId, request);
      try { connected.postMessage({ type, requestId, ...payload }); }
      catch (error) {
        clearTimeout(request.timer);
        requests.delete(requestId);
        reject(error);
      }
    });
  }
  function cancelForTab(tabId, filterRequestId = null) {
    let cancelled = false;
    for (const [id, request] of requests) {
      if (request.type !== "synthesize" || request.tabId !== tabId ||
          (filterRequestId && request.clientId !== filterRequestId)) continue;
      cancelled = true;
      try { port?.postMessage({ type: "cancel", requestId: id }); } catch {}
      clearTimeout(request.timer);
      requests.delete(id);
      request.reject(new Error("Synthesis cancelled."));
    }
    return cancelled;
  }
  async function claimAudio(tabId) {
    if (!Number.isInteger(tabId)) return { granted: false };
    if (audioOwnerTabId !== null && audioOwnerTabId !== tabId) {
      const previous = audioOwnerTabId;
      audioOwnerTabId = tabId;
      cancelForTab(previous);
      bridge.player?.stopTab?.(previous);
      void browser.tabs.sendMessage(previous, { type: "EDGE_TTS_AUDIO_PREEMPT" }).catch(() => {});
    } else {
      audioOwnerTabId = tabId;
    }
    return { granted: true, tabId };
  }
  function releaseAudio(tabId) {
    if (audioOwnerTabId !== tabId) return { released: false };
    // A release must never leave old Piper work or extension-owned WAV alive.
    audioOwnerTabId = null;
    cancelForTab(tabId);
    bridge.player?.stopTab?.(tabId);
    return { released: true };
  }
  async function pronunciationPreview(message) {
    const text = String(message.text || "");
    if (!text.trim() || text.length > MAX_SPEECH_CHARS) {
      return { accepted: false, error: "Invalid pronunciation preview length." };
    }
    const audioChunks = [];
    let durationMs = 0;
    let sampleRate = 0;
    try {
      const final = await requestNative("synthesize", {
        text, voiceId: String(message.voiceId || "en_US-amy-low")
      }, {
        timeout: 45_000,
        onEvent(event) {
          if (event.type === "audioChunk") audioChunks.push(String(event.data || ""));
          if (event.type === "synthesisEnd") {
            durationMs = Math.max(0, Number(event.durationMs) || 0);
            sampleRate = Math.max(0, Number(event.sampleRate) || 0);
          }
        }
      });
      if (final?.type !== "synthesisEnd" || !audioChunks.length) {
        return { accepted: false, error: "Pronunciation preview did not produce audio." };
      }
      return { accepted: true, audioChunks, durationMs, sampleRate };
    } catch (error) {
      return { accepted: false, error: errorText(error) };
    }
  }

  function handleMessage(message, sender) {
    const type = message?.type;
    const tabId = sender?.tab?.id;
    if (type === "EDGE_TTS_AUDIO_CLAIM") return claimAudio(tabId);
    if (type === "EDGE_TTS_AUDIO_RELEASE") return releaseAudio(tabId);
    if (type === "EDGE_TTS_FORCE_STOP_TAB_AUDIO") {
      const stopped = cancelForTab(tabId);
      const media = bridge.player?.stopTab?.(tabId) === true;
      return { stopped: stopped || media };
    }
    if (type === "EDGE_TTS_OPEN_PRONUNCIATION_OPTIONS") {
      return browser.runtime.openOptionsPage().then(() => ({ accepted: true }));
    }
    if (type === "EDGE_TTS_LINUX_PIPER_VOICES") {
      return requestNative("voices").then(voices => ({ voices }))
        .catch(error => ({ voices: [], error: errorText(error) }));
    }
    if (type === "EDGE_TTS_LINUX_PIPER_SYNTHESIZE") {
      const text = String(message.text || "");
      const clientId = String(message.requestId || "");
      const voiceId = String(message.voiceId || "");
      if (!Number.isInteger(tabId) || audioOwnerTabId !== tabId ||
          !text.trim() || text.length > MAX_SPEECH_CHARS || !voiceId || !clientId) {
        return { accepted: false, error: "Invalid Piper synthesis request." };
      }
      // A new click-seek or replacement batch makes prior native synthesis stale.
      cancelForTab(tabId);
      return ensureNative().then((connected) => {
        // Stop, tab close or cross-tab preemption may occur during the native
        // handshake; don't schedule a stale synthesis after its owner vanished.
        if (audioOwnerTabId !== tabId) {
          return { accepted: false, error: "Piper audio ownership expired" };
        }
        const id = freshId("synthesize");
        let timer;
        const request = {
          type: "synthesize", tabId, clientId,
          onMessage(event) {
            void browser.tabs.sendMessage(tabId, {
              type: "EDGE_TTS_LINUX_PIPER_EVENT", requestId: clientId, event
            }).catch(() => {});
            if (["synthesisEnd", "cancelled"].includes(event.type)) {
              clearTimeout(timer);
              requests.delete(id);
            }
          },
          timer: null,
          reject(error) {
            void browser.tabs.sendMessage(tabId, {
              type: "EDGE_TTS_LINUX_PIPER_EVENT", requestId: clientId,
              event: { type: "error", message: errorText(error) }
            }).catch(() => {});
          }
        };
        timer = setTimeout(() => {
          if (requests.get(id) !== request) return;
          requests.delete(id);
          try { connected.postMessage({ type: "cancel", requestId: id }); } catch {}
          request.reject(new Error("Piper synthesis timed out."));
        }, 45_000);
        request.timer = timer;
        requests.set(id, request);
        try {
          connected.postMessage({ type: "synthesize", requestId: id, text, voiceId,
            lang: String(message.lang || ""),
            playbackRate: Math.min(4, Math.max(0.25, Number(message.playbackRate) || 1)) });
        } catch (error) {
          clearTimeout(timer);
          requests.delete(id);
          return { accepted: false, error: errorText(error) };
        }
        return { accepted: true };
      }).catch(error => ({ accepted: false, error: errorText(error) }));
    }
    if (type === "EDGE_TTS_LINUX_PIPER_STOP") {
      return { stopped: cancelForTab(tabId, message.requestId || null) };
    }
    if (type === "EDGE_TTS_PRONUNCIATION_BACKUP_READ") {
      return requestNative("pronunciationConfigRead").then(result => ({
        accepted: true, config: result.config ?? null, path: result.path || ""
      })).catch(error => ({ accepted: false, error: errorText(error) }));
    }
    if (type === "EDGE_TTS_PRONUNCIATION_BACKUP_WRITE") {
      return requestNative("pronunciationConfigWrite", { config: message.config }).then(result => ({
        accepted: true, path: result.path || "",
        revision: Number(result.revision) || 0, savedAt: Number(result.savedAt) || 0
      })).catch(error => ({ accepted: false, error: errorText(error) }));
    }
    if (type === "EDGE_TTS_PRONUNCIATION_TEST_SYNTHESIZE") return pronunciationPreview(message);
    if (type === "EDGE_TTS_PRONUNCIATION_TEST_CANCEL") {
      for (const [id, req] of requests) {
        if (req.type === "synthesize" && req.tabId === null) {
          try { port?.postMessage({ type: "cancel", requestId: id }); } catch {}
          clearTimeout(req.timer);
          requests.delete(id);
          req.reject(new Error("Preview cancelled."));
        }
      }
      return { cancelled: true };
    }
    if (type?.startsWith("EDGE_TTS_PIPER_OFFSCREEN_")) {
      if (!Number.isInteger(tabId) || audioOwnerTabId !== tabId) {
        return { accepted: false, error: "Tab does not own Piper audio" };
      }
      return bridge.player?.handle?.(message, tabId) ||
        { accepted: false, error: "Firefox background media player unavailable." };
    }
    return undefined;
  }
  browser.runtime.onMessage.addListener((message, sender) => {
    const response = handleMessage(message, sender);
    if (response === undefined) return false;
    return response;
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    cancelForTab(tabId);
    bridge.player?.stopTab?.(tabId);
    if (audioOwnerTabId === tabId) audioOwnerTabId = null;
  });
  if (typeof module === "object" && module.exports) {
    module.exports = { handleMessage, ensureNative, cancelForTab, requestNative,
      get audioOwnerTabId() { return audioOwnerTabId; } };
  }
})();
