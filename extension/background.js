const DAEMON = "http://127.0.0.1:17321";
const BRIDGE_HEADERS = { "X-Cursor-Chrome-Bridge": "1" };
const POLL_ALARM = "chrome-bridge-poll";
const COMMAND_TIMEOUT_MS = 35_000;
const cache = new Map(); // tabId -> { elements, viewport }
const dbgOn = new Set();
let pumpRunning = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(task, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

async function resolveTab(cmd) {
  if (cmd.tabId != null) {
    const tabId = Number(cmd.tabId);
    if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
    await chrome.tabs.get(tabId);
    return tabId;
  }
  if (cmd.urlContains) {
    const tabs = await chrome.tabs.query({});
    const hits = tabs.filter((t) => (t.url || "").includes(cmd.urlContains));
    if (!hits.length) throw new Error(`no tab matching ${cmd.urlContains}`);
    if (hits.length > 1) {
      const choices = hits.slice(0, 5).map((t) => `${t.id}: ${t.title || ""} (${t.url || ""})`).join("; ");
      throw new Error(`multiple tabs match ${cmd.urlContains}; use tabId. ${choices}`);
    }
    return hits[0].id;
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("no active tab");
  return t.id;
}

function xyOf(cmd, tabId) {
  if (Array.isArray(cmd.coordinate) && cmd.coordinate.length >= 2) {
    return [cmd.coordinate[0], cmd.coordinate[1]];
  }
  if (cmd.x != null && cmd.y != null) return [cmd.x, cmd.y];
  const id = cmd.element ?? cmd.ref;
  if (id == null) return null;
  const hit = (cache.get(tabId)?.elements || []).find((e) => e.id === id);
  if (!hit) throw new Error(`element ${id} not in cache; capture first`);
  return [Math.round(hit.x + hit.w / 2), Math.round(hit.y + hit.h / 2)];
}

function formatIndex(elements) {
  return elements
    .map((e) => `#${e.id}  ${e.role} ${JSON.stringify(e.name)} @ (${e.x}, ${e.y}, ${e.w}, ${e.h})`)
    .join("\n");
}

// injected into the page; must be self-contained
function injectCollect() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "slider",
    "spinbutton",
    "treeitem",
    "listbox",
  ]);
  const TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);

  function nameOf(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("placeholder") ||
      (typeof el.value === "string" && el.type !== "password" ? el.value : "") ||
      (el.innerText || "").trim()
    )
      .replace(/\s+/g, " ")
      .slice(0, 60);
  }

  function isCandidate(el) {
    if (TAGS.has(el.tagName)) {
      if (el.tagName === "INPUT" && (el.type === "hidden" || el.type === "file")) return false;
      if (el.disabled) return false;
      return true;
    }
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    if (el.tabIndex >= 0) return true;
    try {
      if (getComputedStyle(el).cursor === "pointer") return true;
    } catch (_) {}
    return false;
  }

  function vis(el, x, y, w, h) {
    if (w < 8 || h < 8) return false;
    if (x + w < 0 || y + h < 0 || x > vw || y > vh) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  const raw = [];
  function walk(root, ox, oy) {
    if (!root) return;
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of nodes) {
      if (el.shadowRoot) walk(el.shadowRoot, ox, oy);
      if (!isCandidate(el)) continue;
      const r = el.getBoundingClientRect();
      const x = r.x + ox;
      const y = r.y + oy;
      if (!vis(el, x, y, r.width, r.height)) continue;
      raw.push({
        role: (el.getAttribute("role") || el.tagName.toLowerCase()).toLowerCase(),
        name: nameOf(el),
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
    for (const f of frames) {
      try {
        const fr = f.getBoundingClientRect();
        walk(f.contentDocument, ox + fr.x, oy + fr.y);
      } catch (_) {}
    }
  }
  walk(document, 0, 0);

  // ponytail: O(n²) leaf filter, n capped; spatial hash if pages hit 1k+ hits
  const area = vw * vh;
  const filtered = raw.filter((e) => e.w * e.h < area * 0.55 || raw.length < 4);
  const drop = new Set();
  for (let i = 0; i < filtered.length; i++) {
    for (let j = 0; j < filtered.length; j++) {
      if (i === j) continue;
      const a = filtered[i];
      const b = filtered[j];
      const inside =
        b.x >= a.x - 1 &&
        b.y >= a.y - 1 &&
        b.x + b.w <= a.x + a.w + 1 &&
        b.y + b.h <= a.y + a.h + 1;
      if (inside && b.w * b.h < a.w * a.h) drop.add(i);
    }
  }
  const leaves = filtered.filter((_, i) => !drop.has(i));
  const dedup = [];
  for (const e of leaves) {
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    const clash = dedup.find((d) => Math.hypot(d.x + d.w / 2 - cx, d.y + d.h / 2 - cy) < 12);
    if (clash) {
      if ((e.name && !clash.name) || e.w * e.h < clash.w * clash.h) {
        dedup[dedup.indexOf(clash)] = e;
      }
      continue;
    }
    dedup.push(e);
  }
  dedup.sort((a, b) => a.y - b.y || a.x - b.x);
  const elements = dedup.slice(0, 120).map((e, i) => ({ id: i + 1, ...e }));
  return { viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1 }, elements };
}

function injectClickXy(x, y) {
  const el = document.elementFromPoint(x, y);
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  const target = el || document.body;
  for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    target.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
  }
  return el ? { tag: el.tagName, text: (el.innerText || el.value || "").slice(0, 80) } : { miss: true };
}

function injectHoverXy(x, y) {
  const el = document.elementFromPoint(x, y) || document.body;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  return { tag: el.tagName };
}

function injectTypeAt(x, y, text) {
  const el = document.elementFromPoint(x, y) || document.activeElement;
  if (!el) throw new Error("no target to type into");
  el.focus();
  if ("value" in el) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }
  return { ok: true };
}

function injectRead(selector, maxChars) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error(`no element matching ${selector}`);
  const text = (root.innerText || root.textContent || "").replace(/\u00a0/g, " ");
  const limit = Math.max(1, Math.min(Number(maxChars) || 30000, 100000));
  return {
    title: document.title,
    url: location.href,
    selector: selector || "body",
    text: text.slice(0, limit),
    length: text.length,
    truncated: text.length > limit,
  };
}

async function injectWaitFor(selector, text, timeoutMs) {
  const timeout = Math.max(0, Math.min(Number(timeoutMs) || 10000, 30000));
  const expected = text == null ? "" : String(text);
  const matches = () => {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return false;
    return expected ? (root.innerText || root.textContent || "").includes(expected) : true;
  };
  const started = Date.now();
  while (!matches()) {
    if (Date.now() - started >= timeout) {
      throw new Error(`wait_for timed out: ${selector || "body"}${expected ? ` contains ${expected}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: true, selector: selector || "body", text: expected || null, waitedMs: Date.now() - started };
}

async function runInTab(tabId, func, args = []) {
  const [ret] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (ret?.error) throw new Error(String(ret.error));
  return ret?.result;
}

async function attachDbg(tabId) {
  if (dbgOn.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    dbgOn.add(tabId);
    return true;
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    if (/already attached/i.test(m)) {
      dbgOn.add(tabId);
      return true;
    }
    return false;
  }
}

if (typeof chrome !== "undefined") {
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId) dbgOn.delete(src.tabId);
  });
}

async function cdp(tabId, method, params) {
  if (!(await attachDbg(tabId))) throw new Error("debugger attach failed");
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function screenshotDataUrl(tabId) {
  if (await attachDbg(tabId)) {
    try {
      const { data } = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 70,
        fromSurface: true,
      });
      if (data) return `data:image/jpeg;base64,${data}`;
    } catch (_) {}
  }
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
}

async function annotateSom(dataUrl, pack) {
  const blob = await (await fetch(dataUrl)).blob();
  const img = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const sx = img.width / pack.viewport.w;
  const sy = img.height / pack.viewport.h;
  const fs = Math.max(11, Math.round(12 * Math.min(sx, sy)));
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textBaseline = "top";
  for (const el of pack.elements) {
    const x = el.x * sx;
    const y = el.y * sy;
    const w = el.w * sx;
    const h = el.h * sy;
    ctx.strokeStyle = "rgba(255, 90, 0, 0.95)";
    ctx.lineWidth = Math.max(1, Math.round(sx));
    ctx.strokeRect(x, y, w, h);
    const label = String(el.id);
    const pad = 3;
    const tw = ctx.measureText(label).width + pad * 2;
    const th = fs + pad * 2;
    let bx = x;
    let by = y - th;
    if (by < 0) by = y;
    ctx.fillStyle = "rgba(255, 90, 0, 0.92)";
    ctx.fillRect(bx, by, tw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, bx + pad, by + pad);
  }
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  return await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(out);
  });
}

async function mouse(tabId, x, y, spec) {
  const button = spec.button || "left";
  const count = spec.count || 1;
  if (await attachDbg(tabId)) {
    const base = { x, y, button, pointerType: "mouse" };
    await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
    for (let i = 1; i <= count; i++) {
      await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: i });
      await cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: i });
    }
    return { ok: true, via: "cdp", x, y, button, count };
  }
  if (count > 1) {
    await runInTab(tabId, injectClickXy, [x, y]);
    await runInTab(tabId, injectClickXy, [x, y]);
    return { ok: true, via: "dom", x, y, button, count };
  }
  return { ...(await runInTab(tabId, injectClickXy, [x, y])), via: "dom", x, y };
}

const KEYS = {
  return: { key: "Enter", code: "Enter", vk: 13 },
  enter: { key: "Enter", code: "Enter", vk: 13 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

async function holdMods(tabId, mods, down) {
  const map = { alt: "Alt", ctrl: "Control", control: "Control", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta" };
  for (const m of mods) {
    const k = map[m.toLowerCase()];
    if (!k) continue;
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: down ? "keyDown" : "keyUp",
      key: k,
      code: k === "Meta" ? "MetaLeft" : `${k}Left`,
    });
  }
}

async function pressKeys(tabId, combo) {
  const parts = String(combo)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const mods = parts.filter((p) => /^(alt|ctrl|control|shift|meta|cmd|command)$/.test(p));
  const rest = parts.filter((p) => !/^(alt|ctrl|control|shift|meta|cmd|command)$/.test(p));
  const token = rest.join("+") || "enter";
  if (!(await attachDbg(tabId))) throw new Error("key needs debugger; reload the extension");
  await holdMods(tabId, mods, true);
  const spec = KEYS[token] || { key: token.length === 1 ? token : token, code: token.length === 1 ? `Key${token.toUpperCase()}` : token, vk: token.toUpperCase().charCodeAt(0) };
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
  });
  await holdMods(tabId, mods.slice().reverse(), false);
  return { ok: true, keys: combo };
}

async function doCapture(tabId, mode) {
  const pack = await runInTab(tabId, injectCollect);
  cache.set(tabId, pack);
  const index = formatIndex(pack.elements);
  const tab = await chrome.tabs.get(tabId);
  const meta = { mode, tabId, url: tab.url, title: tab.title, elements: pack.elements, index, viewport: pack.viewport };
  if (mode === "ax") return meta;
  const raw = await screenshotDataUrl(tabId);
  const dataUrl = mode === "vision" ? raw : await annotateSom(raw, pack);
  return { ...meta, dataUrl };
}

async function withMods(tabId, cmd, fn) {
  const mods = cmd.modifiers || [];
  if (mods.length && (await attachDbg(tabId))) await holdMods(tabId, mods, true);
  try {
    return await fn();
  } finally {
    if (mods.length && dbgOn.has(tabId)) await holdMods(tabId, mods.slice().reverse(), false);
  }
}

function clickSpec(action, cmd) {
  if (action === "double_click") return { button: "left", count: 2 };
  if (action === "right_click") return { button: "right", count: 1 };
  if (action === "middle_click") return { button: "middle", count: 1 };
  return { button: cmd.button || "left", count: 1 };
}

async function handle(cmd) {
  let action = cmd.action;
  if (action === "screenshot") {
    action = "capture";
    cmd = { ...cmd, mode: cmd.mode || "vision" };
  }
  if (action === "snapshot") {
    action = "capture";
    cmd = { ...cmd, mode: "ax" };
  }
  if (action === "click_xy") action = "click";
  if (action === "list_apps") action = "tabs";
  if (action === "read_text") action = "read";
  if (action === "new_tab") action = "open";
  if (action === "close_tab") action = "close";

  if (action === "open") {
    if (!/^https?:\/\//i.test(String(cmd.url || ""))) throw new Error("open needs an http(s) URL");
    const tab = await chrome.tabs.create({ url: cmd.url, active: cmd.active !== false });
    return { ok: true, tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || "" };
  }

  if (action === "tabs") {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active }));
  }

  const tabId = await resolveTab(cmd);

  if (action === "wait") {
    await sleep(Math.min(Number(cmd.seconds || cmd.ms / 1000 || 0.5), 30) * 1000);
    return { ok: true };
  }
  if (action === "navigate") {
    if (!/^https?:\/\//i.test(String(cmd.url || ""))) throw new Error("navigate needs an http(s) URL");
    await chrome.tabs.update(tabId, { url: cmd.url });
    return { ok: true, tabId };
  }
  if (action === "back") {
    await chrome.tabs.goBack(tabId);
    return { ok: true };
  }
  if (action === "forward") {
    await chrome.tabs.goForward(tabId);
    return { ok: true };
  }
  if (action === "reload") {
    await chrome.tabs.reload(tabId);
    return { ok: true };
  }
  if (action === "focus_app") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true, tabId };
  }
  if (action === "close") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.remove(tabId);
    cache.delete(tabId);
    dbgOn.delete(tabId);
    return { ok: true, tabId, url: tab.url, title: tab.title || "" };
  }
  if (action === "evaluate") {
    if (cmd.allowUnsafe !== true) {
      throw new Error("evaluate is disabled by default; pass allowUnsafe=true only with explicit user approval");
    }
    // return a plain object so MV3 scripting always serializes a result
    return runInTab(
      tabId,
      (code) => {
        try {
          const v = (0, eval)(code);
          return { ok: true, value: v == null ? null : v };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
      [cmd.js]
    );
  }
  if (action === "read") {
    return runInTab(tabId, injectRead, [cmd.selector || "", cmd.maxChars]);
  }
  if (action === "wait_for") {
    return runInTab(tabId, injectWaitFor, [cmd.selector || "", cmd.text, cmd.timeoutMs || cmd.timeout]);
  }
  if (action === "capture") {
    return doCapture(tabId, cmd.mode || "som");
  }

  if (action === "click" || action === "double_click" || action === "right_click" || action === "middle_click" || action === "hover") {
    const pt = xyOf(cmd, tabId);
    if (!pt) throw new Error("need element, coordinate, or x/y");
    const [x, y] = pt;
    if (action === "hover") {
      if (await attachDbg(tabId)) {
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        return { ok: true, x, y };
      }
      return runInTab(tabId, injectHoverXy, [x, y]);
    }
    return withMods(tabId, cmd, () => mouse(tabId, x, y, clickSpec(action, cmd)));
  }

  if (action === "type") {
    const text = String(cmd.text ?? "");
    const aimed = cmd.element != null || cmd.ref != null || cmd.coordinate || (cmd.x != null && cmd.y != null);
    if (aimed) {
      const pt = xyOf(cmd, tabId);
      await mouse(tabId, pt[0], pt[1], { button: "left", count: 1 });
    }
    if (await attachDbg(tabId)) {
      await cdp(tabId, "Input.insertText", { text });
      return { ok: true, via: "cdp", n: text.length };
    }
    if (!aimed) throw new Error("type without debugger needs element or x/y");
    const pt = xyOf(cmd, tabId);
    return runInTab(tabId, injectTypeAt, [pt[0], pt[1], text]);
  }

  if (action === "fill") {
    const text = String(cmd.text ?? "");
    const aimed = cmd.element != null || cmd.ref != null || cmd.coordinate || (cmd.x != null && cmd.y != null);
    if (aimed) {
      const pt = xyOf(cmd, tabId);
      await mouse(tabId, pt[0], pt[1], { button: "left", count: 1 });
    }
    if (await attachDbg(tabId)) {
      const platform = await chrome.runtime.getPlatformInfo();
      await pressKeys(tabId, `${platform.os === "mac" ? "cmd" : "ctrl"}+a`);
      await cdp(tabId, "Input.insertText", { text });
      return { ok: true, via: "cdp", n: text.length };
    }
    if (!aimed) throw new Error("fill without debugger needs element or x/y");
    const pt = xyOf(cmd, tabId);
    return runInTab(tabId, injectTypeAt, [pt[0], pt[1], text]);
  }

  if (action === "key") {
    return pressKeys(tabId, cmd.keys || cmd.key || "enter");
  }

  if (action === "scroll") {
    const dir = cmd.direction || "down";
    const amount = Number(cmd.amount || 3);
    let x, y;
    try {
      [x, y] = xyOf(cmd, tabId);
    } catch (_) {
      const vp = cache.get(tabId)?.viewport || { w: 800, h: 600 };
      x = vp.w / 2;
      y = vp.h / 2;
    }
    const delta = amount * 120;
    const deltaX = dir === "left" ? -delta : dir === "right" ? delta : 0;
    const deltaY = dir === "up" ? -delta : dir === "down" ? delta : 0;
    if (await attachDbg(tabId)) {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
      return { ok: true, via: "cdp", direction: dir, amount };
    }
    await runInTab(tabId, (dx, dy) => window.scrollBy(dx, dy), [deltaX, deltaY]);
    return { ok: true, via: "dom", direction: dir, amount };
  }

  if (action === "drag") {
    const from = cmd.from_coordinate || (cmd.from_element != null ? xyOf({ element: cmd.from_element }, tabId) : xyOf(cmd, tabId));
    const to =
      cmd.to_coordinate ||
      (cmd.to_element != null ? xyOf({ element: cmd.to_element }, tabId) : null);
    if (!from || !to) throw new Error("drag needs from_element/to_element or from_coordinate/to_coordinate");
    const [x1, y1] = from;
    const [x2, y2] = to;
    if (await attachDbg(tabId)) {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = x1 + ((x2 - x1) * i) / steps;
        const y = y1 + ((y2 - y1) * i) / steps;
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
      }
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
      return { ok: true, via: "cdp", from: [x1, y1], to: [x2, y2] };
    }
    throw new Error("drag needs debugger; reload the extension");
  }

  throw new Error(`unknown action ${action}`);
}

async function runCmd(cmd) {
  const data = await handle(cmd);
  if (cmd.capture_after) {
    const tabId = data.tabId || (await resolveTab(cmd));
    const cap = await doCapture(tabId, cmd.mode || "som");
    return { ...data, ...cap, actionResult: { ...data } };
  }
  return data;
}

async function report(id, payload) {
  await fetch(`${DAEMON}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...BRIDGE_HEADERS },
    body: JSON.stringify({ id, ...payload }),
  });
}

async function pump() {
  for (;;) {
    try {
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#0a0" });
      const r = await fetch(`${DAEMON}/pull`, { headers: BRIDGE_HEADERS });
      const cmd = await r.json();
      if (cmd && !cmd.idle && cmd.id) {
        try {
          const data = await withTimeout(
            runCmd(cmd),
            COMMAND_TIMEOUT_MS,
            "command timed out; the action may have completed, verify before retrying"
          );
          await report(cmd.id, { ok: true, data });
        } catch (e) {
          await report(cmd.id, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      }
    } catch (_) {
      chrome.action.setBadgeText({ text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ color: "#a00" });
      await sleep(1500);
    }
  }
}

async function ensurePump() {
  if (pumpRunning) return;
  pumpRunning = true;
  try {
    await pump();
  } finally {
    pumpRunning = false;
  }
}

async function startBridge() {
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  void ensurePump();
}

if (typeof chrome !== "undefined") {
  chrome.runtime.onInstalled.addListener(() => void startBridge());
  chrome.runtime.onStartup.addListener(() => void startBridge());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) void ensurePump();
  });
  void startBridge();
}

if (typeof module !== "undefined") module.exports = { withTimeout };
