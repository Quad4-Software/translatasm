const $ = (id) => document.getElementById(id);
const status = $("status");
const meter = $("meter");
const meterBar = meter.querySelector("span");

function setStatus(msg) { status.textContent = msg || ""; }
function setBusy(on) {
  meter.classList.toggle("on", on);
  meterBar.style.width = on ? "65%" : "0%";
  for (const id of ["btn-translate","btn-page","btn-sel","btn-detect"]) {
    $(id).disabled = on;
  }
}
async function send(msg) { return chrome.runtime.sendMessage(msg); }

const settings = await send({ type: "get-settings" });
if (settings?.updateAvailable && settings?.remoteVersion) {
  setStatus(`Update ${settings.remoteVersion} available in Settings`);
}
if (settings?.from) $("from").value = settings.from;
if (settings?.to) $("to").value = settings.to;

async function persist() {
  await send({
    type: "save-settings",
    settings: {
      from: $("from").value,
      to: $("to").value,
    },
  });
}

$("from").addEventListener("change", persist);
$("to").addEventListener("change", persist);

$("btn-swap").addEventListener("click", async () => {
  const a = $("from").value;
  const b = $("to").value;
  if (a === "auto") return;
  $("from").value = b;
  $("to").value = a;
  const t = $("input").value;
  $("input").value = $("output").value;
  $("output").value = t;
  await persist();
});

$("btn-bridge").addEventListener("click", async () => {
  await persist();
  setStatus("Opening bridge…");
  const res = await send({ type: "ensure-bridge" });
  setStatus(res?.ok ? "Bridge tab ready." : (res?.error || "Failed"));
});

$("btn-detect").addEventListener("click", async () => {
  const text = $("input").value.trim();
  if (!text) return;
  setBusy(true);
  setStatus("Detecting…");
  const res = await send({ type: "detect-text", text });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Detect failed"); return; }
  const lang = res.result?.language;
  if (lang) {
    $("from").value = lang;
    await persist();
    setStatus("Detected: " + lang);
  } else {
    setStatus("Could not detect language");
  }
});

$("btn-translate").addEventListener("click", async () => {
  await persist();
  let from = $("from").value;
  const to = $("to").value;
  const text = $("input").value;
  if (!text.trim()) return;
  setBusy(true);
  if (from === "auto") {
    setStatus("Detecting…");
    const det = await send({ type: "detect-text", text });
    from = det?.result?.language || "en";
    $("from").value = from;
    await persist();
  }
  setStatus("Translating…");
  const res = await send({ type: "translate-text", text, from, to });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Error"); return; }
  $("output").value = res.result?.text || "";
  setStatus("Done");
});

$("btn-sel").addEventListener("click", async () => {
  await persist();
  setBusy(true);
  setStatus("Translating selection…");
  const res = await send({ type: "translate-selection" });
  setBusy(false);
  setStatus(res?.ok ? "Selection translated." : (res?.error || "Error"));
});

$("btn-page").addEventListener("click", async () => {
  await persist();
  setBusy(true);
  setStatus("Translating page…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) {
    try { await chrome.permissions.request({ origins: [new URL(tab.url).origin + "/*"] }); } catch {}
  }
  const res = await send({ type: "translate-page" });
  setBusy(false);
  setStatus(res?.ok ? "Page translated." : (res?.error || "Error"));
});

$("btn-restore").addEventListener("click", async () => {
  const res = await send({ type: "restore-page" });
  setStatus(res?.ok ? "Restored." : (res?.error || "Error"));
});


$("btn-settings").addEventListener("click", async () => {
  await send({ type: "open-options" });
});
