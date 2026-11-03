import "dotenv/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createAnalyzer } from "./ai.ts";
import { isValidDate, toCents } from "./domain.ts";
import { createPaypal, SandboxPaypal } from "./paypal.ts";
import { HttpError, type Service } from "./service.ts";
import { type Workspace, Workspaces } from "./workspaces.ts";

const paypal = createPaypal();
// DEMO_TOOLS marks a public demo, where one visitor must never see another visitor's changes.
const workspaces = new Workspaces({
  isolated: process.env.DEMO_TOOLS === "true",
  paypal,
  analyzer: createAnalyzer(),
  databasePath: process.env.DATABASE_PATH ?? `data/paypromise-${paypal.mode}.db`,
  seedShared: process.env.SEED_DEMO === "true",
});
await workspaces.start();

const COOKIE = "pp_demo";
const readCookie = (req: Request) =>
  req.headers.cookie?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
const setCookie = (req: Request, res: Response, id: string) =>
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${req.secure ? "; Secure" : ""}`);

const app = express();
app.set("trust proxy", 1);
const date = z.string().refine((value) => isValidDate(value), "Use a valid YYYY-MM-DD date.");
const dollars = z.number().positive().max(1_000_000);

// Replies cost an AI call and invoices call PayPal, so a public demo needs ceilings.
const hits = new Map<string, number[]>();
function allow(key: string, limit: number, windowMs: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => t > Date.now() - windowMs);
  if (recent.length >= limit) return false;
  hits.set(key, [...recent, Date.now()]);
  return true;
}
function limitWrites(req: Request, _res: Response, next: NextFunction) {
  const perVisitor = allow(`ip:${req.ip ?? "unknown"}`, 15, 60_000);
  if (!perVisitor || !allow("all", 300, 3_600_000)) throw new HttpError(429, "Too many requests. Try again in a minute.");
  next();
}

// Registered before the JSON parser: PayPal verifies the event against the exact payload.
app.post("/api/webhooks/paypal", express.raw({ type: "application/json", limit: "200kb" }), async (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!(paypal instanceof SandboxPaypal) || !webhookId) throw new HttpError(503, "Webhook is not configured.");
  const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
  if (required.some((name) => !req.headers[name])) throw new HttpError(401, "Bad webhook signature.");
  const event = JSON.parse(req.body.toString("utf8"));
  if (!(await paypal.verifyWebhook(req.headers, event, webhookId))) throw new HttpError(401, "Bad webhook signature.");
  const paypalId = event.resource?.invoice?.id ?? event.resource?.id;
  if (typeof event.event_type === "string" && event.event_type.startsWith("INVOICING.INVOICE.") && paypalId) {
    const workspace = workspaces.findByPaypalId(paypalId);
    if (workspace) {
      await workspace.service.syncByPaypalId(paypalId);
      workspaces.announce(workspace);
    }
  }
  res.sendStatus(200);
});

app.use(express.json({ limit: "50kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function byLink(token: string): Workspace {
  const workspace = workspaces.findByLink(token);
  if (!workspace) throw new HttpError(404, "This link isn't valid.");
  return workspace;
}

app.get("/api/public/promises/:token", (req, res) => {
  if (!allow(`link:${req.ip ?? "unknown"}`, 60, 60_000)) throw new HttpError(429, "Too many requests. Try again in a minute.");
  const token = String(req.params.token);
  res.json(byLink(token).service.publicInvoice(token));
});

app.post("/api/public/promises/:token", limitWrites, (req, res) => {
  const token = String(req.params.token);
  if (!allow(`answer:${token}`, 10, 3_600_000)) throw new HttpError(429, "Too many answers for this invoice. Try again later.");
  const input = z
    .object({
      choice: z.enum(["DATE", "PARTIAL", "DISPUTE", "PAID"]),
      date: date.optional(),
      amount: dollars.optional(),
      correctedAmount: dollars.optional(),
      note: z.string().trim().max(500).optional(),
    })
    .refine((v) => v.choice !== "DATE" || v.date, "Choose a date.")
    .parse(req.body);
  const workspace = byLink(token);
  res.status(201).json(workspace.service.respondFromLink(token, input));
  workspaces.announce(workspace);
});

// Everything below belongs to the visitor's own workspace.
app.use("/api", async (req, res, next) => {
  const { workspace, created } = await workspaces.resolve(readCookie(req));
  if (created) setCookie(req, res, workspace.id);
  res.locals.workspace = workspace;
  if (req.method !== "GET") res.on("finish", () => workspaces.announce(workspace));
  next();
});
const serviceOf = (res: Response): Service => (res.locals.workspace as Workspace).service;

app.get("/api/events", (req, res) => {
  const workspace = res.locals.workspace as Workspace;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  const listener = () => res.write("event: changed\ndata: {}\n\n");
  workspace.listeners.add(listener);
  // Proxies close silent connections, so send a comment line every 15 seconds.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    workspace.listeners.delete(listener);
  });
});

app.get("/api/customers/:email", (req, res) => {
  res.json(serviceOf(res).customerDetail(String(req.params.email)));
});

app.post("/api/invoices/:id/ask-for-date", limitWrites, (req, res) => {
  res.status(201).json(serviceOf(res).askForDate(String(req.params.id)));
});

app.get("/api/state", (_req, res) => {
  const workspace = res.locals.workspace as Workspace;
  workspace.service.settlePromises();
  res.json({
    ...workspace.service.state(),
    workspace: { isolated: workspaces.isolated, kind: workspace.kind, canUseSandbox: workspaces.canUseSandbox },
  });
});

app.get("/api/invoices/:id", (req, res) => {
  res.json(serviceOf(res).detail(String(req.params.id)));
});

app.post("/api/invoices", limitWrites, async (req, res) => {
  const input = z
    .object({
      customerName: z.string().trim().min(1).max(120),
      customerEmail: z.email().max(200),
      description: z.string().trim().min(1).max(200),
      amount: dollars,
      dueDate: date,
    })
    .parse(req.body);
  res.status(201).json(await serviceOf(res).createInvoice({ ...input, amount: toCents(input.amount) }));
});

app.post("/api/invoices/:id/replies", limitWrites, async (req, res) => {
  const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
  res.status(201).json(await serviceOf(res).addReply(String(req.params.id), body));
});

app.post("/api/actions/:id/:decision", async (req, res) => {
  const decision = z.enum(["approve", "reject"]).parse(req.params.decision);
  const { note } = z.object({ note: z.string().trim().min(1).max(1000).optional() }).parse(req.body ?? {});
  res.json(await serviceOf(res).decide(String(req.params.id), decision === "approve", note));
});

app.post("/api/sync", async (_req, res) => {
  await serviceOf(res).syncAll();
  res.json(serviceOf(res).state());
});

app.put("/api/settings", (req, res) => {
  const changes = z
    .object({
      targetDate: date.optional(),
      obligation: z.number().min(0).max(100_000_000).optional(),
      obligationLabel: z.string().trim().min(1).max(40).optional(),
      businessName: z.string().trim().min(1).max(80).optional(),
      cashOnHand: z.number().min(0).max(100_000_000).optional(),
    })
    .parse(req.body);
  serviceOf(res).updateSettings({
    ...changes,
    ...(changes.obligation != null ? { obligation: toCents(changes.obligation) } : {}),
    ...(changes.cashOnHand != null ? { cashOnHand: toCents(changes.cashOnHand) } : {}),
  });
  res.json(serviceOf(res).state());
});

app.post("/api/demo/pay", (req, res) => {
  const { invoiceId, amount } = z.object({ invoiceId: z.string(), amount: dollars }).parse(req.body);
  serviceOf(res).simulatePayment(invoiceId, toCents(amount));
  res.json(serviceOf(res).state());
});

app.post("/api/demo/advance", limitWrites, (req, res) => {
  const { days } = z.object({ days: z.number().int().min(1).max(30) }).parse(req.body);
  serviceOf(res).advanceClock(days);
  res.json(serviceOf(res).state());
});

// Real sandbox invoices are slow and count against PayPal's limits, so these are rationed.
function limitSandbox(req: Request) {
  const perVisitor = allow(`sandbox:${req.ip ?? "unknown"}`, 5, 3_600_000);
  if (!perVisitor || !allow("sandbox:all", 30, 3_600_000)) {
    throw new HttpError(429, "Too many PayPal sandbox demos were started. Try again later.");
  }
}

app.post("/api/demo/reset", limitWrites, async (req, res) => {
  const service = serviceOf(res);
  if ((res.locals.workspace as Workspace).kind === "sandbox") limitSandbox(req);
  await service.resetDemo();
  res.json(service.state());
});

// Starts a fresh private demo. The visitor keeps their current one if PayPal fails.
app.post("/api/demo/workspace", limitWrites, async (req, res) => {
  const { kind } = z.object({ kind: z.enum(["simulated", "sandbox"]) }).parse(req.body);
  if (!workspaces.isolated) throw new HttpError(400, "This server doesn't use private demos.");
  if (kind === "sandbox") {
    if (!workspaces.canUseSandbox) throw new HttpError(400, "Real PayPal sandbox isn't configured here.");
    limitSandbox(req);
  }
  const workspace = await workspaces.create(kind);
  setCookie(req, res, workspace.id);
  res.status(201).json({ kind: workspace.kind });
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
  console.log(`PayPromise API on http://${host}:${port} (PayPal: ${paypal.mode}, private demos: ${workspaces.isolated})`);
});
