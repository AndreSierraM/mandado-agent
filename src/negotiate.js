/**
 * Deterministic buyer-agent negotiation.
 *
 * async function* negotiate(limits, stores, { writer, maxRounds = 3 })
 *
 * - The buyer strategy is fully deterministic (fixed offer schedule, capped
 *   at limits.maxAmount). It never offers above the cap.
 * - `writer` is an optional (possibly LLM-backed) text generator used ONLY
 *   for buyer message wording. It can never change prices, caps or deadlines.
 *   Default: Spanish template text.
 * - Max `maxRounds` store responses per store (rounds are 0-based).
 * - Stores are discarded with a reason: 'deadline' | 'over_cap' |
 *   'no_stock' | 'no_deal'.
 * - Final yielded event is 'proposal' (winner price never exceeds cap).
 */

import { assertWithinCap } from "./limits.js";

/** Opening offers per round; anything beyond uses the cap itself. */
const OFFER_SCHEDULE = [108, 112, 115];

function buyerOfferFor(round, cap) {
  const base =
    round < OFFER_SCHEDULE.length ? OFFER_SCHEDULE[round] : cap;
  return Math.min(cap, base);
}

export function defaultBuyerText({ price, cap }) {
  return `Hola, ofrezco $${price} USD por este artículo. Mi tope es $${cap} USD. ¿Aceptas?`;
}

export function defaultRejectText({ price, cap }) {
  return `No puedo aceptar $${price} USD: excede tu tope de $${cap} USD.`;
}

/**
 * @param {{ item: string, maxAmount: number, currency: string, deadline: string|null }} limits
 * @param {Array} stores - objects with { id, name, listPrice, floorPrice, stock, shippingCost, respond(offer, round), deliveryDate() }
 * @param {{ writer?: Function, maxRounds?: number }} [options]
 */
export async function* negotiate(limits, stores, options = {}) {
  const { writer = null, maxRounds = 3 } = options;
  const cap = Number(limits?.maxAmount);

  async function buyerText(msg) {
    if (typeof writer === "function") {
      return await writer(msg);
    }
    if (msg.kind === "reject") return defaultRejectText(msg);
    return defaultBuyerText(msg);
  }

  yield { type: "limits", limits };

  const threads = new Map(); // storeId -> message[]
  const accepted = new Map(); // storeId -> { price, deliveryDate, shipping, store }
  const discarded = new Map(); // storeId -> reason
  const active = [...stores];

  for (const s of active) threads.set(s.id, []);

  for (let round = 0; round < maxRounds; round++) {
    for (const store of active) {
      if (discarded.has(store.id) || accepted.has(store.id)) continue;

      if ((store.stock ?? 1) <= 0) {
        discarded.set(store.id, "no_stock");
        yield {
          type: "store_discarded",
          storeId: store.id,
          reason: "no_stock",
          detail: "Sin stock disponible.",
        };
        continue;
      }

      // A store whose floor is above the cap can never close: discard now.
      if (Number(store.floorPrice) > cap) {
        discarded.set(store.id, "over_cap");
        yield {
          type: "store_discarded",
          storeId: store.id,
          reason: "over_cap",
          detail: `Precio mínimo $${store.floorPrice} excede tu tope de $${cap} USD.`,
        };
        continue;
      }

      const offer = buyerOfferFor(round, cap);
      const text = await buyerText({
        kind: "offer",
        from: "buyer",
        storeId: store.id,
        storeName: store.name,
        round,
        price: offer,
        cap,
        item: limits.item,
        deadline: limits.deadline,
      });
      const buyerMsg = {
        from: "buyer",
        storeId: store.id,
        round,
        price: offer,
        text,
      };
      threads.get(store.id).push(buyerMsg);
      yield { type: "store_message", ...buyerMsg };

      const resp = store.respond(offer, round);
      const storeMsg = {
        from: "store",
        storeId: store.id,
        round,
        price: resp.price,
        text: resp.message,
        action: resp.action,
        deliveryDate: resp.deliveryDate ?? store.deliveryDate?.(),
      };
      threads.get(store.id).push(storeMsg);
      yield { type: "store_message", ...storeMsg };

      if (resp.action === "reject" || resp.price == null) {
        discarded.set(store.id, "no_stock");
        yield {
          type: "store_discarded",
          storeId: store.id,
          reason: "no_stock",
          detail: resp.message,
        };
        continue;
      }

      const price = Number(resp.price);

      // Guard: any counter above the cap is rejected in-text ("excede tu tope").
      if (price > cap) {
        const rtext = await buyerText({
          kind: "reject",
          from: "buyer",
          storeId: store.id,
          storeName: store.name,
          round,
          price,
          cap,
          item: limits.item,
          rejectedPrice: price,
        });
        const rej = {
          from: "buyer",
          storeId: store.id,
          round,
          price: null,
          rejectedPrice: price,
          rejection: true,
          reason: "excede tu tope",
          text: rtext,
        };
        threads.get(store.id).push(rej);
        yield { type: "store_message", ...rej };
        continue; // keep negotiating next round (floor may still be reachable)
      }

      if (resp.action === "accept") {
        // Deadline is enforced in code: late delivery => discard even if price is good.
        if (limits.deadline && storeMsg.deliveryDate > limits.deadline) {
          discarded.set(store.id, "deadline");
          yield {
            type: "store_discarded",
            storeId: store.id,
            reason: "deadline",
            detail: `Entrega ${storeMsg.deliveryDate} después de tu límite ${limits.deadline}.`,
            price,
            deliveryDate: storeMsg.deliveryDate,
          };
          continue;
        }
        assertWithinCap(price, limits);
        accepted.set(store.id, {
          price,
          deliveryDate: storeMsg.deliveryDate,
          shipping: Number(store.shippingCost ?? 0),
          store,
        });
      }
      // 'counter' within cap + on time: just continue to the next round.
    }
  }

  // Anything left without a deal gets a terminal reason.
  for (const store of active) {
    if (discarded.has(store.id) || accepted.has(store.id)) continue;
    // Late delivery can never satisfy the deadline.
    const dd =
      typeof store.deliveryDate === "function" ? store.deliveryDate() : null;
    if (limits.deadline && dd && dd > limits.deadline) {
      discarded.set(store.id, "deadline");
      yield {
        type: "store_discarded",
        storeId: store.id,
        reason: "deadline",
        detail: `Entrega ${dd} después de tu límite ${limits.deadline}.`,
        deliveryDate: dd,
      };
    } else {
      discarded.set(store.id, "no_deal");
      yield {
        type: "store_discarded",
        storeId: store.id,
        reason: "no_deal",
        detail: "Sin acuerdo dentro del tope y las rondas disponibles.",
      };
    }
  }

  // Pick the winner: lowest total (price + shipping), tie-break earliest delivery.
  let winner = null;
  for (const [storeId, cand] of accepted) {
    assertWithinCap(cand.price, limits); // never exceed cap, enforced in code
    const total = cand.price + cand.shipping;
    if (
      !winner ||
      total < winner.total ||
      (total === winner.total && cand.deliveryDate < winner.deliveryDate)
    ) {
      winner = { storeId, ...cand, total };
    }
  }

  if (!winner) {
    yield {
      type: "proposal",
      storeId: null,
      finalPrice: null,
      shipping: null,
      savings: null,
      deliveryDate: null,
      thread: [],
      reason: "no_deal",
    };
    return;
  }

  yield {
    type: "proposal",
    storeId: winner.storeId,
    storeName: winner.store.name,
    finalPrice: winner.price,
    shipping: winner.shipping,
    total: winner.total,
    listPrice: winner.store.listPrice,
    savings: Number(winner.store.listPrice) - Number(winner.price),
    deliveryDate: winner.deliveryDate,
    thread: threads.get(winner.storeId) ?? [],
  };
}
