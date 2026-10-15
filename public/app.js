function money(n) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "USD" }).format(n);
}

function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderMessageBubble(msg, storeId) {
  const isBuyer = msg.from === "buyer";
  const className = `message-bubble ${isBuyer ? "buyer" : "store"}`;
  const bubble = document.createElement("div");
  bubble.className = className;

  let content = "";

  const storeLabel = isBuyer ? "Tu agente" : storeId ? `Tienda ${storeId}` : "Tienda X";

  if (msg.rejection) {
    const rejectedPrice = msg.rejectedPrice !== undefined ? money(msg.rejectedPrice) : "";
    const round = msg.round !== undefined ? msg.round : "";
    const roundHtml = round ? `<span class="round">${round}</span><br/>` : "";
    content = `${storeLabel}<br/>${roundHtml}⛔ Excede tu tope: rechazado ${rejectedPrice}`;
  } else {
    const round = msg.round !== undefined ? msg.round : "";
    const textEscaped = escapeHTML(msg.text || "");
    const roundHtml = round ? `<span class="round">${round}</span><br/>` : "";
    content = `${storeLabel}<br/>${roundHtml}${textEscaped}`;
    if (msg.price !== undefined) {
      content += `<br/><span class="price">${money(msg.price)}</span>`;
    }
  }

  bubble.innerHTML = content;
  return bubble;
}

function renderLimitsChips(limits) {
  const chipsDiv = document.getElementById("limits-chips");
  if (!limits) {
    chipsDiv.innerHTML = "";
    return;
  }
  chipsDiv.innerHTML = "";
  chipsDiv.insertAdjacentHTML("beforeend", `<span class="chip">Tope USD ${limits.maxAmount}</span>`);
  const deadlineText = limits.deadline ? `Plazo ${limits.deadline}` : "Sin plazo";
  chipsDiv.insertAdjacentHTML("beforeend", `<span class="chip">${deadlineText}</span>`);
  if (limits.attributes && limits.attributes.length > 0) {
    const attrText = `Atributos: ${limits.attributes.join(", ")}`;
    chipsDiv.insertAdjacentHTML("beforeend", `<span class="chip">${attrText}</span>`);
  }
}

function renderStoreColumn(storeData, storeId, limits, discarded) {
  const col = document.createElement("div");
  col.className = "column";
  col.id = "col-" + storeId;

  if (discarded && discarded[storeId]) {
    col.classList.add("discarded");
    const reason = discarded[storeId];
    const reasonLabels = {
      deadline: "Fuera de plazo",
      over_cap: "Excede tope",
      no_stock: "Sin stock",
      no_deal: "Sin acuerdo",
    };
    const reasonDetail = reason || "";
    const badge = document.createElement("div");
    badge.className = `discarded-badge ${reason}`;
    badge.textContent = reasonLabels[reason] || reasonDetail;
    col.style.borderColor = "#95a5a6";
    col.appendChild(badge);
  }

  const header = document.createElement("div");
  header.className = "header";
  header.textContent = `Tienda ${storeId}`;
  col.appendChild(header);

  const messagesDiv = document.createElement("div");
  messagesDiv.className = "messages";
  col.appendChild(messagesDiv);

  const msgs = storeData ? storeData.messages : [];
  for (const msg of msgs) {
    const bubble = renderMessageBubble(msg, storeId);
    messagesDiv.appendChild(bubble);
  }

  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return col;
}

function renderProposalCard(proposal, limits) {
  const card = document.getElementById("proposal-card");
  const winnerBadge = document.getElementById("winner-badge");
  const storeNameEl = document.getElementById("store-name");
  const detailsEl = document.getElementById("details");
  const threadEl = document.getElementById("thread");

  winnerBadge.textContent = `Ganadora: Tienda ${proposal.storeId}`;
  storeNameEl.textContent = proposal.storeName || `Tienda ${proposal.storeId}`;

  const listPrice = limits && limits.listPrice ? limits.listPrice : (proposal.listPrice || 0);
  const savings = listPrice - proposal.finalPrice;

  const shippingText = proposal.shipping === 0 ? "Gratis" : money(proposal.shipping);
  const total = proposal.finalPrice + (proposal.shipping || 0);

  detailsEl.innerHTML = `
    <div class="details-row">
      <span class="label">Precio final</span>
      <span class="value">${money(proposal.finalPrice)}</span>
    </div>
    <div class="details-row">
      <span class="label">Envío</span>
      <span class="value">${shippingText}</span>
    </div>
    <div class="details-row">
      <span class="label">Total</span>
      <span class="value">${money(total)}</span>
    </div>
    <div class="details-row">
      <span class="label">Ahorras</span>
      <span class="value">${money(savings)}</span>
    </div>
    <div class="details-row">
      <span class="label">Entrega</span>
      <span class="value">${proposal.deliveryDate || "N/A"}</span>
    </div>
    <div class="details-row">
      <span class="label">Precio de lista</span>
      <span class="value">${money(listPrice)}</span>
    </div>
  `;

  if (threadEl) {
    const threads = proposal.threads || [];
    threadEl.innerHTML = `
      <details>
        <summary>Hilo de la negociación</summary>
    `;
    for (const t of threads) {
      const msgClass = t.from === "buyer" ? "thread-message buyer" : "thread-message store";
      threadEl.insertAdjacentHTML("beforeend", `<div class="${msgClass}">${t.text || ""}</div>`);
    }
    threadEl.insertAdjacentHTML("beforeend", `</details>`);
  }

  card.classList.add("visible");
}

function renderPaymentPanel(payment, status) {
  const panel = document.getElementById("payment-panel");
  const statePill = document.getElementById("state-pill");
  const approveUrlDiv = document.getElementById("approve-url");
  const authorizeBtn = document.getElementById("authorize-btn");
  const approvedBtn = document.getElementById("approved-btn");
  const captureBtn = document.getElementById("capture-btn");
  const voidBtn = document.getElementById("void-btn");

  statePill.textContent = "";
  approveUrlDiv.textContent = "";
  authorizeBtn.style.display = "none";
  approvedBtn.style.display = "none";
  captureBtn.style.display = "none";
  voidBtn.style.display = "none";

  const statusLabels = {
    READY: "READY",
    CREATED: "CREATED",
    AUTHORIZED: "AUTHORIZED",
    COMPLETED: "COMPLETED",
    VOIDED: "VOIDED",
  };

  const statusColors = {
    READY: "#003087",
    CREATED: "#003087",
    AUTHORIZED: "#0070e0",
    COMPLETED: "#1e8e3e",
    VOIDED: "#c5221f",
  };

  const displayStatus = status === "CAPTURED" ? "COMPLETED" : status;

  statePill.style.background = statusColors[status] || "#666666";
    statePill.style.color = "white";

  let pillText = "";

  switch (displayStatus) {
    case "READY":
      pillText = "Listo para autorizar";
      authorizeBtn.style.display = "block";
      break;
    case "CREATED":
      pillText = "CREATED · orden creada, falta tu aprobación";
      if (payment && payment.approveUrl) {
        approveUrlDiv.innerHTML = `<a href="${payment.approveUrl}" target="_blank">Abrir PayPal (sandbox)</a>`;
        approveUrlDiv.style.display = "block";
      } else {
        approveUrlDiv.style.display = "none";
      }
      approvedBtn.style.display = "block";
      break;
    case "AUTHORIZED":
      pillText = "AUTHORIZED · dinero retenido, no cobrado";
      captureBtn.style.display = "block";
      voidBtn.style.display = "block";
      break;
    case "COMPLETED":
      const orderId = payment ? payment.orderId : "";
      const authId = payment ? payment.authorizationId : "";
      pillText = `COMPLETED · cobrado Orden ${orderId} · Autorización ${authId}`;
      break;
    case "VOIDED":
      pillText = "VOIDED · autorización anulada, no se cobró";
      break;
  }

  statePill.textContent = pillText;
  statePill.style.display = "inline-flex";

  updateTimeline(status);
panel.classList.add("visible");
}

function getPaymentSubText(status, payment) {
  if (status === "AUTHORIZED") {
    return "dinero retenido, no cobrado";
  }
  if (status === "CAPTURED" || status === "COMPLETED") {
    return payment ? `cobrado ${payment.authorizationId || ""}` : "";
  }
  if (status === "VOIDED") {
    return "autorización anulada, no se cobró";
  }
  return "";
}

function updateTimeline(status) {
  const timeline = document.getElementById("timeline");
  if (!timeline) return;
  if (status === "CAPTURED") status = "COMPLETED";
  const steps = ["CREATED", "AUTHORIZED", "COMPLETED", "VOIDED"];
  steps.forEach((step, i) => {
    const li = timeline.children[i];
    li.classList.remove("active", "done");
    if (i < steps.indexOf(status)) {
      li.classList.add("done");
    } else if (step === status) {
      li.classList.add("active");
    }
  });
}

async function startSse(id) {
  const source = new EventSource(`/api/mandados/${id}/events`);

  const columnsDiv = document.getElementById("columns");
  const proposalCard = document.getElementById("proposal-card");
  const apiError = document.getElementById("api-error");
  const paymentPanel = document.getElementById("payment-panel");

  // Render 3 EMPTY columns A, B, C - let SSE replay fill messages
  columnsDiv.innerHTML = "";
  for (const sid of ["A", "B", "C"]) {
    const col = renderStoreColumn(null, sid, null, {});
    columnsDiv.appendChild(col);
  }
  proposalCard.classList.remove("visible");
  apiError.classList.remove("visible");
  paymentPanel.classList.remove("visible");

  function handleEvent(data) {
    const type = data.type;

    if (type === "limits") {
      renderLimitsChips(data.limits);
    } else if (type === "store_message") {
      const sid = data.storeId;
      const cols = columnsDiv.querySelectorAll(".column");
      const col = Array.from(cols).find(c => c.id === "col-" + sid);
      if (col) {
        const messagesDiv = col.querySelector(".messages");
        if (messagesDiv) {
          const bubble = renderMessageBubble(data, sid);
          messagesDiv.appendChild(bubble);
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
      }
    } else if (type === "store_discarded") {
      const sid = data.storeId;
      const cols = columnsDiv.querySelectorAll(".column");
      const col = Array.from(cols).find(c => c.id === "col-" + sid);
      if (col) {
        // Remove existing discard badge
        const existing = col.querySelector(".discarded-badge");
        if (existing) existing.remove();
        // Add new badge
        const reasonLabels = {
          deadline: "Fuera de plazo",
          over_cap: "Excede tope",
          no_stock: "Sin stock",
          no_deal: "Sin acuerdo",
        };
        const badge = document.createElement("div");
        badge.className = `discarded-badge ${data.reason}`;
        badge.textContent = reasonLabels[data.reason] || (data.detail || "");
        col.appendChild(badge);
        col.style.borderColor = "#95a5a6";
      }
    } else if (type === "proposal") {
      renderProposalCard(data, data.limits ? data.limits : null);
      if (data.payment) {
        renderPaymentPanel(data.payment, data.payment.status);
      } else {
        renderPaymentPanel({}, "READY");
      }
      // Add winner class to the store column
      const cols = columnsDiv.querySelectorAll(".column");
      const winnerCol = Array.from(cols).find(c => c.id === "col-" + data.storeId);
      if (winnerCol) {
        winnerCol.classList.add("winner");
      }
    } else if (type === "payment_update") {
      if (data.payment && data.status) {
        renderPaymentPanel(data.payment, data.status);
      }
    } else if (type === "error") {
      apiError.textContent = `Error: ${data.message || "Error desconocido"}`;
      apiError.classList.add("visible");
    } else if (type === "done") {
      source.close();
    }
  }

  source.addEventListener("limits", (e) => handleEvent(JSON.parse(e.data)), false);
  source.addEventListener("store_message", (e) => handleEvent(JSON.parse(e.data)), false);
  source.addEventListener("store_discarded", (e) => handleEvent(JSON.parse(e.data)), false);
  source.addEventListener("proposal", (e) => handleEvent(JSON.parse(e.data)), false);
  source.addEventListener("payment_update", (e) => handleEvent(JSON.parse(e.data)), false);
  source.addEventListener("error", (e) => handleEvent(JSON.parse(e.data)), false);
  source.addEventListener("done", (e) => handleEvent(JSON.parse(e.data)), false);

  source.onerror = (err) => {
    console.error("SSE error", err);
    source.close();
  };
}

async function createMandado(text) {
  const res = await fetch("/api/mandados", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  const data = await res.json();
  const apiError = document.getElementById("api-error");

  if (!res.ok) {
    apiError.textContent = `Error: ${data.error || "Unknown error"}`;
    apiError.classList.add("visible");
    return null;
  }

  apiError.classList.remove("visible");
  currentId = data.id;

  // Render limits chips from POST response
  renderLimitsChips(data.limits);

  // Start SSE - SSE will also replay limits, which will re-render chips
  startSse(data.id);

  // Enable new mandado button
  document.getElementById("new-mandado").style.display = "block";

  return data;
}

function renderState(state) {
  const columnsDiv = document.getElementById("columns");
  const proposalCard = document.getElementById("proposal-card");
  const apiError = document.getElementById("api-error");
  const paymentPanel = document.getElementById("payment-panel");

  // Clear columns
  columnsDiv.innerHTML = "";

  if (!state || !state.id) {
    proposalCard.classList.remove("visible");
    apiError.classList.remove("visible");
    paymentPanel.classList.remove("visible");
    return;
  }

  // Determine discarded per store
  const discarded = state.discarded || {};

  // Render 3 store columns from stores.A/B/C
  const storeIds = ["A", "B", "C"];
  for (const sid of storeIds) {
    const storeData = state.stores ? state.stores[sid] : null;
    const col = renderStoreColumn(storeData, sid, state.limits, discarded);
    columnsDiv.appendChild(col);
  }

  // Render proposal card if present
  if (state.proposal && state.proposal.storeId) {
    renderProposalCard(state.proposal, state.limits);
  } else {
    proposalCard.classList.remove("visible");
  }

  // Handle API errors
  if (state.error) {
    apiError.textContent = `Error: ${state.error}`;
    apiError.classList.add("visible");
  } else {
    apiError.classList.remove("visible");
  }

  // Handle payment state
  if (state.payment) {
    renderPaymentPanel(state.payment, state.status);
  }
}

let currentId = null;
let currentLimits = null;

document.getElementById("send-btn").addEventListener("click", async () => {
  const text = document.getElementById("mandado-text").value.trim();
  const apiError = document.getElementById("api-error");
  if (!text) {
    apiError.textContent = "Error: texto inválido";
    apiError.classList.add("visible");
    return;
  }
  apiError.classList.remove("visible");
  await createMandado(text);
});

document.getElementById("mandado-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    document.getElementById("send-btn").click();
  }
});

document.getElementById("new-mandado").addEventListener("click", () => {
  const source = document.getElementById("sse-source");
  if (source) {
    source.close();
    source.remove();
  }
  currentId = null;
  currentLimits = null;
  document.getElementById("mandado-text").value = "Audífonos con ANC, máx USD 120, llegan antes del viernes";
  document.getElementById("limits-chips").innerHTML = "";
  document.getElementById("columns").innerHTML = "";
  document.getElementById("proposal-card").classList.remove("visible");
  document.getElementById("payment-panel").classList.remove("visible");
  document.getElementById("api-error").classList.remove("visible");
  document.getElementById("winner-badge").parentElement.classList.remove("winner");
});

document.getElementById("authorize-btn").addEventListener("click", async () => {
  const btn = document.getElementById("authorize-btn");
  btn.disabled = true;
  btn.textContent = "Procesando...";
  try {
    const resp = await fetch(`/api/mandados/${currentId}/authorize`, {
      method: "POST",
    });
    const data = await resp.json();
    if (!resp.ok) {
      const apiError = document.getElementById("api-error");
      apiError.textContent = `Error: ${data.error}`;
      apiError.classList.add("visible");
      return;
    }
    renderPaymentPanel(data, data.status);
  } catch (err) {
    document.getElementById("api-error").textContent = `Error: ${JSON.stringify(err)}`;
    document.getElementById("api-error").classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.textContent = "Autorizar con PayPal";
  }
});

document.getElementById("approved-btn").addEventListener("click", async () => {
  const btn = document.getElementById("approved-btn");
  btn.disabled = true;
  btn.textContent = "Procesando...";
  try {
    const resp = await fetch(`/api/mandados/${currentId}/approved`, {
      method: "POST",
    });
    const data = await resp.json();
    if (!resp.ok) {
      const apiError = document.getElementById("api-error");
      apiError.textContent = `Error: ${data.error}`;
      apiError.classList.add("visible");
      return;
    }
    renderPaymentPanel(data, data.status);
  } catch (err) {
    document.getElementById("api-error").textContent = `Error: ${JSON.stringify(err)}`;
    document.getElementById("api-error").classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.textContent = "Ya aprobé en PayPal";
  }
});

document.getElementById("capture-btn").addEventListener("click", async () => {
  const btn = document.getElementById("capture-btn");
  btn.disabled = true;
  btn.textContent = "Procesando...";
  try {
    const resp = await fetch(`/api/mandados/${currentId}/capture`, {
      method: "POST",
    });
    const data = await resp.json();
    if (!resp.ok) {
      const apiError = document.getElementById("api-error");
      apiError.textContent = `Error: ${data.error}`;
      apiError.classList.add("visible");
      return;
    }
    renderPaymentPanel(data, data.status);
  } catch (err) {
    document.getElementById("api-error").textContent = `Error: ${JSON.stringify(err)}`;
    document.getElementById("api-error").classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.textContent = "Capturar";
  }
});

document.getElementById("void-btn").addEventListener("click", async () => {
  const btn = document.getElementById("void-btn");
  btn.disabled = true;
  btn.textContent = "Procesando...";
  try {
    const resp = await fetch(`/api/mandados/${currentId}/void`, {
      method: "POST",
    });
    const data = await resp.json();
    if (!resp.ok) {
      const apiError = document.getElementById("api-error");
      apiError.textContent = `Error: ${data.error}`;
      apiError.classList.add("visible");
      return;
    }
    renderPaymentPanel(data, data.status);
  } catch (err) {
    document.getElementById("api-error").textContent = `Error: ${JSON.stringify(err)}`;
    document.getElementById("api-error").classList.add("visible");
  } finally {
    btn.disabled = false;
    btn.textContent = "Anular";
  }
});