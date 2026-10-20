import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { negotiate } from "../src/negotiate.js";
import { createDemoStores } from "../src/stores.js";

const NOW = "2026-10-14T12:00:00.000Z"; // Wednesday
const LIMITS = {
  item: "Audífonos con ANC",
  maxAmount: 120,
  currency: "USD",
  deadline: "2026-10-16", // Friday
  attributes: ["ANC"],
};

async function collect(limits, stores, options) {
  const events = [];
  for await (const e of negotiate(limits, stores, options)) events.push(e);
  return events;
}

describe("negotiation scenario (cap 120, deadline Friday)", () => {
  it("C wins at 115 with free shipping; B discarded for deadline; 125 'solo hoy' rejected; <=3 rounds", async () => {
    const raw = createDemoStores({ now: NOW });
    // Spy on respond() to prove the 3-round bound.
    const calls = { A: 0, B: 0, C: 0 };
    const stores = raw.map((s) => ({
      ...s,
      respond(offer, round) {
        calls[s.id] += 1;
        return s.respond(offer, round);
      },
    }));

    const events = await collect(LIMITS, stores, { maxRounds: 3 });

    // Round bound: at most 3 store responses per store.
    for (const id of ["A", "B", "C"]) {
      assert.ok(
        calls[id] <= 3,
        `store ${id} responded ${calls[id]} times (max 3)`,
      );
    }
    const rounds = events
      .filter((e) => e.type === "store_message" && e.from === "store")
      .map((e) => e.round);
    assert.ok(Math.max(...rounds) <= 2);

    // The 125 "solo hoy" counter is rejected with reason "excede tu tope".
    const rejections = events.filter(
      (e) => e.type === "store_message" && e.rejection === true,
    );
    assert.ok(rejections.length >= 1, "expected at least one over-cap rejection");
    assert.ok(
      rejections.some(
        (r) =>
          r.rejectedPrice === 125 &&
          /excede tu tope/.test(r.text) &&
          r.storeId === "A",
      ),
      "expected the 125 'solo hoy' offer from A to be rejected",
    );

    // B offered/accepted 112 but is discarded for deadline (Monday > Friday).
    const bPrices = events
      .filter((e) => e.type === "store_message" && e.storeId === "B")
      .map((e) => e.price);
    assert.ok(bPrices.includes(112), `B should emit price 112, saw ${bPrices}`);
    const bDiscarded = events.find(
      (e) => e.type === "store_discarded" && e.storeId === "B",
    );
    assert.ok(bDiscarded, "B must be discarded");
    assert.equal(bDiscarded.reason, "deadline");

    // Winner: C at 115, free shipping.
    const proposals = events.filter((e) => e.type === "proposal");
    assert.equal(proposals.length, 1);
    const p = proposals[0];
    assert.equal(p.storeId, "C");
    assert.equal(p.finalPrice, 115);
    assert.equal(p.shipping, 0);
    assert.equal(p.savings, 128 - 115);
    assert.ok(p.deliveryDate <= LIMITS.deadline);
    assert.ok(p.finalPrice <= LIMITS.maxAmount, "winner must never exceed cap");
    assert.ok(Array.isArray(p.thread) && p.thread.length > 0);

    // Final event is the proposal.
    assert.equal(events[events.length - 1].type, "proposal");
  });

  it("buyer never offers above the cap", async () => {
    const stores = createDemoStores({ now: NOW });
    const events = await collect(LIMITS, stores, { maxRounds: 3 });
    for (const e of events) {
      if (e.type === "store_message" && e.from === "buyer" && e.price != null) {
        assert.ok(e.price <= 120, `buyer offered ${e.price} over cap`);
      }
    }
  });

  it("custom writer only changes text, never prices", async () => {
    const stores = createDemoStores({ now: NOW });
    const writer = async ({ price, storeId }) =>
      `[LLM buyer -> ${storeId}: offer ${price}]`;
    const events = await collect(LIMITS, stores, { writer, maxRounds: 3 });
    const proposal = events.find((e) => e.type === "proposal");
    assert.equal(proposal.storeId, "C");
    assert.equal(proposal.finalPrice, 115);
    assert.ok(
      events.some(
        (e) =>
          e.type === "store_message" &&
          e.from === "buyer" &&
          String(e.text).startsWith("[LLM buyer"),
      ),
    );
  });
});
