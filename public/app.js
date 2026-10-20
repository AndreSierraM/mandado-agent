/* Mandado frontend: single state object + render(). */
"use strict";

var EXAMPLES = [
  "Audífonos con ANC, máx USD 120, llegan antes del viernes",
  "Cafetera espresso, máx USD 200, antes del lunes",
  "Bicicleta urbana con cambios, máx USD 350, entrega rápida"
];

var REASON_LABELS = {
  deadline: "Fuera de plazo",
  over_cap: "Excede tope",
  no_stock: "Sin stock",
  no_deal: "Sin acuerdo"
};

var state = {
  view: "create", // create|loading|negotiating|proposal|authorized|completed|voided|error
  text: "",
  mandadoId: null,
  limits: null,
  stores: freshStores(),
  proposal: null,
  payment: null,
  error: "",
  busy: false,
  busyLabel: "",
  awaitingApproval: false,
  approveUrl: "",
  expanded: { A: false, B: false, C: false }
};

var es = null;
var sseDone = false;
var isMobileQuery = window.matchMedia ? window.matchMedia("(max-width: 640px)") : { matches: false };

/* ---- pacing queue (point 1) ---- */
var eventQueue = [];
var queueBusy = false;
var renderedMids = new Set();

function isFastMode() {
  try {
    var p = new URLSearchParams(window.location.search);
    if (p.get("fast") === "1") return true;
  } catch (e) { /* noop */ }
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  } catch (e) { /* noop */ }
  return false;
}

function pacingDelay(type) {
  if (isFastMode()) return 0;
  if (type === "store_message") return 550;
  return 300;
}

function clearPacing() {
  eventQueue = [];
  queueBusy = false;
}

function clearRendered() {
  renderedMids = new Set();
}

function enqueueEvent(type, raw) {
  eventQueue.push({ type: type, raw: raw });
  pumpQueue();
}

function pumpQueue() {
  if (queueBusy) return;
  if (!eventQueue.length) return;
  queueBusy = true;
  var next = eventQueue.shift();
  var d = pacingDelay(next.type);
  if (d <= 0) {
    applyEvent(next.type, next.raw);
    queueBusy = false;
    if (eventQueue.length) pumpQueue();
    return;
  }
  setTimeout(function () {
    applyEvent(next.type, next.raw);
    queueBusy = false;
    if (eventQueue.length) pumpQueue();
  }, d);
}

function isMobile() {
  try {
    if (window.matchMedia) return window.matchMedia("(max-width: 640px)").matches;
  } catch (e) { /* noop */ }
  return !!(isMobileQuery && isMobileQuery.matches);
}

function freshStores() {
  return {
    A: { messages: [], discarded: null },
    B: { messages: [], discarded: null },
    C: { messages: [], discarded: null }
  };
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n) {
  if (n == null || n === "" || isNaN(Number(n))) return "";
  var v = Number(n);
  if (Number.isInteger(v)) return "USD " + v;
  return "USD " + v.toFixed(2);
}

/* Point 3: latest STORE offer price (not buyer opening). */
function latestStorePrice(store) {
  var msgs = store.messages || [];
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.from === "store" && m.price != null && m.price !== "" && !isNaN(Number(m.price))) {
      return Number(m.price);
    }
  }
  return null;
}

function stepForView() {
  var v = state.view;
  if (v === "create" || v === "loading") return 1;
  if (v === "negotiating") return 2;
  if (v === "proposal" || v === "authorized" || v === "completed" || v === "voided") return 3;
  // error: infer from progress
  if (state.proposal || state.payment) return 3;
  if (state.limits) return 2;
  return 1;
}

function updateStepper() {
  var step = stepForView();
  var items = document.querySelectorAll("#stepper li");
  for (var i = 0; i < items.length; i++) {
    var n = Number(items[i].getAttribute("data-step"));
    items[i].classList.toggle("active", n === step);
    items[i].classList.toggle("done", n < step);
  }
}

function limitChipsHtml(limits) {
  if (!limits) return "";
  var out = "";
  if (limits.maxAmount != null) {
    out += '<span class="pill">\uD83D\uDCB0 Tope ' + esc(money(limits.maxAmount)) + "</span>";
  }
  if (limits.deadline) {
    out += '<span class="pill">\uD83D\uDCC5 Antes del ' + esc(limits.deadline) + "</span>";
  }
  var attrs = limits.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i]) out += '<span class="pill">\u2728 ' + esc(attrs[i]) + "</span>";
  }
  if (!out) return "";
  return '<div class="limitbar">' + out + "</div>";
}

/* Point 2: fade-in only for newly added bubbles; final opacity 1 + AA colors in CSS. */
function bubbleHtml(m, mid) {
  var animCls = "seen";
  if (mid && !renderedMids.has(mid)) animCls = "fresh";
  if (mid) renderedMids.add(mid);
  if (m.rejection) {
    var rp = m.rejectedPrice != null ? m.rejectedPrice : m.price;
    var rtxt = "Excede tu tope \u00B7 rechazado " + money(rp);
    return '<div class="bubble alert ' + animCls + '">' + esc(rtxt) + "</div>";
  }
  var cls = m.from === "buyer" ? "agent" : "store-m";
  var body = esc(m.text || "");
  var sub = "";
  if (m.price != null && m.price !== "" && m.from === "store") {
    sub = '<span class="sub">' + esc(money(m.price)) + "</span>";
  } else if (m.price != null && m.price !== "" && m.from === "buyer") {
    sub = '<span class="sub">Ofrece ' + esc(money(m.price)) + "</span>";
  }
  return '<div class="bubble ' + cls + " " + animCls + '">' + body + sub + "</div>";
}

function statusChipHtml(id) {
  var s = state.stores[id] || { messages: [], discarded: null };
  var isWinner = !!(state.proposal && state.proposal.storeId === id);
  if (isWinner) return '<span class="status won">Ganadora</span>';
  if (s.discarded) {
    var reason = s.discarded.reason || s.discarded;
    if (reason === "not_chosen") return '<span class="status neutral">No elegida</span>';
    if (reason === "no_deal" && storeHasAcceptedOffer(s)) return '<span class="status neutral">No elegida</span>';
    var label = REASON_LABELS[reason] || String(reason || "Descartada");
    return '<span class="status out">Descartada: ' + esc(label) + "</span>";
  }
  if (!isWinner && state.proposal && storeHasAcceptedOffer(s)) return '<span class="status neutral">No elegida</span>';
  return '<span class="status live"><span class="pulse"></span>Negociando\u2026</span>';
}

/* Non-winner with an accepted offer (action 'accept' or 'Trato hecho' text)
   is "No elegida", not "Sin acuerdo". Checks the last store message first,
   falling back to any accepted offer in the thread. */
function storeHasAcceptedOffer(store) {
  var msgs = (store && store.messages) || [];
  var lastStoreMsg = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].from === "store") { lastStoreMsg = msgs[i]; break; }
  }
  if (lastStoreMsg && isAcceptMessage(lastStoreMsg)) return true;
  for (var j = 0; j < msgs.length; j++) {
    var m = msgs[j];
    if (m && m.from === "store" && isAcceptMessage(m)) return true;
  }
  return false;
}

function isAcceptMessage(m) {
  if (!m) return false;
  if (m.action === "accept") return true;
  var t = String(m.text || "");
  if (/trato\s+hecho/i.test(t)) return true;
  return false;
}

function priceForCard(id) {
  var isWinner = !!(state.proposal && state.proposal.storeId === id);
  if (isWinner && state.proposal && state.proposal.finalPrice != null) {
    return Number(state.proposal.finalPrice);
  }
  var s = state.stores[id];
  return s ? latestStorePrice(s) : null;
}

function priceHtmlFor(id) {
  var v = priceForCard(id);
  if (v == null) return "";
  return '<p class="price-label">\u00DAltima oferta</p><div class="best">' + esc(money(v)) + "</div>";
}

/* Point 5: desktop shows all messages; mobile last 2 + Ver hilo. */
function storeCardHtml(id) {
  var s = state.stores[id] || { messages: [], discarded: null };
  var isWinner = !!(state.proposal && state.proposal.storeId === id);
  var cls = "store" + (s.discarded ? " discarded" : "") + (isWinner ? " winner" : "");
  var statusHtml = statusChipHtml(id);
  var priceHtml = priceHtmlFor(id);
  var msgs = s.messages || [];
  var mobile = isMobile();
  var expanded = !!state.expanded[id];
  var start = 0;
  var showToggle = false;
  if (mobile && !expanded && msgs.length > 2) {
    start = msgs.length - 2;
    showToggle = true;
  } else if (expanded && msgs.length > 2) {
    showToggle = true;
  }
  var thread = "";
  for (var i = start; i < msgs.length; i++) thread += bubbleHtml(msgs[i], id + "-" + i);
  var toggle = "";
  if (showToggle || (msgs.length > 2 && mobile)) {
    toggle = expanded
      ? '<button class="link-btn" data-toggle="' + id + '">Ocultar</button>'
      : '<button class="link-btn" data-toggle="' + id + '">Ver hilo (' + msgs.length + ")</button>";
  }
  return (
    '<article class="' + cls + '" id="store-' + id + '">' +
    '<div class="store-head"><span class="avatar ' + id + '">' + id + "</span>" +
    '<span class="store-name">Tienda ' + id + "</span>" + statusHtml + "</div>" +
    priceHtml +
    '<div class="thread scroll">' + thread + "</div>" +
    toggle +
    "</article>"
  );
}

/* Point 6 (mobile proposal view): compact one-line summary + Ver negociación toggle. */
function storeCompactHtml(id) {
  var s = state.stores[id] || { messages: [], discarded: null };
  var isWinner = !!(state.proposal && state.proposal.storeId === id);
  var cls = "store compact" + (s.discarded ? " discarded" : "") + (isWinner ? " winner" : "");
  var statusHtml = statusChipHtml(id);
  var pv = priceForCard(id);
  var priceTxt = pv != null ? esc(money(pv)) : "";
  var expanded = !!state.expanded[id];
  var msgs = s.messages || [];
  var detail = "";
  if (expanded) {
    var thread = "";
    for (var i = 0; i < msgs.length; i++) thread += bubbleHtml(msgs[i], id + "-" + i);
    detail = '<div class="thread">' + thread + "</div>";
  }
  var toggle = expanded
    ? '<button class="link-btn" data-toggle="' + id + '">Ocultar</button>'
    : '<button class="link-btn" data-toggle="' + id + '">Ver negociaci\u00F3n</button>';
  return (
    '<article class="' + cls + '" id="store-' + id + '">' +
    '<div class="compact-row"><span class="avatar ' + id + '">' + id + "</span>" +
    '<span class="store-name">Tienda ' + id + "</span>" + statusHtml +
    '<span class="compact-price">' + priceTxt + "</span></div>" +
    detail + toggle +
    "</article>"
  );
}

function storesHtml() {
  return '<section class="stores">' + storeCardHtml("A") + storeCardHtml("B") + storeCardHtml("C") + "</section>";
}

function storesCompactHtml() {
  return '<section class="stores">' + storeCompactHtml("A") + storeCompactHtml("B") + storeCompactHtml("C") + "</section>";
}

function progressHtml() {
  // 3 dots: Propuesta -> Reservado -> Cobrado, or Propuesta -> Reservado -> Anulado on void path.
  var voided = state.view === "voided";
  var payStatus = state.payment ? state.payment.status : null;
  var hasProposal = !!state.proposal;
  var reserved = !!payStatus || state.view === "authorized" || state.view === "completed" || voided;
  var cobrado = payStatus === "CAPTURED";
  var s1 = hasProposal || reserved || cobrado ? "ok" : "";
  var s2 = reserved || cobrado ? (voided ? "ok" : "on") : "";
  if (voided) {
    return (
      '<div class="progress" aria-label="Progreso del pago">' +
      '<span class="pdot ok"><span class="d"></span>Propuesta</span><span class="arrow">\u2192</span>' +
      '<span class="pdot ok"><span class="d"></span>Reservado</span><span class="arrow">\u2192</span>' +
      '<span class="pdot bad"><span class="d"></span>Anulado</span>' +
      "</div>"
    );
  }
  var c3 = cobrado ? "ok" : "";
  return (
    '<div class="progress" aria-label="Progreso del pago">' +
    '<span class="pdot ' + s1 + '"><span class="d"></span>Propuesta</span><span class="arrow">\u2192</span>' +
    '<span class="pdot ' + s2 + '"><span class="d"></span>Reservado</span><span class="arrow">\u2192</span>' +
    '<span class="pdot ' + c3 + '"><span class="d"></span>Cobrado</span>' +
    "</div>"
  );
}

/* Point 6: always header, total, savings, CTA — in that order. */
function proposalCardHtml() {
  var p = state.proposal;
  if (!p || !p.storeId) return "";
  var ship = p.shipping === 0 || p.shipping === "0" ? "Env\u00EDo gratis" : (p.shipping != null ? "Env\u00EDo " + money(p.shipping) : "");
  var arr = p.deliveryDate ? "llega " + p.deliveryDate : "";
  var meta = [ship, arr].filter(Boolean).join(" \u00B7 ");
  var metaHtml = meta ? '<p class="meta-line">' + esc(meta) + "</p>" : "";
  var saveHtml = "";
  if (p.savings != null && p.listPrice != null) {
    saveHtml =
      '<div class="save-row"><span class="save-badge">Ahorras ' + esc(money(p.savings)) + "</span>" +
      '<span class="strike">' + esc(money(p.listPrice)) + "</span></div>";
  }
  var cta;
  if (state.busy) {
    cta = '<button class="btn primary block" disabled><span class="spinner"></span>' + esc(state.busyLabel || "Reservando en PayPal\u2026") + "</button>";
  } else if (state.awaitingApproval) {
    cta =
      (state.approveUrl ? '<p class="meta-line"><a href="' + esc(state.approveUrl) + '" target="_blank" rel="noopener">Abrir PayPal</a></p>' : "") +
      '<div class="proposal-cta"><button class="btn primary block" data-action="already-approved">Ya aprob\u00E9</button></div>';
  } else {
    cta =
      '<div class="proposal-cta"><button class="btn primary block" data-action="approve">Aprobar con PayPal</button>' +
      '<button class="btn ghost block" data-action="discard">Descartar</button></div>';
  }
  return (
    '<section class="card decision">' +
    '<div class="proposal-top"><span class="avatar ' + esc(p.storeId) + '">' + esc(p.storeId) + "</span>" +
    '<strong>Tienda ' + esc(p.storeId) + "</strong></div>" +
    '<div class="total">' + esc(money(p.total != null ? p.total : p.finalPrice)) + "</div>" +
    metaHtml + saveHtml + progressHtml() + cta +
    "</section>"
  );
}

/* Point 7: compact receipt row for terminal states. */
function receiptHtml() {
  var p = state.proposal;
  var sid = p && p.storeId ? p.storeId : "C";
  var item = (state.limits && state.limits.item) || "Aud\u00EDfonos con ANC";
  var amt = "";
  if (state.payment && state.payment.amount != null) amt = money(state.payment.amount);
  else if (p && p.total != null) amt = money(p.total);
  else if (p && p.finalPrice != null) amt = money(p.finalPrice);
  return (
    '<div class="receipt-row"><span class="avatar ' + esc(sid) + '">' + esc(sid) + "</span>" +
    '<span><span class="r-name">Tienda ' + esc(sid) + " \u00B7 " + esc(item) + "</span><br>" +
    '<span class="r-sub">PayPal</span></span>' +
    '<span class="r-amt">' + esc(amt) + "</span></div>"
  );
}

function render() {
  document.body.dataset.view = state.view;
  updateStepper();
  var app = document.getElementById("app");
  var html = "";
  var v = state.view;

  if (v === "create" || v === "loading") {
    var chips = "";
    for (var i = 0; i < EXAMPLES.length; i++) {
      chips += '<button class="chip-btn" data-example="' + i + '">' + esc(EXAMPLES[i]) + "</button>";
    }
    var btnInner = state.busy
      ? '<span class="spinner"></span>Leyendo tu pedido\u2026'
      : "Enviar a mi agente";
    html =
      '<section class="hero hero-center"><h1>Tu agente negocia. PayPal retiene. T\u00FA decides.</h1></section>' +
      '<section class="card"><textarea id="ask" placeholder="\u00BFQu\u00E9 necesitas? Ej: Aud\u00EDfonos con ANC, m\u00E1x USD 120, antes del viernes">' + esc(state.text) + "</textarea>" +
      '<div class="chips">' + chips + "</div>" +
      '<button class="btn primary block" id="send"' + (state.text.trim() && !state.busy ? "" : " disabled") + ">" + btnInner + "</button>" +
      '<p style="margin:8px 0 0"><span class="pill tiny">Modo demo \u00B7 sin cargos reales</span></p></section>' +
      '<section class="how-row" aria-label="C\u00F3mo funciona">' +
      '<div class="how-card"><span class="ico">\uD83E\uDDfe</span>Pide lo que necesitas</div>' +
      '<div class="how-card"><span class="ico">\uD83E\uDD1D</span>Tu agente negocia solo</div>' +
      '<div class="how-card"><span class="ico">\uD83D\uDD12</span>PayPal retiene tu dinero</div>' +
      "</section>";
    if (v === "loading") {
      html += '<div class="skel-grid"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
    }
  } else if (v === "negotiating") {
    html =
      '<div class="negobar" role="status"><span class="spinner dark"></span>Tu agente est\u00E1 negociando\u2026</div>' +
      limitChipsHtml(state.limits) + storesHtml();
  } else if (v === "proposal") {
    if (isMobile()) {
      html = limitChipsHtml(state.limits) + proposalCardHtml() + storesCompactHtml();
    } else {
      html = limitChipsHtml(state.limits) + proposalCardHtml() + storesHtml();
    }
  } else if (v === "authorized") {
    var amt = state.payment && state.payment.amount != null ? money(state.payment.amount) : (state.proposal ? money(state.proposal.total) : "");
    html =
      '<section class="card center narrow">' +
      '<div class="badge-circle blue">\uD83D\uDD12</div><h2>Dinero retenido</h2>' +
      (amt ? "<p>" + esc(amt) + " reservado en PayPal. A\u00FAn no se cobra.</p>" : "<p>Reservado en PayPal. A\u00FAn no se cobra.</p>") +
      receiptHtml() +
      '<p><span class="pill blue">AUTHORIZED</span></p>' +
      progressHtml() +
      (state.busy
        ? '<button class="btn primary block" disabled><span class="spinner"></span>' + esc(state.busyLabel || "Procesando\u2026") + "</button>"
        : '<div class="btn-row"><button class="btn green" data-action="capture">Capturar pago</button>' +
          '<button class="btn danger-outline" data-action="void">Anular</button></div>') +
      "</section>";
  } else if (v === "completed") {
    var orderId = state.payment ? state.payment.orderId || "" : "";
    var authId = state.payment ? state.payment.authorizationId || "" : "";
    var mono = orderId || authId ? '<p class="mono">Orden ' + esc(orderId) + " \u00B7 Captura " + esc(authId) + "</p>" : "";
    html =
      '<section class="card center narrow">' +
      '<div class="badge-circle green">\u2713</div><h2>Pago completado</h2>' +
      receiptHtml() +
      '<p><span class="pill green">COMPLETED</span></p>' + mono + progressHtml() +
      '<button class="btn primary block" data-action="reset">Nuevo mandado</button></section>';
  } else if (v === "voided") {
    html =
      '<section class="card center narrow">' +
      '<div class="badge-circle red">\u21A9</div><h2>Autorizaci\u00F3n anulada</h2><p>No se cobr\u00F3 nada.</p>' +
      receiptHtml() +
      '<p><span class="pill red">VOIDED</span></p>' + progressHtml() +
      '<button class="btn primary block" data-action="reset">Nuevo mandado</button></section>';
  } else if (v === "error") {
    html =
      '<section class="card error-card center">' +
      '<div class="big-ico">\u26A0\uFE0F</div><h2>Algo sali\u00F3 mal</h2>' +
      "<p>" + esc(state.error || "Error desconocido") + "</p>" +
      '<button class="btn primary block" data-action="retry">Reintentar</button></section>';
  }

  app.innerHTML = html;
  bind();
  /* Point 5: keep desktop threads pinned to the latest message. */
  try {
    var threads = app.querySelectorAll(".thread.scroll");
    for (var t = 0; t < threads.length; t++) {
      threads[t].scrollTop = threads[t].scrollHeight;
    }
  } catch (e) { /* noop */ }
}

function bind() {
  var ta = document.getElementById("ask");
  if (ta) {
    ta.addEventListener("input", function () {
      state.text = ta.value;
      var btn = document.getElementById("send");
      if (btn) btn.disabled = !ta.value.trim() || state.busy;
    });
  }
  var ex = document.querySelectorAll("[data-example]");
  for (var i = 0; i < ex.length; i++) {
    ex[i].addEventListener("click", function () {
      var idx = Number(this.getAttribute("data-example"));
      state.text = EXAMPLES[idx];
      var t = document.getElementById("ask");
      if (t) t.value = state.text;
      var btn = document.getElementById("send");
      if (btn) btn.disabled = false;
      if (t) t.focus();
    });
  }
  var send = document.getElementById("send");
  if (send) send.addEventListener("click", startMandado);

  var toggles = document.querySelectorAll("[data-toggle]");
  for (var k = 0; k < toggles.length; k++) {
    toggles[k].addEventListener("click", function () {
      var id = this.getAttribute("data-toggle");
      state.expanded[id] = !state.expanded[id];
      render();
    });
  }

  var acts = document.querySelectorAll("[data-action]");
  for (var a = 0; a < acts.length; a++) {
    acts[a].addEventListener("click", function () {
      var act = this.getAttribute("data-action");
      if (act === "approve") doAuthorize();
      else if (act === "already-approved") doApproved();
      else if (act === "capture") doCapture();
      else if (act === "void") doVoid();
      else if (act === "reset") resetAll();
      else if (act === "retry") retry();
      else if (act === "discard") resetAll();
    });
  }
}

function fail(msg) {
  state.busy = false;
  state.error = msg;
  state.view = "error";
  render();
}

function closeSse() {
  if (es) {
    try { es.close(); } catch (e) { /* noop */ }
    es = null;
  }
}

function resetAll() {
  closeSse();
  clearPacing();
  clearRendered();
  state.view = "create";
  state.mandadoId = null;
  state.limits = null;
  state.stores = freshStores();
  state.proposal = null;
  state.payment = null;
  state.error = "";
  state.busy = false;
  state.awaitingApproval = false;
  state.approveUrl = "";
  state.expanded = { A: false, B: false, C: false };
  render();
}

function retry() {
  if (state.text && state.text.trim() && !state.mandadoId) {
    startMandado();
    return;
  }
  if (state.mandadoId && (state.view === "error") && !state.payment) {
    // re-attach to replay stream
    clearPacing();
    connectSse(state.mandadoId);
    state.view = state.proposal ? "proposal" : (state.limits ? "negotiating" : "loading");
    state.error = "";
    render();
    return;
  }
  resetAll();
}

function startMandado() {
  var text = state.text && state.text.trim() ? state.text.trim() : "";
  var ta = document.getElementById("ask");
  if (ta) text = ta.value.trim();
  if (!text) return;
  state.text = text;
  state.view = "loading";
  state.busy = true;
  state.busyLabel = "Leyendo tu pedido\u2026";
  state.error = "";
  state.limits = null;
  state.stores = freshStores();
  state.proposal = null;
  state.payment = null;
  state.awaitingApproval = false;
  state.approveUrl = "";
  state.expanded = { A: false, B: false, C: false };
  clearPacing();
  clearRendered();
  render();

  fetch("/api/mandados", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text })
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        fail((data && data.error) || "No se pudo crear el mandado");
        return;
      }
      state.mandadoId = data.id;
      state.busy = false;
      state.view = "negotiating";
      // limits arrive via SSE replay too; seed from POST for speed
      if (data.limits) state.limits = data.limits;
      render();
      connectSse(data.id);
    });
  }).catch(function () {
    fail("Error de conexi\u00F3n. Reintenta.");
  });
}

/* Applied one-by-one through the pacing queue (point 1). */
function applyEvent(type, raw) {
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (type === "limits") {
    state.limits = data.limits;
    if (state.view === "loading") state.view = "negotiating";
    state.busy = false;
  } else if (type === "store_message") {
    var sid = data.storeId;
    if (sid && state.stores[sid]) {
      state.stores[sid].messages.push(data);
      if (state.view === "loading") { state.view = "negotiating"; state.busy = false; }
    }
  } else if (type === "store_discarded") {
    /* Point 4: always update, even if it arrives after other events. */
    var id = data.storeId;
    if (id && state.stores[id]) {
      state.stores[id].discarded = { reason: data.reason, detail: data.detail || null };
    }
  } else if (type === "proposal") {
    if (!data.storeId) {
      fail("No se logr\u00F3 un acuerdo dentro del tope.");
      return;
    }
    state.proposal = data;
    /* Point 1: only switch to proposal view once the queued proposal is applied. */
    state.view = "proposal";
    state.busy = false;
  } else if (type === "payment_update") {
    if (data.payment) {
      state.payment = data.payment;
      var ps = data.payment.status;
      if (ps === "AUTHORIZED") { state.view = "authorized"; state.busy = false; state.awaitingApproval = false; }
      else if (ps === "CAPTURED") { state.view = "completed"; state.busy = false; }
      else if (ps === "VOIDED") { state.view = "voided"; state.busy = false; }
    }
  } else if (type === "error") {
    fail(data.message || "Error del servidor");
    return;
  } else if (type === "done") {
    sseDone = true;
    closeSse();
    /* Point 4: anything still negotiating and not the winner -> Sin acuerdo,
       unless it had an accepted offer (then neutral 'No elegida'). */
    var ids = ["A", "B", "C"];
    for (var i = 0; i < ids.length; i++) {
      var k = ids[i];
      var isWin = !!(state.proposal && state.proposal.storeId === k);
      if (!isWin && state.stores[k] && !state.stores[k].discarded) {
        if (storeHasAcceptedOffer(state.stores[k])) {
          state.stores[k].discarded = { reason: "not_chosen", detail: null };
        } else {
          state.stores[k].discarded = { reason: "no_deal", detail: null };
        }
      }
    }
    if ((state.view === "negotiating" || state.view === "loading") && !state.proposal) {
      if (data && data.status === "no_deal") fail("No se logr\u00F3 un acuerdo dentro del tope.");
      else if (!state.proposal) { state.busy = false; }
    }
    render();
    return;
  }
  render();
}

function handleEventData(type, raw) {
  enqueueEvent(type, raw);
}

function connectSse(id) {
  closeSse();
  clearPacing();
  sseDone = false;
  // fresh per mandado (server replays past events); keep rendered set fresh too
  state.stores = freshStores();
  clearRendered();
  var url = "/api/mandados/" + encodeURIComponent(id) + "/events";
  es = new EventSource(url);
  var types = ["limits", "store_message", "store_discarded", "proposal", "payment_update", "error", "done"];
  types.forEach(function (t) {
    es.addEventListener(t, function (e) { handleEventData(t, e.data); });
  });
  es.onerror = function () {
    if (!sseDone && (state.view === "negotiating" || state.view === "loading")) {
      // only fail if we never got a proposal and stream broke
      if (!state.proposal && state.view === "loading") fail("Error de conexi\u00F3n. Reintenta.");
    }
  };
}

function postPayment(path) {
  return fetch("/api/mandados/" + encodeURIComponent(state.mandadoId) + path, { method: "POST" })
    .then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ("Error " + res.status));
        return data;
      });
    });
}

function isMockUrl(url) {
  return /MOCK/i.test(url || "");
}

function doAuthorize() {
  if (!state.mandadoId) return;
  state.busy = true;
  state.busyLabel = "Reservando en PayPal\u2026";
  render();
  postPayment("/authorize").then(function (data) {
    var url = data.approveUrl || "";
    if (!isMockUrl(url) && url) {
      // real PayPal: open approval tab, wait for human
      state.busy = false;
      state.awaitingApproval = true;
      state.approveUrl = url;
      try { window.open(url, "_blank", "noopener"); } catch (e) { /* noop */ }
      render();
      return;
    }
    // demo/mock: auto-approve
    doApproved(data);
  }).catch(function (err) {
    fail(err.message || "No se pudo autorizar");
  });
}

function doApproved(pre) {
  state.busy = true;
  state.busyLabel = "Reservando en PayPal\u2026";
  render();
  postPayment("/approved").then(function (data) {
    state.busy = false;
    state.awaitingApproval = false;
    state.payment = data;
    var ps = data.status;
    if (ps === "AUTHORIZED") state.view = "authorized";
    else if (ps === "CAPTURED") state.view = "completed";
    else if (ps === "VOIDED") state.view = "voided";
    else state.view = "authorized";
    render();
  }).catch(function (err) {
    fail(err.message || "No se pudo autorizar");
  });
}

function doCapture() {
  state.busy = true;
  state.busyLabel = "Capturando pago\u2026";
  render();
  postPayment("/capture").then(function (data) {
    state.busy = false;
    state.payment = data;
    state.view = "completed";
    render();
  }).catch(function (err) {
    fail(err.message || "No se pudo capturar");
  });
}

function doVoid() {
  state.busy = true;
  state.busyLabel = "Anulando\u2026";
  render();
  postPayment("/void").then(function (data) {
    state.busy = false;
    state.payment = data;
    state.view = "voided";
    render();
  }).catch(function (err) {
    fail(err.message || "No se pudo anular");
  });
}

if (isMobileQuery && isMobileQuery.addEventListener) {
  isMobileQuery.addEventListener("change", function () { render(); });
}

(function init() {
  var params = new URLSearchParams(window.location.search);
  if (params.get("state") === "error") {
    state.view = "error";
    state.error = "Demo de error";
    render();
    return;
  }
  if (params.get("state") === "loading") {
    state.view = "loading";
    state.busy = true;
    render();
    return;
  }
  render();
})();
