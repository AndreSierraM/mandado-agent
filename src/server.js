/**
 * Mandado HTTP server (Node built-ins only).
 *
 * Routes:
 *   POST /api/mandados                  { text } -> { id, limits } (starts negotiation)
 *   GET  /api/mandados/:id              -> full state for polling
 *   GET  /api/mandados/:id/events       -> SSE stream (replay past, then live)
 *   POST /api/mandados/:id/authorize    -> create AUTHORIZE order (cap-guarded) -> { orderId, approveUrl }
 *   POST /api/mandados/:id/approved     -> authorize approved order -> AUTHORIZED
 *   POST /api/mandados/:id/capture      -> capture authorization
 *   POST /api/mandados/:id/void         -> void authorization
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { parseRequest } from "./limits.js";
import { createDemoStores } from "./stores.js";
import { negotiate } from "./negotiate.js";
import { createPayPalClient } from "./paypal.js";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sseWrite(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function serveStatic(res, publicUrl, basePath) {
  const cleanUrl = publicUrl === "/" ? "index.html" : publicUrl.replace(/^\/+/, '') ;
  let filePath = path.join(basePath, cleanUrl);
  // Path traversal protection: ensure file stays within basePath
  filePath = path.resolve(filePath);
  const resolvedBase = path.resolve(basePath);
  if (!(filePath.startsWith(resolvedBase + path.sep) || filePath === resolvedBase)) {
    sendJson(res, 403, { error: "Acceso no autorizado" });
    return;
  }
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "No encontrado" });
    return;
  }
  const contentType = contentTypes[path.extname(filePath)] || "application/octet-stream";
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length });
  res.end(body);
}

const contentTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

function approveUrlOf(paypal, order) {
  if (typeof paypal?.approveUrl === "function") {
    try {
      return paypal.approveUrl(order);
    } catch {
      /* fall through */
    }
  }
  const link = order?.links?.find((l) => l.rel === "approve");
  return link?.href ?? null;
}

/**
 * @param {{ paypal?: object, now?: Date|string|number, writer?: Function, maxRounds?: number }} [options]
 * @returns {{ server: import('node:http').Server, mandados: Map }}
 */
export function createServer(options = {}) {
  const paypal = options.paypal ?? createPayPalClient();
  const now = options.now ?? null;
  const writer = options.writer ?? null;
  const maxRounds = options.maxRounds ?? 3;

  /** id -> { id, limits, status, events, columns, discarded, proposal, payment } */
  const mandados = new Map();
  /** id -> Set<http.ServerResponse> (SSE subscribers) */
  const subscribers = new Map();

  function emit(id, event) {
    const m = mandados.get(id);
    if (!m) return;
    m.events.push(event);
    const subs = subscribers.get(id);
    if (subs) {
      for (const res of [...subs]) {
        try {
          sseWrite(res, event);
        } catch {
          subs.delete(res);
        }
      }
    }
  }

  function snapshot(m) {
    return {
      id: m.id,
      limits: m.limits,
      status: m.status,
      stores: m.columns,
      discarded: m.discarded,
      proposal: m.proposal,
      payment: m.payment,
    };
  }

  async function runNegotiation(id) {
    const m = mandados.get(id);
    if (!m) return;
    try {
      const stores = createDemoStores({ now: now ?? undefined });
      const gen = negotiate(m.limits, stores, { writer, maxRounds });
      for await (const event of gen) {
        if (event.type === "store_message") {
          const col = m.columns[event.storeId] ?? { messages: [], discarded: null };
          col.messages.push(event);
          m.columns[event.storeId] = col;
        } else if (event.type === "store_discarded") {
          const col = m.columns[event.storeId] ?? { messages: [], discarded: null };
          col.discarded = { reason: event.reason, detail: event.detail ?? null };
          m.columns[event.storeId] = col;
          m.discarded[event.storeId] = event.reason;
        } else if (event.type === "proposal") {
          m.proposal = event.storeId ? event : null;
          m.status = event.storeId ? "proposed" : "no_deal";
          if (!event.storeId) {
            emit(id, { type: "error", message: "No se logró un acuerdo dentro del tope." });
          }
        }
        emit(id, event);
      }
      if (m.status === "negotiating") m.status = m.proposal ? "proposed" : "no_deal";
      emit(id, { type: "done", status: m.status });
    } catch (err) {
      m.status = "error";
      emit(id, { type: "error", message: String(err?.message ?? err) });
      emit(id, { type: "done", status: m.status });
    }
  }

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ['api','mandados',':id','events']
    if (req.method === "GET" && !url.pathname.startsWith("/api")) {
      serveStatic(res, url.pathname, path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
      return;
    }

    try {
      // POST /api/mandados
      if (req.method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "mandados") {
        const body = await readJson(req);
        if (!body?.text || typeof body.text !== "string") {
          sendJson(res, 400, { error: "Body must be JSON { text: string }" });
          return;
        }
        let limits;
        try {
          limits = parseRequest(body.text, now ? { now } : {});
        } catch (err) {
          sendJson(res, 400, { error: String(err?.message ?? err) });
          return;
        }
        const id = randomUUID();
        const m = {
          id,
          limits,
          status: "negotiating",
          events: [],
          columns: {},
          discarded: {},
          proposal: null,
          payment: null,
        };
        mandados.set(id, m);
        sendJson(res, 201, { id, limits });
        // Negotiate in the background; clients poll GET or subscribe to SSE.
        void runNegotiation(id);
        return;
      }

      // All remaining routes need /api/mandados/:id[...]
      if (parts.length >= 3 && parts[0] === "api" && parts[1] === "mandados") {
        const id = parts[2];
        const m = mandados.get(id);
        if (!m) {
          sendJson(res, 404, { error: "Mandado no encontrado" });
          return;
        }

        // GET /api/mandados/:id
        if (req.method === "GET" && parts.length === 3) {
          sendJson(res, 200, { ...snapshot(m), events: m.events });
          return;
        }

        // GET /api/mandados/:id/events (SSE)
        if (req.method === "GET" && parts.length === 4 && parts[3] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          // Replay past events, then go live.
          for (const ev of m.events) sseWrite(res, ev);
          let subs = subscribers.get(id);
          if (!subs) {
            subs = new Set();
            subscribers.set(id, subs);
          }
          subs.add(res);
          req.on("close", () => {
            subs.delete(res);
          });
          return;
        }

        // POST /api/mandados/:id/authorize
        if (req.method === "POST" && parts.length === 4 && parts[3] === "authorize") {
          if (!m.proposal) {
            sendJson(res, 409, { error: "Aún no hay propuesta para autorizar" });
            return;
          }
          if (m.payment?.orderId) {
            sendJson(res, 200, {
              orderId: m.payment.orderId,
              approveUrl: m.payment.approveUrl,
              status: m.payment.status,
            });
            return;
          }
          const amount = m.proposal.total ?? m.proposal.finalPrice;
          let order;
          try {
            order = await paypal.createOrder({
              amount,
              currency: m.limits.currency ?? "USD",
              description: `Mandado ${m.limits.item} (${m.proposal.storeId})`,
              limits: m.limits, // cap guard enforced inside the client, before any request
            });
          } catch (err) {
            const status = err?.name === "CapExceededError" ? 400 : 502;
            sendJson(res, status, { error: String(err?.message ?? err) });
            return;
          }
          m.payment = {
            orderId: order.id,
            approveUrl: approveUrlOf(paypal, order),
            status: order.status ?? "CREATED",
            amount,
            currency: m.limits.currency ?? "USD",
            authorizationId: null,
          };
          m.status = "awaiting_approval";
          emit(id, { type: "payment_update", payment: m.payment, status: m.status });
          sendJson(res, 201, {
            orderId: m.payment.orderId,
            approveUrl: m.payment.approveUrl,
            status: m.payment.status,
          });
          return;
        }

        // POST /api/mandados/:id/approved
        if (req.method === "POST" && parts.length === 4 && parts[3] === "approved") {
          if (!m.payment?.orderId) {
            sendJson(res, 409, { error: "Primero crea la orden con /authorize" });
            return;
          }
          if (m.payment.authorizationId) {
            sendJson(res, 200, { ...m.payment, status: "AUTHORIZED" });
            return;
          }
          try {
            // Mock auto-approval (real flow: buyer approved via approveUrl already).
            if (typeof paypal.approve === "function") {
              await paypal.approve(m.payment.orderId);
            }
            const auth = await paypal.authorizeOrder(m.payment.orderId);
            const authorizationId = auth?.id ?? auth?.authorizationId ?? null;
            m.payment.authorizationId = authorizationId;
            m.payment.status = "AUTHORIZED";
            m.status = "authorized";
            emit(id, { type: "payment_update", payment: m.payment, status: m.status });
            sendJson(res, 200, { ...m.payment });
          } catch (err) {
            sendJson(res, 502, { error: String(err?.message ?? err) });
          }
          return;
        }

        // POST /api/mandados/:id/capture
        if (req.method === "POST" && parts.length === 4 && parts[3] === "capture") {
          if (!m.payment?.authorizationId) {
            sendJson(res, 409, { error: "No hay autorización para capturar" });
            return;
          }
          try {
            const out = await paypal.captureAuthorization(m.payment.authorizationId);
            m.payment.status = out?.status ?? "CAPTURED";
            m.status = "captured";
            emit(id, { type: "payment_update", payment: m.payment, status: m.status });
            sendJson(res, 200, { ...m.payment });
          } catch (err) {
            sendJson(res, 502, { error: String(err?.message ?? err) });
          }
          return;
        }

        // POST /api/mandados/:id/void
        if (req.method === "POST" && parts.length === 4 && parts[3] === "void") {
          if (!m.payment?.authorizationId) {
            sendJson(res, 409, { error: "No hay autorización para anular" });
            return;
          }
          try {
            const out = await paypal.voidAuthorization(m.payment.authorizationId);
            m.payment.status = out?.status ?? "VOIDED";
            m.status = "voided";
            emit(id, { type: "payment_update", payment: m.payment, status: m.status });
            sendJson(res, 200, { ...m.payment });
          } catch (err) {
            sendJson(res, 502, { error: String(err?.message ?? err) });
          }
          return;
        }
      }

    sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });

  return { server, mandados };
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const PORT = Number(process.env.PORT ?? 3000);
  const { server } = createServer();
  server.listen(PORT, () => {
    console.log(`Mandado server listening on http://localhost:${PORT}`);
  });
}
