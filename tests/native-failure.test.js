const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background/native.js"), "utf8");

function setup({ replyToHello = true } = {}) {
  const messages = [], timers = new Map();
  let nextTimer = 0, receive, disconnect, listener, onRemove;
  const port = {
    onMessage: { addListener(fn) { receive = fn; } },
    onDisconnect: { addListener(fn) { disconnect = fn; } },
    postMessage(msg) {
      messages.push(msg);
      if (msg.type === "hello" && replyToHello) {
        queueMicrotask(() => receive?.({
          type: "hello", protocol: 1, platform: "linux",
          backend: "piper", cpuOnly: true
        }));
      }
    },
    disconnect() {}
  };
  const context = vm.createContext({
    browser: {
      runtime: {
        connectNative: () => port,
        onMessage: { addListener(fn) { listener = fn; } }
      },
      tabs: {
        onRemoved: { addListener(fn) { onRemove = fn; } },
        sendMessage: async () => ({ accepted: true })
      }
    },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    Date, console, module: { exports: {} }
  });
  vm.runInContext(source, context, { filename: "native.js" });
  return {
    api: context.module.exports, messages, timers, port,
    receive(msg) { receive?.(msg); },
    disconnect() { disconnect?.({ error: new Error("mock host crashed") }); },
    expire() { for (const fn of [...timers.values()]) fn(); },
    message(msg, tabId) { return listener(msg, { tab: { id: tabId } }); },
    remove(tabId) { onRemove(tabId); }
  };
}

test("native handshake times out and rejects rather than hanging", async () => {
  const h = setup({ replyToHello: false });
  const pending = h.api.ensureNative();
  assert.equal(h.messages[0].type, "hello");
  h.expire();
  await assert.rejects(pending, /handshake timed out/);
});

test("native disconnect rejects pending voice discovery with useful failure", async () => {
  const h = setup();
  const pending = h.api.requestNative("voices");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(h.messages.some(m => m.type === "voices"));
  h.disconnect();
  await assert.rejects(pending, /mock host crashed/);
});

test("native request timeout cancels the inflight request", async () => {
  const h = setup();
  const pending = h.api.requestNative("voices");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const request = h.messages.find(m => m.type === "voices");
  assert.ok(request);
  h.expire();
  await assert.rejects(pending, /request timed out/);
  assert.ok(h.messages.some(m => m.type === "cancel" && m.requestId === request.requestId));
});

test("release during delayed native handshake cannot resurrect synthesis", async () => {
  const h = setup({ replyToHello: false });
  assert.equal((await h.message({ type:"EDGE_TTS_AUDIO_CLAIM" }, 17)).granted, true);
  const pending = h.message({ type:"EDGE_TTS_LINUX_PIPER_SYNTHESIZE",
    requestId:"after-stop", voiceId:"en_US-amy-low", text:"Never play after stop" }, 17);
  await Promise.resolve();
  assert.equal(h.messages[0].type, "hello");
  assert.equal((await h.message({ type:"EDGE_TTS_AUDIO_RELEASE" }, 17)).released, true);
  h.receive({ type:"hello", protocol:1, platform:"linux", backend:"piper", cpuOnly:true });
  const result = await pending;
  assert.equal(result.accepted, false);
  assert.match(result.error, /ownership expired/);
  assert.equal(h.messages.some(m => m.type === "synthesize"), false);
});
