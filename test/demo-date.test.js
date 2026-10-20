import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { MockPayPal } from "../src/paypal.js";

const TEXT = "Audífonos con ANC, máx USD 120, llegan antes del viernes";

async function startServer(clock) {
  const created = createServer({ paypal: new MockPayPal(), clock });
  const server = created.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function pollUntil(base, id, want, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await api(base, "GET", `/api/mandados/${id}`);
    if (data.status === want) return data;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${want}: ${data.status}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("single base date per mandado (clock injection)", () => {
  it("Tuesday 2026-10-20 -> deadline 2026-10-23 and store B discarded for deadline", async () => {
    const { server, base } = await startServer(
      () => new Date("2026-10-20T14:00:00Z"),
    );
    try {
      const { status, data } = await api(base, "POST", "/api/mandados", {
        text: TEXT,
      });
      assert.equal(status, 201);
      assert.equal(data.limits.maxAmount, 120);
      assert.equal(data.limits.deadline, "2026-10-23");

      const final = await pollUntil(base, data.id, "proposed");
      assert.equal(final.discarded.B, "deadline");
      assert.ok(final.proposal.storeId !== "B");
      assert.equal(final.proposal.storeId, "C");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("Tuesday 2026-11-03 -> stores follow the injected date, B discarded for deadline", async () => {
    const { server, base } = await startServer(
      () => new Date("2026-11-03T14:00:00Z"),
    );
    try {
      const { data } = await api(base, "POST", "/api/mandados", { text: TEXT });
      assert.equal(data.limits.deadline, "2026-11-06");

      const final = await pollUntil(base, data.id, "proposed");
      assert.equal(final.discarded.B, "deadline");
      assert.ok(final.proposal.storeId !== "B");
      assert.equal(final.proposal.storeId, "C");
      assert.ok(final.proposal.deliveryDate <= data.limits.deadline);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
