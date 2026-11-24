// Minimal Jupyter widget manager: anywidget + common ipywidgets views

function putBuffers(state, paths, buffers) {
  (paths || []).forEach((p, i) => {
    let obj = state;
    for (let j = 0; j < p.length - 1; j++) obj = obj[p[j]];
    const b = buffers[i];
    obj[p[p.length - 1]] = new DataView(b.buffer, b.byteOffset, b.byteLength);
  });
  return state;
}

function removeBuffers(state) {
  const paths = [], buffers = [];
  const walk = (obj, path) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v instanceof DataView || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        const u = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        paths.push([...path, k]); buffers.push(u);
        obj[k] = null;
      } else if (v && typeof v === "object") walk(v, [...path, k]);
    }
  };
  const s = structuredClone(state);
  walk(s, []);
  return { state: s, buffer_paths: paths, buffers };
}

class Model {
  constructor(manager, id, state) {
    this.manager = manager; this.model_id = id; this.state = state;
    this.listeners = {}; this.dirty = {};
    this.widget_manager = { get_model: (mid) => manager.getModel(mid) };
  }
  get(k) { return this.state[k]; }
  set(k, v) {
    if (typeof k === "object") { for (const [kk, vv] of Object.entries(k)) this.set(kk, vv); return; }
    this.state[k] = v; this.dirty[k] = v;
    this.trigger("change:" + k, this, v); this.trigger("change", this);
  }
  save_changes() {
    const d = this.dirty; this.dirty = {};
    if (Object.keys(d).length) this.manager.sendUpdate(this.model_id, d);
  }
  touch() { this.save_changes(); }
  send(content, callbacks, buffers) {
    this.manager.sendRaw(this.model_id, { method: "custom", content }, buffers);
  }
  on(evs, cb) { for (const e of evs.split(" ")) (this.listeners[e] ||= new Set()).add(cb); }
  off(evs, cb) {
    if (!evs) { this.listeners = {}; return; }
    for (const e of evs.split(" ")) cb ? this.listeners[e]?.delete(cb) : delete this.listeners[e];
  }
  trigger(e, ...args) { for (const cb of [...(this.listeners[e] || [])]) { try { cb(...args); } catch (err) { console.error(err); } } }
  _update(state) {
    for (const [k, v] of Object.entries(state)) { this.state[k] = v; this.trigger("change:" + k, this, v); }
    this.trigger("change", this);
  }
}

const unref = (v) => (typeof v === "string" && v.startsWith("IPY_MODEL_") ? v.slice(10) : v);

function fmt(f, v) {
  if (v == null) return "";
  let m;
  if (f && (m = f.match(/\.(\d+)f/))) return v.toFixed(+m[1]);
  if (f && (m = f.match(/\.(\d+)e/))) return v.toExponential(+m[1]);
  if (f && (m = f.match(/\.(\d+)g/))) return (+v.toPrecision(+m[1])).toString();
  if (f === "d") return Math.round(v).toString();
  return String(+(+v).toPrecision(8));
}

export class WidgetManager {
  constructor(sendToKernel, renderOutputs) {
    this.models = new Map(); this.waiters = new Map();
    this.sendToKernel = sendToKernel; this.renderOutputs = renderOutputs;
    this.pending = new Map(); this.flushScheduled = false;
    this.esmCache = new Map();
  }

  handle(type, id, data, buffers) {
    if (type === "comm_open") {
      const m = new Model(this, id, putBuffers(data.state || {}, data.buffer_paths, buffers));
      this.models.set(id, m);
      (this.waiters.get(id) || []).forEach((r) => r(m)); this.waiters.delete(id);
    } else if (type === "comm_msg") {
      const m = this.models.get(id);
      if (!m) return;
      if (data.method === "update") m._update(putBuffers(data.state || {}, data.buffer_paths, buffers));
      else if (data.method === "custom") m.trigger("msg:custom", data.content, (buffers || []).map((b) => new DataView(b.buffer, b.byteOffset, b.byteLength)));
    } else if (type === "comm_close") {
      this.models.get(id)?.trigger("destroy");
      this.models.delete(id);
    }
  }

  getModel(id) {
    id = unref(id);
    if (this.models.has(id)) return Promise.resolve(this.models.get(id));
    return new Promise((r) => (this.waiters.get(id) || this.waiters.set(id, []).get(id)).push(r));
  }

  // coalesce rapid updates (sliders) into one message per frame
  sendUpdate(id, state) {
    Object.assign(this.pending.get(id) || this.pending.set(id, {}).get(id), state);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }
  flush() {
    this.flushScheduled = false;
    const p = this.pending; this.pending = new Map();
    for (const [id, st] of p) {
      const { state, buffer_paths, buffers } = removeBuffers(st);
      this.sendToKernel(id, { method: "update", state, buffer_paths }, buffers);
    }
  }
  sendRaw(id, data, buffers) {
    this.flush();
    this.sendToKernel(id, data, buffers);
  }

  async createView(modelId) {
    const model = await this.getModel(modelId);
    const el = document.createElement("div");
    el.className = "jw";
    try {
      await this.renderInto(model, el);
    } catch (err) {
      console.error(err);
      el.textContent = `[widget error: ${err}]`;
    }
    return el;
  }

  async childViews(ids) {
    return Promise.all((ids || []).map((c) => this.createView(c)));
  }

  async applyLayout(model, el) {
    const lid = model.get("layout");
    if (!lid) return;
    const lm = await this.getModel(lid);
    const apply = () => {
      for (const [k, v] of Object.entries(lm.state)) {
        if (k.startsWith("_") || v == null || typeof v === "object") continue;
        el.style.setProperty(k.replace(/_/g, "-"), v);
      }
    };
    apply(); lm.on("change", apply);
  }

  async renderInto(model, el) {
    const mod = model.get("_model_module"), view = model.get("_view_name");
    if (mod === "anywidget") return this.renderAny(model, el);
    const fn = this["view_" + view];
    if (!fn) { el.textContent = `[${model.get("_model_name")} not supported]`; return; }
    await fn.call(this, model, el);
    await this.applyLayout(model, el);
    const vis = () => (el.classList.toggle("jw-disabled", !!model.get("disabled")));
    vis(); model.on("change:disabled", vis);
  }

  async renderAny(model, el) {
    const esm = model.get("_esm");
    let mod = this.esmCache.get(esm);
    if (!mod) {
      const url = /^https?:\/\//.test(esm) ? esm : URL.createObjectURL(new Blob([esm], { type: "text/javascript" }));
      mod = import(url).then(async (m) => {
        let w = m.default;
        if (typeof w === "function") w = await w();
        return w;
      });
      this.esmCache.set(esm, mod);
    }
    const w = await mod;
    const css = model.get("_css");
    if (css && !document.querySelector(`style[data-anywidget="${model.get("_anywidget_id") || ""}"]`)) {
      const s = document.createElement("style");
      s.dataset.anywidget = model.get("_anywidget_id") || "";
      s.textContent = css; document.head.appendChild(s);
    }
    if (!model._initialized) { model._initialized = true; await w.initialize?.({ model, experimental: {} }); }
    await w.render?.({ model, el, experimental: {} });
  }

  labeled(model, el, control) {
    el.classList.add("jw-row");
    const lab = document.createElement("label");
    lab.className = "jw-desc";
    const upd = () => { lab.innerHTML = model.get("description") || ""; lab.style.display = lab.innerHTML ? "" : "none"; };
    upd(); model.on("change:description", upd);
    el.append(lab, control);
  }

  slider(model, el, { isInt = false, log = false } = {}) {
    const inp = document.createElement("input");
    inp.type = "range";
    const out = document.createElement("span");
    out.className = "jw-readout";
    const toS = (v) => (log ? Math.log(v) / Math.log(model.get("base")) : v);
    const fromS = (s) => (log ? Math.pow(model.get("base"), s) : isInt ? Math.round(s) : s);
    const sync = () => {
      inp.min = model.get("min"); inp.max = model.get("max"); inp.step = model.get("step") ?? (isInt ? 1 : 0.01);
      inp.value = toS(model.get("value"));
      out.textContent = fmt(model.get("readout_format") || (isInt ? "d" : null), model.get("value"));
      out.style.display = model.get("readout") === false ? "none" : "";
      inp.disabled = !!model.get("disabled");
    };
    sync(); model.on("change", sync);
    const push = (final) => {
      const v = fromS(+inp.value);
      out.textContent = fmt(model.get("readout_format") || (isInt ? "d" : null), v);
      if (final || model.get("continuous_update")) { model.set("value", v); model.save_changes(); }
    };
    inp.addEventListener("input", () => push(false));
    inp.addEventListener("change", () => push(true));
    const wrap = document.createElement("span");
    wrap.className = "jw-slider";
    wrap.append(inp, out);
    this.labeled(model, el, wrap);
  }
  view_FloatSliderView(m, el) { this.slider(m, el); }
  view_IntSliderView(m, el) { this.slider(m, el, { isInt: true }); }
  view_FloatLogSliderView(m, el) { this.slider(m, el, { log: true }); }

  view_CheckboxView(model, el) {
    const inp = document.createElement("input");
    inp.type = "checkbox";
    const sync = () => { inp.checked = !!model.get("value"); };
    sync(); model.on("change:value", sync);
    inp.addEventListener("change", () => { model.set("value", inp.checked); model.save_changes(); });
    this.labeled(model, el, inp);
  }

  view_ToggleButtonView(model, el) {
    const b = document.createElement("button");
    b.className = "jw-button";
    const sync = () => { b.textContent = model.get("description"); b.classList.toggle("on", !!model.get("value")); };
    sync(); model.on("change", sync);
    b.addEventListener("click", () => { model.set("value", !model.get("value")); model.save_changes(); });
    el.append(b);
  }

  view_ButtonView(model, el) {
    const b = document.createElement("button");
    b.className = "jw-button";
    const sync = () => { b.textContent = model.get("description"); b.title = model.get("tooltip") || ""; };
    sync(); model.on("change", sync);
    b.addEventListener("click", () => model.send({ event: "click" }));
    el.append(b);
  }

  select(model, el, multiple = false) {
    const s = document.createElement("select");
    const sync = () => {
      s.innerHTML = "";
      (model.get("_options_labels") || []).forEach((l, i) => s.add(new Option(l, i)));
      s.selectedIndex = model.get("index") ?? -1;
    };
    sync(); model.on("change", sync);
    s.addEventListener("change", () => { model.set("index", s.selectedIndex); model.save_changes(); });
    this.labeled(model, el, s);
  }
  view_DropdownView(m, el) { this.select(m, el); }
  view_SelectView(m, el) { this.select(m, el); }

  view_RadioButtonsView(model, el) {
    const box = document.createElement("span");
    box.className = "jw-radios";
    const name = "r" + model.model_id;
    const sync = () => {
      box.innerHTML = "";
      (model.get("_options_labels") || []).forEach((l, i) => {
        const lab = document.createElement("label");
        const r = document.createElement("input");
        r.type = "radio"; r.name = name; r.checked = model.get("index") === i;
        r.addEventListener("change", () => { model.set("index", i); model.save_changes(); });
        lab.append(r, " " + l); box.append(lab);
      });
    };
    sync(); model.on("change", sync);
    this.labeled(model, el, box);
  }

  view_ToggleButtonsView(model, el) {
    const box = document.createElement("span");
    const sync = () => {
      box.innerHTML = "";
      (model.get("_options_labels") || []).forEach((l, i) => {
        const b = document.createElement("button");
        b.className = "jw-button" + (model.get("index") === i ? " on" : "");
        b.textContent = l;
        b.addEventListener("click", () => { model.set("index", i); model.save_changes(); });
        box.append(b);
      });
    };
    sync(); model.on("change", sync);
    this.labeled(model, el, box);
  }

  text(model, el, kind) {
    const inp = document.createElement(kind === "area" ? "textarea" : "input");
    if (kind === "num") inp.type = "number";
    if (kind === "pw") inp.type = "password";
    const sync = () => { if (document.activeElement !== inp) inp.value = model.get("value") ?? ""; inp.placeholder = model.get("placeholder") || ""; };
    sync(); model.on("change", sync);
    const push = () => {
      let v = inp.value;
      if (kind === "num") { v = +v; if (model.get("_model_name").startsWith("Int") || model.get("_model_name").startsWith("BoundedInt")) v = Math.round(v); }
      model.set("value", v); model.save_changes();
    };
    inp.addEventListener(kind === "num" ? "change" : "input", () => { if (kind === "num" || model.get("continuous_update")) push(); });
    inp.addEventListener("change", push);
    if (kind !== "area") inp.addEventListener("keydown", (e) => { if (e.key === "Enter") model.send({ event: "submit" }); });
    this.labeled(model, el, inp);
  }
  view_TextView(m, el) { this.text(m, el, "text"); }
  view_PasswordView(m, el) { this.text(m, el, "pw"); }
  view_TextareaView(m, el) { this.text(m, el, "area"); }
  view_FloatTextView(m, el) { this.text(m, el, "num"); }
  view_IntTextView(m, el) { this.text(m, el, "num"); }

  html(model, el, raw) {
    const span = document.createElement("span");
    const sync = () => {
      if (raw) span.innerHTML = model.get("value") ?? ""; else span.textContent = model.get("value") ?? "";
      if (window.MathJax?.typesetPromise) MathJax.typesetPromise([span]).catch(() => {});
    };
    sync(); model.on("change:value", sync);
    this.labeled(model, el, span);
  }
  view_LabelView(m, el) { this.html(m, el, false); }
  view_HTMLView(m, el) { this.html(m, el, true); }
  view_HTMLMathView(m, el) { this.html(m, el, true); }

  view_ProgressView(model, el) {
    const p = document.createElement("progress");
    const sync = () => { p.min = model.get("min"); p.max = model.get("max") - model.get("min"); p.value = model.get("value") - model.get("min"); };
    sync(); model.on("change", sync);
    this.labeled(model, el, p);
  }

  view_ImageView(model, el) {
    const img = document.createElement("img");
    const sync = () => {
      const v = model.get("value");
      if (v) img.src = URL.createObjectURL(new Blob([v], { type: "image/" + model.get("format") }));
      if (model.get("width")) img.width = model.get("width");
      if (model.get("height")) img.height = model.get("height");
    };
    sync(); model.on("change", sync);
    el.append(img);
  }

  async box(model, el, cls) {
    el.classList.add("jw-box", cls);
    const sync = async () => {
      const kids = await this.childViews(model.get("children"));
      el.replaceChildren(...kids);
    };
    await sync(); model.on("change:children", sync);
  }
  view_BoxView(m, el) { return this.box(m, el, "jw-vbox"); }
  view_VBoxView(m, el) { return this.box(m, el, "jw-vbox"); }
  view_HBoxView(m, el) { return this.box(m, el, "jw-hbox"); }
  view_GridBoxView(m, el) { return this.box(m, el, "jw-grid"); }

  async view_TabView(model, el) {
    el.classList.add("jw-tabs");
    const bar = document.createElement("div"); bar.className = "jw-tabbar";
    const body = document.createElement("div");
    const sync = async () => {
      const kids = await this.childViews(model.get("children"));
      const titles = model.get("titles") || [];
      bar.replaceChildren(...kids.map((_, i) => {
        const b = document.createElement("button");
        b.className = "jw-button" + (model.get("selected_index") === i ? " on" : "");
        b.textContent = titles[i] ?? `Tab ${i}`;
        b.addEventListener("click", () => { model.set("selected_index", i); model.save_changes(); });
        return b;
      }));
      body.replaceChildren(kids[model.get("selected_index") ?? 0] || "");
    };
    await sync(); model.on("change", sync);
    el.append(bar, body);
  }
  view_AccordionView(m, el) { return this.view_TabView(m, el); }
  view_StackView(m, el) { return this.view_TabView(m, el); }

  view_OutputView(model, el) {
    el.classList.add("jw-output");
    const sync = () => this.renderOutputs(el, model.get("outputs") || []);
    sync(); model.on("change:outputs", sync);
  }
}
