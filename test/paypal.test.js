import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PayPalClient,
  MockPayPal,
  createPayPalClient,
  SANDBOX_BASE,
} from "../src/paypal.js";
import { CapExceededError } from "../src/limits.js";

/** Build a mock fetch that records requests and serves canned PayPal payloads. */
function mockFetchServer() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const json = (data, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    });
    if (url.endsWith("/v1/oauth2/token")) {
      return json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.endsWith("/v2/checkout/orders") && (init.method ?? "GET") === "POST") {
      const body = JSON.parse(init.body);
      return json({
        id: "ORDER-1",
        intent: body.intent,
        status: "CREATED",
        links: [{ rel: "approve", href: "https://approve/ORDER-1" }],
      });
    }
    if (url.endsWith("/v2/checkout/orders/ORDER-1")) {
      return json({ id: "ORDER-1", status: "APPROVED" });
    }
    if (url.endsWith("/v2/checkout/orders/ORDER-1/authorize")) {
      return json({ id: "AUTH-1", status: "AUTHORIZED" });
    }
    if (url.endsWith("/v2/payments/authorizations/AUTH-1/capture")) {
      return json({ id: "AUTH-1", status: "CAPTURED" });
    }
    if (url.endsWith("/v2/payments/authorizations/AUTH-1/void")) {
      return json({ id: "AUTH-1", status: "VOIDED" });
    }
    if (url.endsWith("/v2/payments/authorizations/AUTH-1")) {
      return json({ id: "AUTH-1", status: "AUTHORIZED" });
    }
    return json({ error: "unexpected " + url }, 500);
  };
  return { calls, fetchImpl };
}

describe("cap guard: createOrder above cap throws and fetch is never called", () => {
  it("PayPalClient refuses without touching the network", async () => {
    let fetchCalls = 0;
    const client = new PayPalClient({
      clientId: "id",
      secret: "sh",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      },
      limits: { maxAmount: 120 },
    });
    await assert.rejects(
      () => client.createOrder({ amount: 125 }),
      CapExceededError,
    );
    assert.equal(fetchCalls, 0);
  });

  it("MockPayPal guard also refuses without state changes", async () => {
    const mock = new MockPayPal({ limits: { maxAmount: 120 } });
    await assert.rejects(() => mock.createOrder({ amount: 200 }), /excede tu tope/);
    assert.equal(mock.orders.size, 0);
  });

  it("createPayPalClient() without credentials returns the mock", () => {
    const c = createPayPalClient({
      clientId: undefined,
      secret: undefined,
      mock: true,
    });
    assert.ok(c instanceof MockPayPal);
  });
});

describe("PayPalClient REST endpoints (mocked fetch, no network)", () => {
  it("uses intent AUTHORIZE and the correct authorize/capture/void endpoints", async () => {
    const { calls, fetchImpl } = mockFetchServer();
    const client = new PayPalClient({
      clientId: "id",
      secret: "sh",
      baseUrl: SANDBOX_BASE,
      fetchImpl,
      limits: { maxAmount: 120 },
    });

    const order = await client.createOrder({ amount: 115, description: "Mandado" });
    assert.equal(order.id, "ORDER-1");

    const createCall = calls.find((c) => c.url.endsWith("/v2/checkout/orders"));
    assert.ok(createCall);
    assert.equal(createCall.method, "POST");
    const createBody = JSON.parse(createCall.body);
    assert.equal(createBody.intent, "AUTHORIZE");
    assert.equal(createBody.purchase_units[0].amount.value, "115.00");

    await client.getOrder("ORDER-1");
    assert.ok(calls.some((c) => c.url.endsWith("/v2/checkout/orders/ORDER-1") && c.method === "GET"));

    await client.authorizeOrder("ORDER-1");
    assert.ok(
      calls.some(
        (c) => c.url.endsWith("/v2/checkout/orders/ORDER-1/authorize") && c.method === "POST",
      ),
      "must POST .../orders/{id}/authorize",
    );

    await client.getAuthorization("AUTH-1");
    assert.ok(
      calls.some((c) => c.url.endsWith("/v2/payments/authorizations/AUTH-1")),
    );

    await client.captureAuthorization("AUTH-1");
    assert.ok(
      calls.some(
        (c) => c.url.endsWith("/v2/payments/authorizations/AUTH-1/capture") && c.method === "POST",
      ),
    );

    await client.voidAuthorization("AUTH-1");
    assert.ok(
      calls.some(
        (c) => c.url.endsWith("/v2/payments/authorizations/AUTH-1/void") && c.method === "POST",
      ),
    );
  });
});

describe("MockPayPal lifecycle", () => {
  it("CREATED -> APPROVED -> AUTHORIZED -> CAPTURED, and approve link present", async () => {
    const mock = new MockPayPal({ limits: { maxAmount: 120 } });
    const order = await mock.createOrder({ amount: 115 });
    assert.equal(order.status, "CREATED");
    const approve = order.links.find((l) => l.rel === "approve");
    assert.ok(approve?.href);

    const ap = await mock.approve(order.id);
    assert.equal(ap.status, "APPROVED");

    const auth = await mock.authorizeOrder(order.id);
    assert.equal(auth.status, "AUTHORIZED");
    assert.ok(auth.id);

    const cap = await mock.captureAuthorization(auth.id);
    assert.equal(cap.status, "CAPTURED");
  });

  it("AUTHORIZED -> VOIDED", async () => {
    const mock = new MockPayPal({ limits: { maxAmount: 120 } });
    const order = await mock.createOrder({ amount: 100 });
    await mock.approve(order.id);
    const auth = await mock.authorizeOrder(order.id);
    const v = await mock.voidAuthorization(auth.id);
    assert.equal(v.status, "VOIDED");
  });
});
