/**
 * PayPal Orders v2 REST client (AUTHORIZE flow) + in-memory mock.
 *
 * Real flow: createOrder(intent=AUTHORIZE) -> buyer approves via approveUrl
 * -> authorizeOrder(orderId) -> AUTHORIZED -> captureAuthorization(authId)
 * -> CAPTURED, or voidAuthorization(authId) -> VOIDED.
 *
 * The cap guard (assertWithinCap) runs BEFORE any network request.
 * Tests inject a mocked fetch; when credentials are missing,
 * createPayPalClient() returns MockPayPal with the same interface.
 */

import { assertWithinCap } from "./limits.js";

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
export const LIVE_BASE = "https://api-m.paypal.com";

function baseForEnv(env) {
  return String(env ?? "").toLowerCase() === "live" ? LIVE_BASE : SANDBOX_BASE;
}

function money(amount) {
  return Number(amount).toFixed(2);
}

export class PayPalClient {
  /**
   * @param {{ clientId?: string, secret?: string, baseUrl?: string, env?: string,
   *   cap?: number|null, limits?: {maxAmount:number}|null, fetchImpl?: Function }} [options]
   */
  constructor(options = {}) {
    this.clientId =
      options.clientId ?? process.env.PAYPAL_CLIENT_ID ?? null;
    this.secret =
      options.secret ?? process.env.PAYPAL_CLIENT_SECRET ?? null;
    this.baseUrl =
      options.baseUrl ??
      baseForEnv(options.env ?? process.env.PAYPAL_ENV);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cap =
      options.cap ?? options.limits?.maxAmount ?? null;
    this.limits = options.limits ?? null;
    this._token = null;
    this._tokenExp = 0;
  }

  _guard(amount, limitsOverride) {
    const limits =
      limitsOverride ?? this.limits ?? (this.cap !== null ? { maxAmount: this.cap } : null);
    if (limits && limits.maxAmount !== undefined && limits.maxAmount !== null) {
      assertWithinCap(Number(amount), limits);
    }
  }

  async _fetch(path, { method = "GET", body = null, auth = true } = {}) {
    let headers = { "Content-Type": "application/json" };
    if (auth) {
      const token = await this.getToken();
      headers = { ...headers, Authorization: `Bearer ${token}` };
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        `PayPal ${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`,
      );
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }

  /** OAuth2 client_credentials. */
  async getToken() {
    if (this._token && Date.now() < this._tokenExp) return this._token;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString("base64");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`PayPal token failed: ${res.status}`);
      err.status = res.status;
      err.details = data;
      throw err;
    }
    this._token = data.access_token;
    this._tokenExp = Date.now() + (data.expires_in ?? 300) * 1000 - 10_000;
    return this._token;
  }

  /**
   * Create an order with intent AUTHORIZE. Guarded by the cap BEFORE any request.
   * @param {{ amount: number, currency?: string, description?: string, limits?: {maxAmount:number} }} args
   */
  async createOrder({ amount, currency = "USD", description = "Mandado", limits } = {}) {
    this._guard(amount, limits); // throws CapExceededError; no fetch happens
    return this._fetch("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            description,
            amount: { currency_code: currency, value: money(amount) },
          },
        ],
      },
    });
  }

  async getOrder(orderId) {
    return this._fetch(`/v2/checkout/orders/${orderId}`);
  }

  /** Authorize an approved order. Returns the authorization payload. */
  async authorizeOrder(orderId) {
    return this._fetch(`/v2/checkout/orders/${orderId}/authorize`, {
      method: "POST",
      body: {},
    });
  }

  async getAuthorization(authId) {
    return this._fetch(`/v2/payments/authorizations/${authId}`);
  }

  async captureAuthorization(authId) {
    return this._fetch(`/v2/payments/authorizations/${authId}/capture`, {
      method: "POST",
      body: {},
    });
  }

  async voidAuthorization(authId) {
    return this._fetch(`/v2/payments/authorizations/${authId}/void`, {
      method: "POST",
      body: {},
    });
  }
}

/**
 * In-memory mock with the same interface. No network.
 * Lifecycle: CREATED -> APPROVED (via approve(orderId)) -> AUTHORIZED
 * -> CAPTURED | VOIDED. createOrder returns an approve link.
 */
export class MockPayPal {
  constructor(options = {}) {
    this.cap = options.cap ?? options.limits?.maxAmount ?? null;
    this.limits = options.limits ?? null;
    this.orders = new Map();
    this.auths = new Map();
    this._seq = 1;
  }

  _guard(amount, limitsOverride) {
    const limits =
      limitsOverride ?? this.limits ?? (this.cap !== null ? { maxAmount: this.cap } : null);
    if (limits && limits.maxAmount !== undefined && limits.maxAmount !== null) {
      assertWithinCap(Number(amount), limits);
    }
  }

  async getToken() {
    return "mock-access-token";
  }

  _approveUrl(id) {
    return `https://www.sandbox.paypal.com/checkoutnow?token=${id}`;
  }

  async createOrder({ amount, currency = "USD", description = "Mandado", limits } = {}) {
    this._guard(amount, limits);
    const id = `MOCK-ORDER-${this._seq++}`;
    const order = {
      id,
      intent: "AUTHORIZE",
      status: "CREATED",
      purchase_units: [
        {
          description,
          amount: { currency_code: currency, value: money(amount) },
        },
      ],
      links: [
        { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`, method: "GET" },
        { rel: "approve", href: this._approveUrl(id), method: "GET" },
      ],
    };
    this.orders.set(id, order);
    return order;
  }

  /** Mock buyer approval (auto-approve). Returns { id, status: 'APPROVED', approveUrl }. */
  async approve(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`MockPayPal: unknown order ${orderId}`);
    order.status = "APPROVED";
    order.payer = { payer_id: "MOCK-PAYER" };
    return { id: orderId, status: "APPROVED", approveUrl: this._approveUrl(orderId) };
  }

  approveUrl(order) {
    const link = order?.links?.find((l) => l.rel === "approve");
    return link?.href ?? this._approveUrl(order?.id);
  }

  async getOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`MockPayPal: unknown order ${orderId}`);
    return { ...order };
  }

  async authorizeOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`MockPayPal: unknown order ${orderId}`);
    if (order.status !== "APPROVED") {
      const err = new Error(`MockPayPal: order ${orderId} is ${order.status}, must be APPROVED`);
      err.status = 422;
      throw err;
    }
    const authId = `MOCK-AUTH-${this._seq++}`;
    const amount = order.purchase_units[0].amount;
    const auth = { id: authId, status: "AUTHORIZED", orderId, amount };
    this.auths.set(authId, auth);
    order.status = "AUTHORIZED";
    return { ...auth, purchase_units: order.purchase_units };
  }

  async getAuthorization(authId) {
    const auth = this.auths.get(authId);
    if (!auth) throw new Error(`MockPayPal: unknown authorization ${authId}`);
    return { ...auth };
  }

  async captureAuthorization(authId) {
    const auth = this.auths.get(authId);
    if (!auth) throw new Error(`MockPayPal: unknown authorization ${authId}`);
    if (auth.status !== "AUTHORIZED") {
      const err = new Error(`MockPayPal: authorization ${authId} is ${auth.status}`);
      err.status = 422;
      throw err;
    }
    auth.status = "CAPTURED";
    return { ...auth, status: "CAPTURED" };
  }

  async voidAuthorization(authId) {
    const auth = this.auths.get(authId);
    if (!auth) throw new Error(`MockPayPal: unknown authorization ${authId}`);
    if (auth.status !== "AUTHORIZED") {
      const err = new Error(`MockPayPal: authorization ${authId} is ${auth.status}`);
      err.status = 422;
      throw err;
    }
    auth.status = "VOIDED";
    return { ...auth, status: "VOIDED" };
  }
}

/**
 * Factory: real client when credentials exist, otherwise the mock.
 * @param {{ clientId?: string, secret?: string, env?: string, baseUrl?: string,
 *   cap?: number|null, limits?: object|null, fetchImpl?: Function, mock?: boolean }} [options]
 */
export function createPayPalClient(options = {}) {
  const clientId = options.clientId ?? process.env.PAYPAL_CLIENT_ID;
  const secret = options.secret ?? process.env.PAYPAL_CLIENT_SECRET;
  if (options.mock === true || !clientId || !secret) {
    return new MockPayPal(options);
  }
  return new PayPalClient({ ...options, clientId, secret });
}
