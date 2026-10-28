/* Firefox MV3 background event page: explicit action-only injection. */
(() => {
  "use strict";
  // These names are the pinned upstream IPC contract, not a Chromium dependency.
  const REVISION = 20;
  const READER_FILES = Object.freeze([
    "src/content/namespace.js",
    "src/pronunciation/defaults.js",
    "src/pronunciation/engine.js",
    "src/content/text-model.js",
    "src/content/highlighter.js",
    "src/content/speech-engine.js",
    "src/content/reliable-speech-engine.js",
    "src/content/linux-piper-engine.js",
    "src/content/toolbar.js",
    "src/content/voice-ui.js",
    "src/content/reader.js",
    "src/content/reliable-reader.js",
    "src/content/failsafe-reader.js",
    "src/content/audio-controls.js",
    "src/content/startup-fastpath.js",
    "src/content/content-script.js"
  ]);
  const READER_CSS = Object.freeze(["src/content/content.css"]);
  const inflight = new Map();

  async function readerReady(tabId) {
    try {
      const reply = await browser.tabs.sendMessage(tabId, { type: "EDGE_TTS_PING_V2" });
      return reply?.ready === true && reply.revision === REVISION;
    } catch {
      return false;
    }
  }

  async function inject(tabId) {
    // Only called as the consequence of an explicit toolbar action. No static
    // content_scripts, listeners on pages, polling, or continuous DOM scans.
    await browser.scripting.insertCSS({ target: { tabId }, files: READER_CSS });
    await browser.scripting.executeScript({ target: { tabId }, files: READER_FILES });
  }

  async function ensureReader(tabId) {
    if (await readerReady(tabId)) return;
    let pending = inflight.get(tabId);
    if (!pending) {
      pending = inject(tabId);
      inflight.set(tabId, pending);
    }
    try {
      await pending;
    } finally {
      if (inflight.get(tabId) === pending) inflight.delete(tabId);
    }
  }

  async function toggle(tabId) {
    await ensureReader(tabId);
    try {
      const reply = await browser.tabs.sendMessage(tabId, { type: "EDGE_TTS_TOGGLE_V2" });
      if (reply?.accepted === true) return true;
    } catch {
      // A tab may retain an invalidated isolated world after extension reload.
    }

    // Exactly one repair attempt. No page navigation/reload or busy retry.
    await inject(tabId);
    if (!(await readerReady(tabId))) {
      throw new Error("Firefox TTS reader did not register after re-injection.");
    }
    const reply = await browser.tabs.sendMessage(tabId, { type: "EDGE_TTS_TOGGLE_V2" });
    if (reply?.accepted !== true) {
      throw new Error("Firefox TTS reader rejected its action after recovery.");
    }
    return true;
  }

  browser.action.onClicked.addListener((tab) => {
    if (!Number.isInteger(tab?.id) || tab.id < 0) return;
    void toggle(tab.id).catch((error) => {
      console.warn("Firefox TTS reader failed to start:", error);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    inflight.delete(tabId);
  });

  // Expose pure operational hooks only to synthetic test harnesses. The
  // shipped event page does not publish a messaging API for these internals.
  if (typeof module === "object" && module.exports) {
    module.exports = { REVISION, READER_FILES, READER_CSS, readerReady, ensureReader, toggle };
  }
})();
