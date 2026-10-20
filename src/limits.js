/**
 * Deterministic regex parser for Mandado purchase limits (Spanish + English).
 *
 * parseRequest(text, options) -> { item, maxAmount, currency, deadline, attributes }
 *   - text: free-form request, e.g. "Audífonos con ANC, máx USD 120, llegan antes del viernes"
 *   - options.now: injectable reference date (Date | string | number). Default: new Date().
 *   - options.llm: optional plain-object hints from an LLM (never trusted for caps/deadlines).
 *
 * Caps and deadlines are ALWAYS enforced in code: deterministic regex matches win
 * over any LLM hints. See parseRequestWithLlm() for the async hook variant.
 */

export class CapExceededError extends Error {
  constructor(amount, maxAmount) {
    super(
      `Monto ${amount} excede tu tope de ${maxAmount} USD (amount exceeds cap)`,
    );
    this.name = "CapExceededError";
    this.code = "CAP_EXCEEDED";
    this.amount = amount;
    this.maxAmount = maxAmount;
  }
}

/**
 * Throws CapExceededError when amount > limits.maxAmount.
 * @param {number} amount
 * @param {{ maxAmount: number }} limits
 */
export function assertWithinCap(amount, limits) {
  const max = Number(limits?.maxAmount);
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new CapExceededError(amount, max);
  }
  if (Number.isFinite(max) && value > max) {
    throw new CapExceededError(value, max);
  }
}

const WEEKDAYS = [
  { day: 1, names: ["lunes", "monday"] },
  { day: 2, names: ["martes", "tuesday"] },
  { day: 3, names: ["miercoles", "miércoles", "wednesday"] },
  { day: 4, names: ["jueves", "thursday"] },
  { day: 5, names: ["viernes", "friday"] },
  { day: 6, names: ["sabado", "sábado", "saturday"] },
  { day: 0, names: ["domingo", "sunday"] },
];

function toDate(now) {
  if (now instanceof Date) return new Date(now.getTime());
  if (now === undefined || now === null) return new Date();
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function toISODateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Next calendar date strictly after `now` falling on weekday `target` (0=Sun..6=Sat). */
function nextWeekdayISO(now, target) {
  const base = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  let delta = (target - base.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7; // strictly in the future ("próximo viernes")
  base.setUTCDate(base.getUTCDate() + delta);
  return toISODateUTC(base);
}

function parseNumber(raw) {
  if (raw == null) return null;
  // Accept "120", "120.50", "120,50" (decimal comma)
  let s = String(raw).trim();
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Deterministic cap extraction. Returns number | null. */
function extractMaxAmount(text) {
  const patterns = [
    // "máx USD 120", "max $120", "máximo 120 dólares", "hasta 120 dólares", "tope $120", "budget $120"
    /(?:m[aá]xim?a?\.?|m[aá]x\.?|hasta|tope(?:\s+m[aá]ximo)?|budget|presupuesto)[^\d$]{0,24}(?:USD|US\s*\$|\$|d[oó]lares?)?\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    // "$120", "USD 120"
    /(?:USD|US\s*\$)\s*\$?\s*(\d+(?:[.,]\d+)?)/i,
    /\$\s*(\d+(?:[.,]\d+)?)/,
    // "120 dólares", "120 USD"
    /(\d+(?:[.,]\d+)?)\s*(?:USD|US\s*\$|d[oó]lares?|\$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseNumber(m[1]);
      if (n !== null) return n;
    }
  }
  return null;
}

/** Deterministic deadline extraction. Returns YYYY-MM-DD | null. */
function extractDeadline(text, now) {
  // 1. Explicit ISO date: "before 2026-10-20", "antes del 2026-10-20", bare "2026-10-20"
  const iso =
    text.match(
      /(?:before|by|para\s+el|antes\s+del?)\s+(\d{4}-\d{2}-\d{2})/i,
    ) ?? text.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  // 2. Weekday names es/en: "viernes", "friday", "antes del viernes", "before Friday"
  const lowered = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const { day, names } of WEEKDAYS) {
    for (const name of names) {
      const ascii = name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      const re = new RegExp(`\\b${ascii}\\b`, "i");
      if (re.test(lowered)) {
        return nextWeekdayISO(now, day);
      }
    }
  }
  return null;
}

const ATTRIBUTE_KEYWORDS = [
  "ANC",
  "bluetooth",
  "inalambrico",
  "inalámbrico",
  "wireless",
  "cuero",
  "leather",
  "noise cancelling",
  "cancelacion de ruido",
  "cancelación de ruido",
];

/** Deterministic attribute extraction. Returns string[]. */
function extractAttributes(text) {
  const found = [];
  const seen = new Set();
  const push = (v) => {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      found.push(v);
    }
  };
  // ALL-CAPS tokens like ANC, USB, LED (excluding currency codes)
  for (const m of text.matchAll(/\b[A-Z]{2,}\b/g)) {
    if (m[0] === "USD" || m[0] === "US") continue;
    push(m[0]);
  }
  const lowered = text.toLowerCase();
  const loweredAscii = lowered
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const kw of ATTRIBUTE_KEYWORDS) {
    const ascii = kw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (lowered.includes(kw.toLowerCase()) || loweredAscii.includes(ascii)) {
      // Preserve canonical display form: uppercase known acronyms, else keyword as-is
      push(kw === kw.toLowerCase() && kw !== "ANC" ? kw : kw.toUpperCase() === kw ? kw : kw);
    }
  }
  // Normalize: keep acronyms uppercase, lowercase the rest for stability
  return found.map((a) => (/^[A-Z]{2,}$/.test(a) ? a : a.toLowerCase()));
}

/** Remove cap & deadline clauses to isolate the item description. */
function extractItem(text) {
  let item = String(text);
  const removePatterns = [
    /(?:,|\.|;|\s)+m[aá]xim?a?\.?[^,;.]*$/i,
    /(?:,|\.|;|\s)+m[aá]x\.?[^,;.]*$/i,
    /(?:,|\.|;|\s)+hasta[^,;.]*$/i,
    /(?:,|\.|;|\s)+tope[^,;.]*$/i,
    /(?:,|\.|;|\s)+budget[^,;.]*$/i,
    /(?:,|\.|;|\s)+presupuesto[^,;.]*$/i,
    /(?:,|\.|;|\s)+(?:llegan|llega|entrega|delivery|necesito|need)[^,;.]*?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})[^,;.]*$/i,
    /(?:,|\.|;|\s)+(?:antes\s+del?|before|by|para\s+el)[^,;.]*$/i,
  ];
  for (const re of removePatterns) {
    item = item.replace(re, "");
  }
  // First comma-separated chunk is usually the item ("Audífonos con ANC, ...")
  const first = item.split(/[,;]/)[0] ?? "";
  let cleaned = first.trim();
  // Drop leading buyer verbs: "quiero comprar ...", "necesito ...", "I want ..."
  cleaned = cleaned.replace(
    /^(?:quiero|quisiera|necesito|busco|comprar|quiero\s+comprar|por\s+favor|please|i\s+want(?:\s+to\s+buy)?|looking\s+for|need|buy)\s+/i,
    "",
  );
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned || String(text).trim();
}

/**
 * Deterministic parser. Sync; never hits the network.
 *
 * @param {string} text
 * @param {{ now?: Date|string|number, llm?: object|null }} [options]
 * @returns {{ item: string, maxAmount: number, currency: 'USD', deadline: string|null, attributes: string[] }}
 */
export function parseRequest(text, options = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("parseRequest: text must be a non-empty string");
  }
  const now = toDate(options.now);
  const maxAmount = extractMaxAmount(text);
  if (maxAmount === null) {
    throw new Error(
      "parseRequest: no se encontró un tope de precio (no cap found, e.g. 'máx USD 120')",
    );
  }
  const deadline = extractDeadline(text, now);
  const attributes = extractAttributes(text);
  const item = extractItem(text);

  const out = {
    item,
    maxAmount,
    currency: "USD",
    deadline,
    attributes,
  };

  // Optional LLM hints (plain object, already resolved): deterministic values
  // ALWAYS win for caps/deadlines. LLM may only enrich item/attributes.
  const hints = options.llm;
  if (hints && typeof hints === "object") {
    if (!out.item && typeof hints.item === "string" && hints.item.trim()) {
      out.item = hints.item.trim();
    }
    if (Array.isArray(hints.attributes)) {
      const merged = [...out.attributes];
      for (const a of hints.attributes) {
        if (
          typeof a === "string" &&
          !merged.some((x) => x.toLowerCase() === a.toLowerCase())
        ) {
          merged.push(a);
        }
      }
      out.attributes = merged;
    }
    // NOTE: hints.maxAmount / hints.deadline are deliberately IGNORED.
  }

  return out;
}

/**
 * Async variant honoring an optional async `llmParse(text)` hook.
 * Deterministic regex results ALWAYS win for maxAmount/deadline/currency;
 * the hook may only suggest item/attributes.
 *
 * @param {string} text
 * @param {{ now?: Date|string|number, llmParse?: (text: string) => Promise<object>|object }} [options]
 */
export async function parseRequestWithLlm(text, options = {}) {
  const base = parseRequest(text, { now: options.now });
  const { llmParse } = options;
  if (typeof llmParse !== "function") return base;
  let hints = null;
  try {
    hints = await llmParse(text);
  } catch {
    return base; // LLM failure never breaks deterministic parsing
  }
  if (hints && typeof hints === "object") {
    if (typeof hints.item === "string" && hints.item.trim()) {
      base.item = hints.item.trim();
    }
    if (Array.isArray(hints.attributes)) {
      for (const a of hints.attributes) {
        if (
          typeof a === "string" &&
          !base.attributes.some((x) => x.toLowerCase() === a.toLowerCase())
        ) {
          base.attributes.push(a);
        }
      }
    }
    // maxAmount / deadline / currency from code only — never from the LLM.
  }
  return base;
}
