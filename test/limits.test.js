import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRequest,
  parseRequestWithLlm,
  assertWithinCap,
  CapExceededError,
} from "../src/limits.js";

const WED = "2026-10-14T12:00:00.000Z"; // Wednesday

describe("parseRequest (deterministic, Spanish + English)", () => {
  it("parses the demo sentence: cap 120, ANC, deadline next Friday", () => {
    const out = parseRequest(
      "Audífonos con ANC, máx USD 120, llegan antes del viernes",
      { now: WED },
    );
    assert.equal(out.maxAmount, 120);
    assert.equal(out.currency, "USD");
    assert.equal(out.deadline, "2026-10-16"); // Friday after Wed 2026-10-14
    assert.ok(out.attributes.includes("ANC"));
    assert.match(out.item, /Aud[ií]fonos/i);
  });

  it('supports "max $120"', () => {
    const out = parseRequest("Headphones, max $120, before Friday", {
      now: WED,
    });
    assert.equal(out.maxAmount, 120);
    assert.equal(out.deadline, "2026-10-16");
  });

  it('supports "hasta 120 dólares"', () => {
    const out = parseRequest("Audífonos hasta 120 dólares", { now: WED });
    assert.equal(out.maxAmount, 120);
    assert.equal(out.deadline, null);
  });

  it("supports English weekday 'friday' and explicit ISO 'before 2026-10-20'", () => {
    const a = parseRequest("Headphones max USD 90 before Friday", { now: WED });
    assert.equal(a.deadline, "2026-10-16");
    const b = parseRequest("Headphones max USD 90 before 2026-10-20", {
      now: WED,
    });
    assert.equal(b.deadline, "2026-10-20");
  });

  it("same weekday rolls forward 7 days (strictly in the future)", () => {
    const out = parseRequest("Audífonos, máx USD 100, para el viernes", {
      now: "2026-10-16T12:00:00.000Z", // a Friday
    });
    assert.equal(out.deadline, "2026-10-23");
  });

  it("throws when no cap is present", () => {
    assert.throws(() => parseRequest("Audífonos con ANC", { now: WED }), /cap|tope/i);
  });
});

describe("LLM hook never overrides caps/deadlines", () => {
  it("parseRequestWithLlm ignores lying maxAmount/deadline hints", async () => {
    const lying = async () => ({
      item: "Algo inventado",
      maxAmount: 9999,
      deadline: "2030-01-01",
      attributes: ["bluetooth"],
    });
    const out = await parseRequestWithLlm(
      "Audífonos con ANC, máx USD 120, llegan antes del viernes",
      { now: WED, llmParse: lying },
    );
    assert.equal(out.maxAmount, 120);
    assert.equal(out.deadline, "2026-10-16");
    // LLM may enrich attributes but never caps/deadlines
    assert.ok(out.attributes.includes("ANC"));
    assert.ok(out.attributes.includes("bluetooth"));
  });
});

describe("assertWithinCap", () => {
  it("passes at exactly the cap, throws above it", () => {
    assert.doesNotThrow(() =>
      assertWithinCap(120, { maxAmount: 120 }),
    );
    assert.throws(() => assertWithinCap(120.01, { maxAmount: 120 }), CapExceededError);
    assert.throws(() => assertWithinCap(125, { maxAmount: 120 }), /excede tu tope/);
  });
});
