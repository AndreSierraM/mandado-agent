/**
 * Fake deterministic stores for the Mandado demo.
 *
 * Scenario (cap 120 USD, deadline Friday, fixed now = Wednesday 2026-10-14):
 *   - Store A: lists 135, floor 118, counters stepping down
 *     (130 -> 125 "solo hoy" -> 121 -> 118). The 125 offer exceeds the 120
 *     cap so the buyer agent rejects it ("excede tu tope").
 *   - Store B: counters down to 112 and would accept 112, but delivers
 *     Monday (after the Friday deadline) so it is discarded for deadline.
 *   - Store C: lists 128, floor 115, free shipping, delivers next day;
 *     goes down to 115 and WINS.
 */

export const DEMO_NOW_ISO = "2026-10-14T12:00:00.000Z";

function toDate(now) {
  if (now instanceof Date) return new Date(now.getTime());
  if (now === undefined || now === null) return new Date(DEMO_NOW_ISO);
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return new Date(DEMO_NOW_ISO);
  return d;
}

export function toISODateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Delivery date = now (UTC midnight) + shippingDays. */
export function deliveryDateFor(now, shippingDays) {
  const base = toDate(now);
  const midnight = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
  );
  midnight.setUTCDate(midnight.getUTCDate() + shippingDays);
  return toISODateUTC(midnight);
}

function makeStore(def) {
  return {
    id: def.id,
    name: def.name,
    listPrice: def.listPrice,
    floorPrice: def.floorPrice,
    stock: def.stock,
    shippingDays: def.shippingDays,
    shippingCost: def.shippingCost,
    counters: def.counters,
    now: def.now,
    deliveryDate() {
      return deliveryDateFor(this.now, this.shippingDays);
    },
    /**
     * @param {number|null} offer - buyer offer in USD (null = opening, buyer hasn't offered yet)
     * @param {number} round - 0-based round index
     * @returns {{ action: 'accept'|'counter'|'reject', price: number|null, message: string, deliveryDate: string }}
     */
    respond(offer, round) {
      const deliveryDate = deliveryDateFor(this.now, this.shippingDays);
      if (this.stock <= 0) {
        return {
          action: "reject",
          price: null,
          message: `Sin stock disponible en ${this.name}.`,
          deliveryDate,
        };
      }
      const idx = Math.min(Math.max(round, 0), this.counters.length - 1);
      const ask = this.counters[idx];
      if (offer !== null && offer !== undefined) {
        const value = Number(offer);
        // Accept when the buyer meets the current ask (and the floor).
        if (
          Number.isFinite(value) &&
          value >= ask &&
          value >= this.floorPrice
        ) {
          return {
            action: "accept",
            price: value,
            message: `¡Trato hecho! Aceptamos $${value} USD en ${this.name}.`,
            deliveryDate,
          };
        }
      }
      return {
        action: "counter",
        price: ask,
        message: def.messageFor
          ? def.messageFor(ask, round)
          : `${this.name} contraoferta: $${ask} USD.`,
        deliveryDate,
      };
    },
  };
}

/**
 * Build the three deterministic demo stores.
 * @param {{ now?: Date|string|number }} [options]
 * @returns {Array} [storeA, storeB, storeC]
 */
export function createDemoStores(options = {}) {
  const now = toDate(options.now);

  const storeA = makeStore({
    id: "A",
    name: "Tienda A",
    listPrice: 135,
    floorPrice: 118,
    stock: 10,
    shippingDays: 2,
    shippingCost: 4,
    counters: [130, 125, 121, 118],
    now,
    messageFor: (ask) =>
      ask === 125
        ? `Tienda A: $${ask} USD ¡solo hoy! Últimas unidades a este precio.`
        : `Tienda A contraoferta: $${ask} USD.`,
  });

  const storeB = makeStore({
    id: "B",
    name: "Tienda B",
    listPrice: 122,
    floorPrice: 110,
    stock: 3,
    // Wednesday + 5 days = Monday -> misses a Friday deadline on purpose.
    shippingDays: 5,
    shippingCost: 0,
    counters: [118, 115, 112, 112],
    now,
    messageFor: (ask) =>
      `Tienda B contraoferta: $${ask} USD con envío gratis. Entrega el lunes.`,
  });

  const storeC = makeStore({
    id: "C",
    name: "Tienda C",
    listPrice: 128,
    floorPrice: 115,
    stock: 7,
    shippingDays: 1,
    shippingCost: 0,
    counters: [122, 118, 115, 115],
    now,
    messageFor: (ask) =>
      `Tienda C contraoferta: $${ask} USD con envío gratis.`,
  });

  return [storeA, storeB, storeC];
}
