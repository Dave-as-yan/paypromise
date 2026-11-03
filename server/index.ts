import "dotenv/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createAnalyzer } from "./ai.ts";
import { isValidDate, toCents } from "./domain.ts";
import { createPaypal, SandboxPaypal } from "./paypal.ts";
import { HttpError, Service } from "./service.ts";
import { Store } from "./store.ts";

const paypal = createPaypal();
// Demo invoices have no PayPal record, so they must not mix with sandbox ones.
const store = new Store(process.env.DATABASE_PATH ?? `data/paypromise-${paypal.mode}.db`);
const service = new Service(store, paypal, createAnalyzer());

if (service.paypal.mode === "simulated" && store.invoices().length === 0) await service.seedDemo();

const app = express();
const date = z.string().refine((value) => isValidDate(value), "Use a valid YYYY-MM-DD date.");
const dollars = z.number().positive().max(1_000_000);

// Each reply costs an AI call, so a public demo needs a ceiling.
const replyHits = new Map<string, number[]>();
function limitReplies(req: Request, _res: Response, next: NextFunction) {
  const key = req.ip ?? "unknown";
  const recent = (replyHits.get(key) ?? []).filter((t) => t > Date.now() - 60_000);
  if (recent.length >= 15) throw new HttpError(429, "Too many replies. Try again in a minute.");
  replyHits.set(key, [...recent, Date.now()]);
  next();
}

// Registered before the JSON parser: PayPal verifies the event against the exact payload.
app.post("/api/webhooks/paypal", express.raw({ type: "application/json", limit: "200kb" }), async (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!(service.paypal instanceof SandboxPaypal) || !webhookId) throw new HttpError(503, "Webhook is not configured.");
  const event = JSON.parse(req.body.toString("utf8"));
  if (!(await service.paypal.verifyWebhook(req.headers, event, webhookId))) throw new HttpError(401, "Bad webhook signature.");
  const paypalId = event.resource?.invoice?.id ?? event.resource?.id;
  if (typeof event.event_type === "string" && event.event_type.startsWith("INVOICING.INVOICE.") && paypalId) {
    await service.syncByPaypalId(paypalId);
  }
  res.sendStatus(200);
});

app.use(express.json({ limit: "50kb" }));

app.get("/api/state", (_req, res) => {
  service.settlePromises();
  res.json(service.state());
});

app.get("/api/invoices/:id", (req, res) => {
  res.json(service.detail(String(req.params.id)));
});

app.post("/api/invoices", async (req, res) => {
  const input = z
    .object({
      customerName: z.string().trim().min(1).max(120),
      customerEmail: z.email().max(200),
      description: z.string().trim().min(1).max(200),
      amount: dollars,
      dueDate: date,
    })
    .parse(req.body);
  res.status(201).json(await service.createInvoice({ ...input, amount: toCents(input.amount) }));
});

app.post("/api/invoices/:id/replies", limitReplies, async (req, res) => {
  const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
  res.status(201).json(await service.addReply(String(req.params.id), body));
});

app.post("/api/actions/:id/:decision", async (req, res) => {
  const decision = z.enum(["approve", "reject"]).parse(req.params.decision);
  res.json(await service.decide(String(req.params.id), decision === "approve"));
});

app.post("/api/sync", async (_req, res) => {
  await service.syncAll();
  res.json(service.state());
});

app.put("/api/settings", (req, res) => {
  const changes = z
    .object({
      targetDate: date.optional(),
      obligation: z.number().min(0).max(100_000_000).optional(),
      obligationLabel: z.string().trim().min(1).max(40).optional(),
      cashOnHand: z.number().min(0).max(100_000_000).optional(),
    })
    .parse(req.body);
  service.updateSettings({
    ...changes,
    ...(changes.obligation != null ? { obligation: toCents(changes.obligation) } : {}),
    ...(changes.cashOnHand != null ? { cashOnHand: toCents(changes.cashOnHand) } : {}),
  });
  res.json(service.state());
});

app.post("/api/demo/pay", (req, res) => {
  const { invoiceId, amount } = z.object({ invoiceId: z.string(), amount: dollars }).parse(req.body);
  service.simulatePayment(invoiceId, toCents(amount));
  res.json(service.state());
});

app.post("/api/demo/advance", (req, res) => {
  const { days } = z.object({ days: z.number().int().min(1).max(30) }).parse(req.body);
  service.advanceClock(days);
  res.json(service.state());
});

app.post("/api/demo/reset", async (_req, res) => {
  await service.resetDemo();
  res.json(service.state());
});

const dist = join(process.cwd(), "dist");
if (process.env.NODE_ENV === "production" && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  } else if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
  } else {
    console.error(error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Something went wrong." });
  }
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
app.listen(port, host, () => {
  console.log(`PayPromise API on http://${host}:${port} (PayPal: ${service.paypal.mode}, AI: ${service.analyzer.name})`);
});
