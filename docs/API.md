# Mandado API (P0)

Base URL: `http://localhost:3000` (override with `PORT`).

All responses are JSON except the SSE stream. CORS is open (`Access-Control-Allow-Origin: *`).

## Endpoints

### POST /api/mandados

Start a mandado: parse limits from free text and start the buyer/store negotiation in the background.

Request:

```json
{ "text": "Audífonos con ANC, máx USD 120, llegan antes del viernes" }
```

Response `201`:

```json
{
  "id": "3f9c…",
  "limits": {
    "item": "Audífonos con ANC",
    "maxAmount": 120,
    "currency": "USD",
    "deadline": "2026-10-16",
    "attributes": ["ANC"]
  },
  "ai": { "enabled": false, "model": null }
}
```

`ai` reports whether the optional OpenAI-compatible LLM is active (`enabled`) and which model is configured (`model`), without exposing any secret. See [README IA (LLM)](../README.md#ia-llm).

### GET /api/mandados/:id

Full state for polling. Response `200`:

```json
{
  "id": "3f9c…",
  "limits": { "item": "…", "maxAmount": 120, "currency": "USD", "deadline": "2026-10-16", "attributes": ["ANC"] },
  "status": "negotiating | proposed | no_deal | awaiting_approval | authorized | captured | voided | error",
  "stores": {
    "A": { "messages": [ { "from": "buyer|store", "round": 0, "price": 108, "text": "…" } ], "discarded": null },
    "B": { "messages": [ … ], "discarded": { "reason": "deadline", "detail": "…" } },
    "C": { "messages": [ … ], "discarded": null }
  },
  "discarded": { "B": "deadline" },
  "proposal": {
    "type": "proposal",
    "storeId": "C",
    "storeName": "Tienda C",
    "finalPrice": 115,
    "shipping": 0,
    "total": 115,
    "listPrice": 128,
    "savings": 13,
    "deliveryDate": "2026-10-15",
    "thread": [ … ]
  },
  "payment": null,
  "events": [ … ],
  "ai": { "enabled": false, "model": null }
}
```

The frontend renders **3 store columns** from `stores.A/B/C.messages` (round-by-round thread) plus a badge when `discarded` is set.

Discard reasons: `deadline | over_cap | no_stock | no_deal`.

### GET /api/mandados/:id/events (SSE)

`Content-Type: text/event-stream`. The server replays all past events, then streams live ones. Event types:

| event | data JSON schema |
|---|---|
| `limits` | `{ "type": "limits", "limits": { item, maxAmount, currency, deadline, attributes } }` |
| `store_message` | `{ "type": "store_message", "from": "buyer\|store", "storeId": "A\|B\|C", "round": 0, "price": 108\|null, "text": "…", "action?": "accept\|counter", "deliveryDate?": "YYYY-MM-DD", "rejection?": true, "rejectedPrice?": 125, "reason?": "excede tu tope" }` |
| `store_discarded` | `{ "type": "store_discarded", "storeId": "B", "reason": "deadline\|over_cap\|no_stock\|no_deal", "detail?": "…", "price?": 112, "deliveryDate?": "YYYY-MM-DD" }` |
| `proposal` | `{ "type": "proposal", "storeId": "C", "storeName": "Tienda C", "finalPrice": 115, "shipping": 0, "total": 115, "listPrice": 128, "savings": 13, "deliveryDate": "YYYY-MM-DD", "thread": [store_message…] }` |
| `payment_update` | `{ "type": "payment_update", "status": "…", "payment": { "orderId": "…", "approveUrl": "…", "status": "CREATED\|APPROVED\|AUTHORIZED\|CAPTURED\|VOIDED", "amount": 115, "currency": "USD", "authorizationId": "…"\|null } }` |
| `error` | `{ "type": "error", "message": "…" }` |
| `done` | `{ "type": "done", "status": "proposed\|no_deal\|…" }` |

Wire format per event:

```
event: store_message
data: {"type":"store_message",…}

```

### POST /api/mandados/:id/authorize

Create a PayPal order with `intent: "AUTHORIZE"` for the proposal total (cap-guarded server-side; `400` if it ever exceeded the cap). Response `201`:

```json
{ "orderId": "…", "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=…", "status": "CREATED" }
```

### POST /api/mandados/:id/approved

Call after the buyer approved the order in PayPal. Authorizes the order → `AUTHORIZED`. Response `200`:

```json
{ "orderId": "…", "approveUrl": "…", "status": "AUTHORIZED", "authorizationId": "…", "amount": 115, "currency": "USD" }
```

### POST /api/mandados/:id/capture

Capture the authorization (only after human approval). → `CAPTURED`.

### POST /api/mandados/:id/void

Void the authorization. → `VOIDED`.
