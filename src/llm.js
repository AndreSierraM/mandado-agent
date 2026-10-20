/**
 * Optional LLM integration through an OpenAI-compatible chat completions
 * endpoint. No npm dependencies: global fetch only.
 *
 * The model is NEVER trusted for prices, caps or deadlines. It can only:
 *   - write the wording of buyer messages (createLlmWriter), and
 *   - extract item/attributes (createLlmParse).
 *
 * Every response is validated against a JSON schema and the writer output is
 * guarded so it can only mention the code-decided price/cap/rejectedPrice.
 * On any failure the deterministic Spanish templates from negotiate.js are
 * used instead. The API key is never logged.
 */

import { defaultBuyerText, defaultRejectText } from "./negotiate.js";

const WRITER_SCHEMA = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string", maxLength: 400 } },
};

const PARSE_SCHEMA = {
  type: "object",
  required: ["item", "attributes"],
  properties: {
    item: { type: "string", maxLength: 120 },
    attributes: {
      type: "array",
      maxItems: 10,
      items: { type: "string", maxLength: 60 },
    },
  },
  additionalProperties: false,
};

/**
 * Minimal JSON-schema validator.
 * Supports {type:'object', required, properties, additionalProperties:false},
 * {type:'string', maxLength} and {type:'array', items, maxItems}.
 * @returns {boolean}
 */
export function validate(schema, value) {
  if (!schema || typeof schema !== "object") return false;
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return false;
      if (
        typeof schema.maxLength === "number" &&
        value.length > schema.maxLength
      ) {
        return false;
      }
      return true;
    }
    case "array": {
      if (!Array.isArray(value)) return false;
      if (
        typeof schema.maxItems === "number" &&
        value.length > schema.maxItems
      ) {
        return false;
      }
      if (schema.items) {
        for (const item of value) {
          if (!validate(schema.items, item)) return false;
        }
      }
      return true;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
        }
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) return false;
        }
      }
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            if (!validate(sub, value[key])) return false;
          }
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/** Strip an optional ```json ... ``` fence around a model response. */
function stripFences(text) {
  const t = String(text).trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

/**
 * Build an LLM client or null when the configuration is incomplete.
 *
 * @param {{ baseUrl?: string, apiKey?: string, model?: string,
 *   fetchImpl?: Function, timeoutMs?: number }} [options]
 * @returns {null | { baseUrl: string, apiKey: string, model: string,
 *   fetchImpl: Function, timeoutMs: number, chatJson: Function }}
 */
export function createLlmClient({
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const base = String(
    baseUrl ?? process.env.LLM_BASE_URL ?? "",
  ).trim();
  const key = String(apiKey ?? process.env.LLM_API_KEY ?? "").trim();
  const modelId = String(model ?? process.env.LLM_MODEL ?? "").trim();
  if (!base || !key || !modelId) return null;

  async function chatJson({ system, user, schema }) {
    const url = `${base.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.3,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`LLM request failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response has no message content");
      }
      const value = JSON.parse(stripFences(content));
      if (!validate(schema, value)) {
        throw new Error("LLM response failed schema validation");
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  return { baseUrl: base, apiKey: key, model: modelId, fetchImpl, timeoutMs, chatJson };
}

/** Extract every numeric token from text. */
function numberTokens(text) {
  const out = [];
  const re = /(\d+(?:[.,]\d+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * Guard: the message must contain the code-decided price and no other
 * "money-like" number except the allowed set (price/cap/rejectedPrice) or a
 * small round number <= 3 (e.g. "ronda 2", "3 unidades").
 */
function priceGuardOk(text, msg) {
  if (typeof text !== "string" || !text.trim()) return false;
  const required =
    msg.kind === "reject"
      ? String(msg.rejectedPrice ?? msg.price)
      : String(msg.price);
  if (!required || required === "null" || !text.includes(required)) return false;
  const allowed = new Set();
  for (const n of [msg.price, msg.cap, msg.rejectedPrice]) {
    if (n !== undefined && n !== null) allowed.add(String(n));
  }
  for (const token of numberTokens(text)) {
    if (allowed.has(token)) continue;
    const value = Number(token.replace(",", "."));
    if (Number.isFinite(value) && value <= 3) continue;
    return false;
  }
  return true;
}

function writerFallback(msg) {
  return msg.kind === "reject" ? defaultRejectText(msg) : defaultBuyerText(msg);
}

/**
 * Buyer-message writer. Returns async (msg) => string.
 * Prices are decided by code; the model only picks the words.
 *
 * @param {{ chatJson: Function } | null} client
 * @param {{ fallback?: Function }} [options]
 */
export function createLlmWriter(client, { fallback } = {}) {
  const fallbackFn = typeof fallback === "function" ? fallback : writerFallback;

  return async function writer(msg) {
    if (!client || typeof client.chatJson !== "function") return fallbackFn(msg);
    try {
      const system =
        'Eres el agente comprador de Mandado. Responde SIEMPRE con un objeto JSON con una sola clave "text" que contenga UN mensaje corto (máximo 400 caracteres) en español. El mensaje debe mencionar exactamente el precio indicado en el campo price (o rejectedPrice si es un rechazo) y, opcionalmente, el tope cap. No incluyas ningún otro precio ni cifra de dinero. No inventes montos. No uses markdown.';
      const user = [
        `Tipo de mensaje: ${msg.kind === "reject" ? "rechazo" : "oferta"}`,
        `Precio: ${msg.price} USD`,
        msg.cap != null ? `Tope máximo: ${msg.cap} USD` : null,
        msg.kind === "reject" && msg.rejectedPrice != null
          ? `Precio rechazado: ${msg.rejectedPrice} USD`
          : null,
        msg.item ? `Artículo: ${msg.item}` : null,
        msg.storeName ? `Tienda: ${msg.storeName}` : null,
        msg.round != null ? `Ronda: ${msg.round}` : null,
        msg.deadline ? `Fecha límite de entrega: ${msg.deadline}` : null,
        "Escribe solo el mensaje del comprador.",
      ]
        .filter(Boolean)
        .join("\n");
      const { text } = await client.chatJson({
        system,
        user,
        schema: WRITER_SCHEMA,
      });
      if (priceGuardOk(text, msg)) return text;
      return fallbackFn(msg);
    } catch {
      return fallbackFn(msg);
    }
  };
}

/**
 * Item/attributes extractor. Returns async (text) => hints|null.
 * Prices and dates are never extracted here (code owns them).
 *
 * @param {{ chatJson: Function } | null} client
 */
export function createLlmParse(client) {
  return async function llmParse(text) {
    if (!client || typeof client.chatJson !== "function") return null;
    try {
      return await client.chatJson({
        system:
          'Eres un extractor de información. Del texto del usuario extrae el producto solicitado (item) y sus características (attributes). No extraigas precios, montos ni fechas. Responde SIEMPRE con un objeto JSON con las claves "item" (string) y "attributes" (array de strings).',
        user: String(text),
        schema: PARSE_SCHEMA,
      });
    } catch {
      return null;
    }
  };
}
