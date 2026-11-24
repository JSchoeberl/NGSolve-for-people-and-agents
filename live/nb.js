// Notebook page: render cells, run them in Pyodide, show outputs + widgets inline
import { WidgetManager } from "./widgets.js";

const PYODIDE = "https://mhochsteger.github.io/jupyterlite_ngsolve/static/pyodide/";
const PACKAGES = ["ngsolve", "ipython", "ipywidgets", "anywidget"];

const EMBED = globalThis.NB_EMBED || {};  // set by the single-file build
const params = new URLSearchParams(location.search);
const nbFile = params.get("nb") || "Piola.ipynb";
const $ = (s) => document.querySelector(s);
const statusEl = $("#status"), runAllBtn = $("#runall");
const cells = [];
let py = null, bridge = null, manager = null, lastCell = -1, busy = Promise.resolve();

function setStatus(text, state = "busy") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// markdown with $...$ math kept away from marked
function renderMarkdown(text) {
  const math = [];
  const keep = (m) => `\u0000${math.push(m) - 1}\u0000`;
  text = text
    .replace(/\$\$[\s\S]+?\$\$/g, keep)
    .replace(/\\\[[\s\S]+?\\\]/g, keep)
    .replace(/\\\([\s\S]+?\\\)/g, keep)
    .replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)\$/g, (m, pre, body) => pre + keep(`$${body}$`));
  let html = marked.parse(text);
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => math[+i].replace(/&/g, "&amp;").replace(/</g, "&lt;"));
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const a of div.querySelectorAll("a[href$='.ipynb']")) {
    const h = a.getAttribute("href");
    if (!/^https?:/.test(h)) a.href = `?nb=${encodeURIComponent(h)}`;
  }
  return div;
}

function typeset(el) {
  if (window.MathJax?.typesetPromise) return MathJax.typesetPromise([el]).catch(console.error);
}

// ---- output rendering (cells and Output widgets) ----
async function renderOne(out) {
  const t = out.output_type;
  if (t === "stream") {
    const pre = document.createElement("pre");
    pre.className = "out-stream" + (out.name === "stderr" ? " stderr" : "");
    pre.textContent = stripAnsi(src(out.text));
    return pre;
  }
  if (t === "error") {
    const pre = document.createElement("pre");
    pre.className = "out-stream stderr";
    pre.textContent = stripAnsi((out.traceback || []).join("\n"));
    return pre;
  }
  const d = out.data || {};
  const wv = d["application/vnd.jupyter.widget-view+json"];
  if (wv && manager) return manager.createView(wv.model_id);
  if (d["text/html"]) {
    const div = document.createElement("div");
    div.className = "out-html";
    div.innerHTML = src(d["text/html"]);
    typeset(div);
    return div;
  }
  for (const im of ["image/png", "image/jpeg", "image/gif"]) {
    if (d[im]) {
      const img = document.createElement("img");
      img.src = `data:${im};base64,${src(d[im])}`;
      return img;
    }
  }
  if (d["image/svg+xml"]) {
    const div = document.createElement("div");
    div.innerHTML = src(d["image/svg+xml"]);
    return div;
  }
  if (d["text/markdown"]) { const m = renderMarkdown(src(d["text/markdown"])); typeset(m); return m; }
  if (d["text/latex"]) { const div = document.createElement("div"); div.textContent = src(d["text/latex"]); typeset(div); return div; }
  if (d["text/plain"] != null) {
    const pre = document.createElement("pre");
    pre.className = "out-stream";
    pre.textContent = stripAnsi(src(d["text/plain"]));
    return pre;
  }
  return document.createTextNode("");
}

// appends with stream merging; keeps order even though widget views resolve async
function appendOutput(area, out) {
  const last = area.lastElementChild;
  if (out.output_type === "stream" && last?._stream === out.name) {
    last.textContent += stripAnsi(src(out.text));
    return;
  }
  const slot = document.createElement("div");
  slot.className = "out";
  if (out.output_type === "stream") slot._stream = out.name;
  area.append(slot);
  if (out.output_type === "stream") { slot.textContent = stripAnsi(src(out.text)); slot.classList.add("out-stream"); if (out.name === "stderr") slot.classList.add("stderr"); return; }
  renderOne(out).then((n) => slot.replaceChildren(n));
}

function renderOutputs(el, outputs) {
  el.replaceChildren();
  for (const o of outputs) appendOutput(el, o);
}

// ---- hooks called from bridge.py ----
globalThis.ngsnb = {
  output(cellId, json) {
    const c = cells[cellId] ?? cells[lastCell];
    if (!c) { console.log(json); return; }
    if (c.clearPending) { c.out.replaceChildren(); c.clearPending = false; }
    appendOutput(c.out, JSON.parse(json));
  },
  clear(cellId, wait) {
    const c = cells[cellId] ?? cells[lastCell];
    if (!c) return;
    if (wait) c.clearPending = true; else c.out.replaceChildren();
  },
  comm(type, id, data, buffers) {
    const bufs = buffers ? buffers.toJs ? buffers.toJs() : buffers : [];
    manager.handle(type, id, JSON.parse(data), bufs);
  },
};

// ---- notebook UI ----
function buildCell(cell, idx) {
  const wrap = document.createElement("section");
  if (cell.cell_type === "markdown") {
    wrap.className = "cell md";
    wrap.append(renderMarkdown(src(cell.source)));
    return wrap;
  }
  if (cell.cell_type !== "code") return wrap;
  wrap.className = "cell code";
  const head = document.createElement("div");
  head.className = "cell-head";
  const prompt = document.createElement("span");
  prompt.className = "prompt";
  prompt.textContent = "[ ]";
  const btn = document.createElement("button");
  btn.className = "run";
  btn.title = "Run cell (Shift+Enter)";
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg> Run`;
  head.append(prompt, btn);
  const code = document.createElement("pre");
  code.className = "src language-python";
  code.contentEditable = "plaintext-only";
  code.spellcheck = false;
  code.textContent = src(cell.source);
  hljs.highlightElement(code);
  code.addEventListener("blur", () => { const t = code.textContent; code.textContent = t; delete code.dataset.highlighted; hljs.highlightElement(code); });
  const out = document.createElement("div");
  out.className = "outputs";
  wrap.append(head, code, out);
  const c = { idx, wrap, code, out, prompt, btn, clearPending: false };
  cells[idx] = c;
  btn.addEventListener("click", () => runCell(c));
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); runCell(c); }
  });
  return wrap;
}

function runCell(c) {
  busy = busy.then(async () => {
    if (!bridge) return;
    c.out.replaceChildren();
    c.prompt.textContent = "[*]";
    c.wrap.classList.add("running");
    lastCell = c.idx;
    await new Promise((r) => setTimeout(r, 30)); // let the browser paint
    const t0 = performance.now();
    let res;
    try {
      res = JSON.parse(bridge.run(c.idx, c.code.textContent));
    } catch (err) {
      res = { ok: false, count: " " };
      appendOutput(c.out, { output_type: "stream", name: "stderr", text: String(err) });
    }
    c.prompt.textContent = `[${res.count}]`;
    c.prompt.title = `${((performance.now() - t0) / 1000).toFixed(2)} s`;
    c.wrap.classList.remove("running");
    c.wrap.classList.toggle("failed", !res.ok);
  });
  return busy;
}

async function runAll() {
  for (const c of cells.filter(Boolean)) await runCell(c);
}

async function main() {
  let nb;
  try {
    if (EMBED.notebook && !params.get("nb")) nb = EMBED.notebook;
    else {
      const r = await fetch(nbFile);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      nb = await r.json();
    }
  } catch (err) {
    setStatus(`Could not load ${nbFile}: ${err.message}`, "error");
    return;
  }
  document.title = (nb.cells.find((c) => c.cell_type === "markdown") && src(nb.cells.find((c) => c.cell_type === "markdown").source).match(/^#\s+(.*)/m)?.[1]) || nbFile;
  const main = $("#notebook");
  nb.cells.forEach((c, i) => main.append(buildCell(c, i)));
  await (window.MathJax?.startup?.promise);
  typeset(main);

  const t0 = performance.now();
  const tick = setInterval(() => { statusEl.dataset.time = `${((performance.now() - t0) / 1000).toFixed(0)} s`; }, 500);
  try {
    setStatus("Loading Python runtime…");
    py = await loadPyodide({ indexURL: PYODIDE });
    setStatus("Loading NGSolve, IPython, ipywidgets…");
    await py.loadPackage(PACKAGES, { messageCallback: () => {} });
    setStatus("Starting kernel…");
    py.setStdout({ batched: (s) => console.log(s) });
    py.setStderr({ batched: (s) => console.warn(s) });
    const code = EMBED.bridge ?? await (await fetch("bridge.py")).text();
    py.FS.writeFile("/home/pyodide/_nbbridge.py", code);
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
    bridge = py.pyimport("_nbbridge");
    manager = new WidgetManager((id, data, buffers) => bridge.recv(id, JSON.stringify(data), buffers?.length ? buffers : null), renderOutputs);
    ngsnb.manager = manager; ngsnb.pyodide = py;
  } catch (err) {
    clearInterval(tick);
    console.error(err);
    setStatus(`Failed to start: ${err.message || err}`, "error");
    return;
  }
  clearInterval(tick);
  const loadTime = ((performance.now() - t0) / 1000).toFixed(1);
  setStatus(`Running cells…`);
  runAllBtn.disabled = false;
  await runAll();
  setStatus(`Ready — NGSolve loaded in ${loadTime} s`, "ready");
  delete statusEl.dataset.time;
}

// inside an iframe: fit the frame to the content
if (window.frameElement) {
  new ResizeObserver(() => { window.frameElement.style.height = document.body.offsetHeight + 8 + "px"; }).observe(document.body);
}

runAllBtn.addEventListener("click", async () => {
  setStatus("Running cells…");
  await runAll();
  setStatus("Ready", "ready");
});

main();
