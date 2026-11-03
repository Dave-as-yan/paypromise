# PayPromise

An AI agent for small businesses waiting on unpaid PayPal invoices. Reminders stop at "please pay". PayPromise picks up at the customer's answer.

| The customer says | PayPromise proposes | PayPal is used to |
|---|---|---|
| "I'll pay Friday" | Track a promise for that date | Check whether the money arrived, then flag a broken promise |
| "It should be $1,650" | Correct the invoice | Update the invoice |
| "I can do half now" | Allow partial payment | Set partial payment and a minimum on the invoice |
| "We already paid" | Verify the payment | Read PayPal's record, not the customer's claim |

The dashboard then answers one question: **will there be enough cash on payroll day?** Only open promises from customers with a clean record count as expected money.

The AI proposes; the owner decides. Nothing changes in PayPal until the owner approves it. Customer replies are treated as untrusted, and amount and date limits are enforced in code rather than in the prompt (`server/domain.ts`).

## Run it

Requires Node 22.13 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. With no keys, the app runs as a demo with simulated PayPal, offline rules for reading replies, and sample invoices. The badges at the top show which mode is active.

## Connect PayPal sandbox and Claude

```bash
cp .env.example .env
```

Fill in `.env`, then restart. Sandbox mode starts with no invoices: use **New invoice** with a sandbox buyer's email. The app only ever calls PayPal's sandbox API.

| Feature | PayPal API |
|---|---|
| Create and send invoices | `POST /v2/invoicing/invoices`, `POST /v2/invoicing/invoices/{id}/send` |
| Reminders | `POST /v2/invoicing/invoices/{id}/remind` |
| Corrections and partial payment | `PUT /v2/invoicing/invoices/{id}` |
| Payment status | `GET /v2/invoicing/invoices/{id}`, **Sync with PayPal** button |
| Live payment events (optional) | Webhook at `/api/webhooks/paypal`, signature verified |

## Tools used

- **Claude Opus 5.5** (Anthropic API) reads each reply into structured data: intent, date, amount, reason, confidence and a draft response.
- **PayPal Invoicing REST API and webhooks** in the sandbox.
- **AG Grid** for the invoice dashboard.
- React, Vite, Express and SQLite (`node:sqlite`).

## Project layout

```
server/domain.ts    Business rules: proposals, promise settling, cash forecast
server/ai.ts        Claude analyzer and offline fallback rules
server/paypal.ts    PayPal sandbox client and demo simulator
server/service.ts   Workflow: replies, approvals, sync
server/index.ts     HTTP API
src/App.tsx         Dashboard
tests/              Run with npm test
```

## Deploy

```bash
npm run build
npm start
```

Serves the API and dashboard on `PORT`. `render.yaml` defines a Render deployment. There is no login, so host demo data only.

Two optional settings support a hosted demo:

| Setting | Effect |
|---|---|
| `SEED_DEMO=true` | Creates sample sandbox invoices when the database is empty |
| `DEMO_TOOLS=true` | Shows a **Next day** button, so a broken promise can be demonstrated. It changes only the app's date, not PayPal |

## Testing a payment

1. In the PayPal developer dashboard, create a US sandbox **Business** account and a sandbox app linked to it, with **Invoicing** enabled. Use that app's credentials. A checkout failed with an Armenia-registered sandbox merchant in our testing and worked with a US one.
2. Create or select an invoice and choose **Open PayPal invoice**.
3. Pay with a sandbox **Personal** account.
4. Choose **Sync with PayPal**, or configure the webhook, to update the dashboard.

## License

MIT
