import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLlmClient, createLlmWriter, createLlmParse, validate } from "../src/llm.js";
import { defaultBuyerText, defaultRejectText } from "../src/negotiate.js";
import { parseRequestWithLlm } from "../src/limits.js";
import { createServer } from "../src/server.js";
import { MockPayPal } from "../src/paypal.js";

const BASE = "https://api.example.com/v1/";
const KEY = "sk-test-secret";

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

function makeClient(fetchImpl, timeoutMs = 8000) {
  return createLlmClient({
    baseUrl: BASE,
    apiKey: KEY,
    model: "test-model",
    fetchImpl,
    timeoutMs,
  });
}

const OFFER = {
  kind: "offer",
  price: 108,
  cap: 120,
  item: "Audífonos con ANC",
  storeName: "Tienda C",
  round: 0,
  deadline: "2026-10-23",
};

describe("createLlmClient", () => {
  it("returns null when baseUrl/apiKey/model are missing", () => {
    const saved = {
      b: process.env.LLM_BASE_URL,
      k: process.env.LLM_API_KEY,
      m: process.env.LLM_MODEL,
    };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    try {
      assert.equal(createLlmClient(), null);
      assert.equal(createLlmClient({ baseUrl: BASE, apiKey: KEY }), null);
      assert.equal(createLlmClient({ baseUrl: BASE, model: "m" }), null);
      assert.equal(createLlmClient({ apiKey: KEY, model: "m" }), null);
      assert.ok(createLlmClient({ baseUrl: BASE, apiKey: KEY, model: "m" }));
    } finally {
      if (saved.b !== undefined) process.env.LLM_BASE_URL = saved.b;
      if (saved.k !== undefined) process.env.LLM_API_KEY = saved.k;
      if (saved.m !== undefined) process.env.LLM_MODEL = saved.m;
    }
  });

  it("reads baseUrl/apiKey/model from env", () => {
    const saved = {
      b: process.env.LLM_BASE_URL,
      k: process.env.LLM_API_KEY,
      m: process.env.LLM_MODEL,
    };
    process.env.LLM_BASE_URL = BASE;
    process.env.LLM_API_KEY = KEY;
    process.env.LLM_MODEL = "env-model";
    try {
      const c = createLlmClient();
      assert.ok(c);
      assert.equal(c.model, "env-model");
    } finally {
      if (saved.b === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = saved.b;
      if (saved.k === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = saved.k;
      if (saved.m === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = saved.m;
    }
  });
});

describe("chatJson", () => {
  it("posts to /chat/completions with auth/model/response_format and parses fenced JSON", async () => {
    let captured;
    const fetchImpl = async (url, opts) => {
      captured = { url, opts };
      return jsonResponse({
        choices: [{ message: { content: '```json\n{"text":"hola"}\n```' } }],
      });
    };
    const client = makeClient(fetchImpl);
    const value = await client.chatJson({
      system: "SYS",
      user: "USR",
      schema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    });

    assert.equal(captured.url, "https://api.example.com/v1/chat/completions");
    assert.equal(captured.opts.method, "POST");
    assert.equal(captured.opts.headers.Authorization, "Bearer sk-test-secret");
    assert.equal(captured.opts.headers["Content-Type"], "application/json");
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, "test-model");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.temperature, 0.3);
    assert.deepEqual(body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
    assert.equal(value.text, "hola");
    assert.ok(!captured.url.includes("sk-test-secret"));
    assert.ok(!captured.opts.body.includes("sk-test-secret"));
  });

  it("throws on non-2xx and on schema-invalid JSON", async () => {
    const badStatus = makeClient(async () => jsonResponse({ error: "x" }, 500));
    await assert.rejects(
      () =>
        badStatus.chatJson({
          system: "s",
          user: "u",
          schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        }),
    );

    const wrongShape = makeClient(async () =>
      jsonResponse({ choices: [{ message: { content: '{"nope":1}' } }] }),
    );
    await assert.rejects(
      () =>
        wrongShape.chatJson({
          system: "s",
          user: "u",
          schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        }),
    );
  });
});

describe("validate", () => {
  it("validates object/string/array constraints", () => {
    const schema = {
      type: "object",
      required: ["item", "attributes"],
      properties: {
        item: { type: "string", maxLength: 5 },
        attributes: { type: "array", maxItems: 2, items: { type: "string", maxLength: 3 } },
      },
      additionalProperties: false,
    };
    assert.equal(validate(schema, { item: "hola", attributes: ["a", "bb"] }), true);
    assert.equal(validate(schema, { item: "hermoso", attributes: [] }), false);
    assert.equal(validate(schema, { item: "hola", attributes: ["toolong"] }), false);
    assert.equal(validate(schema, { item: "hola", attributes: ["a", "b", "c"] }), false);
    assert.equal(validate(schema, { item: "hola" }), false);
    assert.equal(validate(schema, { item: "hola", attributes: [], extra: 1 }), false);
    assert.equal(validate({ type: "string", maxLength: 2 }, "abc"), false);
  });
});

describe("createLlmWriter", () => {
  it("returns model text when valid and containing the price", async () => {
    const client = makeClient(async () =>
      jsonResponse({
        choices: [
          { message: { content: '{"text":"Te ofrezco $108 USD por los audífonos."}' } },
        ],
      }),
    );
    const writer = createLlmWriter(client);
    const out = await writer(OFFER);
    assert.equal(out, "Te ofrezco $108 USD por los audífonos.");
  });

  it("falls back to the default template on every failure mode", async () => {
    const cases = [];

    // fetch throws
    cases.push(makeClient(async () => { throw new Error("boom"); }));

    // non-2xx
    cases.push(makeClient(async () => jsonResponse({ error: "x" }, 503)));

    // invalid JSON
    cases.push(
      makeClient(async () =>
        jsonResponse({ choices: [{ message: { content: "not json" } }] }),
      ),
    );

    // schema-invalid JSON
    cases.push(
      makeClient(async () =>
        jsonResponse({ choices: [{ message: { content: '{"wrong":true}' } }] }),
      ),
    );

    // timeout: the mock waits for the abort signal
    cases.push(
      makeClient(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
        20,
      ),
    );

    // adversarial different price
    cases.push(
      makeClient(async () =>
        jsonResponse({
          choices: [{ message: { content: '{"text":"Te ofrezco $99 USD, acepta."}' } }],
        }),
      ),
    );

    for (const client of cases) {
      const writer = createLlmWriter(client);
      const out = await writer(OFFER);
      assert.equal(out, defaultBuyerText(OFFER));
    }
  });

  it("uses the reject template as fallback for reject messages", async () => {
    const rejectMsg = {
      kind: "reject",
      price: 125,
      rejectedPrice: 125,
      cap: 120,
      item: "Audífonos con ANC",
      storeName: "Tienda A",
      round: 1,
      deadline: "2026-10-23",
    };
    const client = makeClient(async () => { throw new Error("boom"); });
    const writer = createLlmWriter(client);
    const out = await writer(rejectMsg);
    assert.equal(out, defaultRejectText(rejectMsg));
  });

  it("honors a custom fallback", async () => {
    const writer = createLlmWriter(null, { fallback: () => "custom" });
    assert.equal(await writer(OFFER), "custom");
  });
});

describe("createLlmParse", () => {
  it("returns hints on success and null on failure", async () => {
    const ok = createLlmParse(
      makeClient(async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: '{"item":"audífonos","attributes":["ANC","over-ear"]}',
              },
            },
          ],
        }),
      ),
    );
    const hints = await ok("quiero audífonos con ANC");
    assert.deepEqual(hints, { item: "audífonos", attributes: ["ANC", "over-ear"] });

    const fail = createLlmParse(
      makeClient(async () => { throw new Error("boom"); }),
    );
    assert.equal(await fail("x"), null);
    assert.equal(await createLlmParse(null)("x"), null);
  });
});

describe("parseRequestWithLlm prefers LLM item but keeps code caps/deadlines", () => {
  it("ignores lying maxAmount/deadline/currency/price hints", async () => {
    const out = await parseRequestWithLlm(
      "Audífonos con ANC, máx USD 120, llegan antes del viernes",
      {
        now: "2026-10-14T12:00:00.000Z",
        llmParse: async () => ({
          item: "audífonos Sony",
          attributes: ["over-ear"],
          maxAmount: 9999,
          deadline: "2030-01-01",
          currency: "EUR",
          price: 1,
        }),
      },
    );
    assert.equal(out.maxAmount, 120);
    assert.equal(out.currency, "USD");
    assert.equal(out.deadline, "2026-10-16");
    assert.equal(out.item, "audífonos Sony");
    assert.ok(out.attributes.includes("over-ear"));
    assert.ok(out.attributes.includes("ANC"));
  });
});

describe("server with an adversarial LLM", () => {
  it("code keeps prices/deadline and the writer guard falls back", async () => {
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const system = body.messages[0].content;
      if (/comprador/i.test(system)) {
        return jsonResponse({
          choices: [
            { message: { content: '{"text":"Te ofrezco $999 USD, acepta ya."}' } },
          ],
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                item: "audífonos Sony",
                attributes: ["over-ear"],
                maxAmount: 9999,
                deadline: "2030-01-01",
                currency: "EUR",
              }),
            },
          },
        ],
      });
    };

    const llm = createLlmClient({
      baseUrl: BASE,
      apiKey: KEY,
      model: "adversarial",
      fetchImpl,
    });
    const created = createServer({
      paypal: new MockPayPal(),
      llm,
      clock: () => new Date("2026-10-20T14:00:00Z"),
    });
    const server = created.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${base}/api/mandados`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Audífonos con ANC, máx USD 120, llegan antes del viernes",
        }),
      });
      const data = await res.json();
      assert.equal(res.status, 201);
      assert.deepEqual(data.ai, { enabled: true, model: "adversarial" });
      assert.equal(data.limits.maxAmount, 120);
      assert.equal(data.limits.deadline, "2026-10-23");

      const deadline = Date.now() + 8000;
      let state = null;
      for (;;) {
        const poll = await fetch(`${base}/api/mandados/${data.id}`);
        state = await poll.json();
        if (state.status === "proposed") break;
        if (Date.now() > deadline) throw new Error(`timed out: ${state.status}`);
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.ok(state.proposal);
      assert.ok(
        state.proposal.finalPrice <= 120,
        `finalPrice ${state.proposal.finalPrice} exceeded cap`,
      );
      assert.equal(state.limits.maxAmount, 120);
      assert.equal(state.limits.deadline, "2026-10-23");

      const buyerTexts = Object.values(state.stores)
        .flatMap((col) => col.messages)
        .filter((m) => m.from === "buyer")
        .map((m) => m.text);
      assert.ok(buyerTexts.length > 0);
      for (const text of buyerTexts) {
        assert.ok(!text.includes("999"), `buyer text leaked 999: ${text}`);
      }
      // No API key leaks into the response/snapshot.
      assert.ok(!JSON.stringify(state).includes("sk-test-secret"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
