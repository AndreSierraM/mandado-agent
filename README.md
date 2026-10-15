# Mandado

**Buyer and store AI agents negotiate; PayPal authorizes then captures only after human approval.**

> *Agentes de comprador y tienda negocian; PayPal autoriza y solo captura cuando tú apruebas.*

Built for the [PayPal AI Agent Hackathon](https://paypalaihackathon.devpost.com).

## Status

P0 backend working: deterministic limit parsing, 3-store negotiation, PayPal Orders v2 (AUTHORIZE → capture/void), HTTP + SSE server. No npm dependencies (Node built-ins only).

## Stack

Node.js >= 20, ESM, plain JavaScript. No TypeScript build step. No npm dependencies — only `node:http`, `node:test`, `node:assert`, and global `fetch`.

## How to run

```bash
npm test     # run the full test suite (no network access)
npm start    # serve on http://localhost:3000 (PORT env to override)
```

Demo request:

```bash
curl -X POST http://localhost:3000/api/mandados \
  -H 'Content-Type: application/json' \
  -d '{"text":"Audífonos con ANC, máx USD 120, llegan antes del viernes"}'
```

Then poll `GET /api/mandados/:id` or stream `GET /api/mandados/:id/events` (SSE), and walk the payment flow:

```bash
curl -X POST http://localhost:3000/api/mandados/$ID/authorize
# buyer approves approveUrl in PayPal, then:
curl -X POST http://localhost:3000/api/mandados/$ID/approved
curl -X POST http://localhost:3000/api/mandados/$ID/capture  # or /void
```

See [docs/API.md](./docs/API.md) for endpoints and SSE event JSON schema.

## Env vars

| Var | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PAYPAL_CLIENT_ID` | (none → mock) | PayPal REST app client id |
| `PAYPAL_CLIENT_SECRET` | (none → mock) | PayPal REST app secret |
| `PAYPAL_ENV` | `sandbox` | `sandbox` → `https://api-m.sandbox.paypal.com`, `live` → `https://api-m.paypal.com` |

Without credentials the server uses an in-memory `MockPayPal` with the same interface (`CREATED → APPROVED → AUTHORIZED → CAPTURED/VOIDED` plus an approve link), so the demo and tests never hit the network.

## PayPal Agent Toolkit finding

`@paypal/agent-toolkit` v1.11.0 (checked 2026-10-15) exposes `create_order` (hardcoded `intent: "CAPTURE"`), `get_order`, `capture_order`, and refunds — it does **NOT** expose `authorize` or `void`, nor `intent: "AUTHORIZE"`.

Mandado needs authorize-then-capture (hold funds at agreement time, capture only after human approval), so it uses **PayPal Orders v2 REST directly** for `create(AUTHORIZE)` / `authorize` / `capture` / `void` (see `src/paypal.js`); the toolkit can still be used for `get_order`.

## UI

Ejecuta `npm start` y abre http://localhost:3000. La UI es una aplicación vanilla HTML/CSS/JS sin pasos de build ni dependencias externas:

- **Hero:** "Mandado: tu agente regatea por ti." + tagline "Tu agente negocia. PayPal retiene. Tú decides." + badge "Modo mock (sandbox sin credenciales)"
- **Textarea:** prefill "Audífonos con ANC, máx USD 120, llegan antes del viernes" → POST /api/mandados
- **Chips de límites:** Tope USD 120, Plazo (deadline), atributos (ej. ANC)
- **Columnas A/B/C:** chat bubbles en vivo con eventos SSE store_message. Rechazos (rejection:true) resaltan en rojo "Excede tu tope" (momento WOW). store_discarded muestra una badg con la razón traducida (deadline=Fuera de plazo, over_cap=Excede tope, no_stock=Sin stock, no_deal). Columna ganadora destacada cuando llega la propuesta.
- **Tarjeta de propuesta:** nombre tienda, precio final, envío (Gratis si 0), total, precio de lista, ahorro, fecha entrega, hilo resumible.
- **Panel de pago:** botón "Autorizar con PayPal" → POST /authorize; muestra approveUrl (abre en nueva pestaña) + "Ya aprobé en PayPal" → POST /approved. Estado pill AUTHORIZADO (dinero retenido, no cobrado). Botones "Capturar" (POST /capture) y "Anular" (POST /void). Estados finales COMPLETED/CAPTURED (mostra ID de captura si está presente) o VOIDED. Línea de tiempo: CREATED → AUTHORIZED → COMPLETED / VOIDED. También actualiza desde payment_update SSE eventos. Errores de API en alerta visible.
- **Botón "Nuevo mandado":** reset.
- **Responsive:** 3 columnas en escritorio, apiladas en <=640px (se ve bien a 390px). Acento azul estilo PayPal.

## License

[MIT](./LICENSE) © 2026 Andrés Sierra
