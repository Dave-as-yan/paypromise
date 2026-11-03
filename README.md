# PayPromise

The promise ledger for people who invoice on PayPal without accounting software. Every "I'll pay Friday" becomes a promise that PayPal data proves kept or broken, and the dashboard answers one question: **will there be enough cash on payroll day?**

Larger accounts-receivable tools also detect payment promises from email. PayPromise brings that idea to PayPal invoicing, works without an accounting system, and lets customers answer on a simple link.

| The customer says | PayPromise proposes | PayPal is used to |
|---|---|---|
| "I'll pay Friday" | Track a promise for that date | Check whether the money arrived, then flag a broken promise |
| "It should be $1,650" | Correct the invoice | Update the invoice |
| "I can do half now" | Allow partial payment | Set partial payment and a minimum on the invoice |
| "We already paid" | Verify the payment | Read PayPal's record, not the customer's claim |

## What's inside

- **Today:** the payroll verdict, a forecast chart, a decision inbox and a live AG Grid console.
- **Review:** the customer's words, the AI's reading with its evidence, the exact PayPal change, its effect on payroll, and 10 seconds to undo.
- **Customer link:** with no sign-in, a customer can pay, pick a date, ask to pay in parts, question the invoice or say it's paid. Their answer is a proposal for the owner, and a date from the form needs no AI guess.
- **Cash plan:** a day-by-day view with customer switches for what-if questions. It never changes PayPal.
- **Customers:** promises kept, broken-promise alerts, follow-ups and the full history.

The AI proposes; the owner decides. Nothing changes in PayPal until the owner approves it. Customer text is treated as untrusted, the model has no PayPal tools, and amount and date limits are enforced in code rather than in the prompt (`server/domain.ts`).

## AI accuracy

`tests/eval` holds 54 hand-written, labelled replies, including Armenian and Spanish text and 5 prompt-injection attempts. Latest run with Claude Opus 5.5:

| Field | Correct |
|---|---|
| Meaning of the reply | 53 of 54 |
| Promised date | 20 of 20 |
| Promised amount | 3 of 4 |
| Corrected total | 10 of 10 |
| Injection attempts read correctly | 5 of 5 |

This is a small test set written for this project, not a measure of real customer mail. Each run uses API credit: `npx tsx tests/eval/run.ts`.

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
| Payment status | `GET /v2/invoicing/invoices/{id}`, **Check PayPal** button |
| Live payment events (optional) | Webhook at `/api/webhooks/paypal`, signature verified |

## Tools used

- **Claude Opus 5.5** (Anthropic API) reads each reply into structured data: intent, date, amount, reason, confidence and a draft response.
- **PayPal Invoicing REST API and webhooks** in the sandbox.
- **AG Grid Community** for the invoice console.
- React, Vite, Tailwind CSS, Radix, Recharts, Motion, Express and SQLite (`node:sqlite`).

## Project layout

```
server/domain.ts    Business rules: proposals, promise settling, cash forecast, action impact
server/plan.ts      Cash plan arithmetic, shared with the browser
server/ai.ts        Claude analyzer and offline fallback rules
server/paypal.ts    PayPal sandbox client and demo simulator
server/service.ts   Workflow: replies, approvals, sync
server/workspaces.ts  Private demos for each visitor
server/index.ts     HTTP API
src/App.tsx         Shell, live updates, undo, dialogs
src/pages/          Today, Review, Cash plan, Customers, customer link
tests/              Run with npm test; tests/eval scores the AI
```

## Deploy

```bash
npm run build
npm start
```

Serves the API and dashboard on `PORT`. `render.yaml` defines a Render deployment. There is no login, so host demo data only.

## Public demo

With `DEMO_TOOLS=true`, every visitor gets a private, temporary demo, so one person's clicks never change what another sees. Each one starts with sample data and simulated PayPal, and has **Next day** and **Reset demo** buttons. These demos live in memory and end when the server restarts.

If PayPal keys are set, **Use real PayPal sandbox** creates that visitor's own real sandbox invoices, so they can pay one and watch the webhook update their page. This is rate limited.

Without `DEMO_TOOLS`, the server keeps one shared, saved workspace.

| Setting | Effect |
|---|---|
| `DEMO_TOOLS=true` | Private demos for each visitor, as above |
| `SEED_DEMO=true` | Creates sample sandbox invoices when a shared workspace is empty |
| `PUBLIC_URL` | Base address for customer links. Render sets its own, so this is only needed elsewhere |
| `DATABASE_PATH` | Where a shared workspace's SQLite file lives |

## Testing a payment

1. In the PayPal developer dashboard, create a US sandbox **Business** account and a sandbox app linked to it, with **Invoicing** enabled. Use that app's credentials. A checkout failed with an Armenia-registered sandbox merchant in our testing and worked with a US one.
2. Create or select an invoice and choose **Open PayPal invoice**.
3. Pay with a sandbox **Personal** account.
4. Choose **Check PayPal**, or configure the webhook, to update the dashboard.

## License

MIT
