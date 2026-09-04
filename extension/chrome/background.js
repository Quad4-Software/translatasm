/**
 * Service worker for translatasm.
 * Keeps a bridge tab on the PWA origin for isolated WASM inference.
 */

const APP_ORIGIN = "https://translatasm.quad4.io";
const BRIDGE_PATH = "/extension-bridge.html";
const BRIDGE_NAME = "translatasm-bridge";

const pending = new Map();
let reqSeq = 0;

async function getConfiguredOrigin() {
  const { bridgeOrigin = APP_ORIGIN } = await chrome.storage.sync.get("bridgeOrigin");
  return String(bridgeOrigin || APP_ORIGIN).replace(/\/$/, "");
}

function isAllowedBridgeUrl(url, origin) {
  return (
    url.startsWith(APP_ORIGIN) ||
    url.startsWith(origin) ||
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://localhost")
  );
}

async function getBridgePort() {
  if (globalThis.__bridgePort && globalThis.__bridgePort.name === BRIDGE_NAME) {
    return globalThis.__bridgePort;
  }
  await ensureBridgeTab();
  for (let i = 0; i < 40; i++) {
    if (globalThis.__bridgePort && globalThis.__bridgePort.name === BRIDGE_NAME) {
      return globalThis.__bridgePort;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function ensureBridgeTab() {
  const origin = await getConfiguredOrigin();
  const extId = chrome.runtime.id;
  const url = `${origin}${BRIDGE_PATH}?extId=${encodeURIComponent(extId)}`;

  const tabs = await chrome.tabs.query({ url: `${origin}${BRIDGE_PATH}*` });
  if (tabs.length) {
    const existing = tabs[0];
    if (existing.url !== url) {
      await chrome.tabs.update(existing.id, { url });
    }
    await chrome.storage.session.set({ bridgeTabId: existing.id });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await chrome.storage.session.set({ bridgeTabId: tab.id });
  return tab.id;
}

async function bridgeRequest(payload) {
  const port = await getBridgePort();
  if (!port) throw new Error("Bridge not connected. Allow the bridge tab to stay open.");
  const id = `r${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("bridge timeout"));
    }, 180000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ ...payload, id });
  });
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== BRIDGE_NAME) {
    port.disconnect();
    return;
  }
  const url = port.sender?.url || "";
  getConfiguredOrigin().then((origin) => {
    if (!isAllowedBridgeUrl(url, origin)) {
      port.disconnect();
      return;
    }
    globalThis.__bridgePort = port;
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "bridge-hello") return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || "bridge error"));
    });
    port.onDisconnect.addListener(() => {
      if (globalThis.__bridgePort === port) globalThis.__bridgePort = null;
    });
  });
});

async function getSettings() {
  const defaults = {
    from: "auto",
    to: "en",
    bridgeOrigin: APP_ORIGIN,
  };
  const stored = await chrome.storage.sync.get(defaults);
  return { ...defaults, ...stored };
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "translate-selection",
    title: "Translate selection with translatasm",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "translate-page",
    title: "Translate page with translatasm",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "restore-page",
    title: "Restore original page text",
    contexts: ["page"],
  });
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping-content" });
    return;
  } catch {
    // not injected yet
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"],
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content/content.css"],
  });
}

async function resolveFrom(text, from) {
  if (from && from !== "auto") return from;
  const detected = await bridgeRequest({ type: "detect", text });
  return detected?.language || "en";
}

async function translateSelection(tabId) {
  await ensureContentScript(tabId);
  const sel = await chrome.tabs.sendMessage(tabId, { type: "get-selection" });
  if (!sel?.text?.trim()) throw new Error("No selection");
  const settings = await getSettings();
  const from = await resolveFrom(sel.text, settings.from);
  const result = await bridgeRequest({
    type: "translate",
    text: sel.text,
    from,
    to: settings.to,
  });
  await chrome.tabs.sendMessage(tabId, { type: "replace-selection", text: result.text });
  return result;
}

async function translatePage(tabId) {
  await ensureContentScript(tabId);
  const settings = await getSettings();
  await chrome.tabs.sendMessage(tabId, { type: "show-toast", text: "Collecting page text…", mode: "info" });
  const collected = await chrome.tabs.sendMessage(tabId, { type: "collect-page-text" });
  const chunks = collected?.chunks || [];
  if (!chunks.length) {
    await chrome.tabs.sendMessage(tabId, { type: "show-toast", text: "No translatable text found.", mode: "error" });
    return;
  }
  let from = settings.from;
  if (from === "auto") {
    from = await resolveFrom(chunks.slice(0, 3).join("\n"), "auto");
  }
  const translated = [];
  for (let i = 0; i < chunks.length; i++) {
    await chrome.tabs.sendMessage(tabId, {
      type: "show-toast",
      text: `Translating ${i + 1}/${chunks.length}…`,
      mode: "info",
    });
    const result = await bridgeRequest({
      type: "translate",
      text: chunks[i],
      from,
      to: settings.to,
      html: false,
    });
    translated.push(result.text);
  }
  await chrome.tabs.sendMessage(tabId, { type: "apply-page-translation", chunks: translated });
  await chrome.tabs.sendMessage(tabId, { type: "show-toast", text: "Page translated.", mode: "ok" });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "translate-selection" && info.selectionText && tab?.id) {
      const settings = await getSettings();
      const from = await resolveFrom(info.selectionText, settings.from);
      const result = await bridgeRequest({
        type: "translate",
        text: info.selectionText,
        from,
        to: settings.to,
        html: false,
      });
      await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        type: "show-toast",
        text: result.text,
        mode: "selection",
      });
    } else if (info.menuItemId === "translate-page" && tab?.id) {
      await translatePage(tab.id);
    } else if (info.menuItemId === "restore-page" && tab?.id) {
      await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: "restore-page" });
    }
  } catch (err) {
    if (tab?.id) {
      await ensureContentScript(tab.id).catch(() => {});
      await chrome.tabs.sendMessage(tab.id, {
        type: "show-toast",
        text: String(err?.message || err),
        mode: "error",
      }).catch(() => {});
    }
  }
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      if (command === "translate-page") await translatePage(tab.id);
      if (command === "translate-selection") await translateSelection(tab.id);
    } catch (err) {
      await ensureContentScript(tab.id).catch(() => {});
      await chrome.tabs.sendMessage(tab.id, {
        type: "show-toast",
        text: String(err?.message || err),
        mode: "error",
      }).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "ensure-bridge") {
      await ensureBridgeTab();
      await getBridgePort();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "get-settings") {
      sendResponse(await getSettings());
      return;
    }
    if (msg?.type === "save-settings") {
      await chrome.storage.sync.set(msg.settings || {});
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "detect-text") {
      const result = await bridgeRequest({ type: "detect", text: msg.text });
      sendResponse({ ok: true, result });
      return;
    }
    if (msg?.type === "translate-text") {
      let from = msg.from;
      if (!from || from === "auto") from = await resolveFrom(msg.text, "auto");
      const result = await bridgeRequest({
        type: "translate",
        text: msg.text,
        from,
        to: msg.to,
        html: Boolean(msg.html),
      });
      sendResponse({ ok: true, result });
      return;
    }
    if (msg?.type === "translate-selection") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      const result = await translateSelection(tab.id);
      sendResponse({ ok: true, result });
      return;
    }
    if (msg?.type === "translate-page") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      await translatePage(tab.id);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "restore-page") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: "restore-page" });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "open-app") {
      await chrome.tabs.create({ url: APP_ORIGIN + "/" });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unknown" });
  })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
