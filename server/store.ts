import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionPayload, ActionType, Analysis, Invoice, InvoiceStatus, PaymentPromise } from "./domain.ts";

export interface Reply {
  id: string;
  invoiceId: string;
  body: string;
  analysis: Analysis;
  source: "claude" | "rules" | "customer";
  notice: string | null;
  createdAt: string;
}

export type ActionStatus = "PENDING" | "EXECUTING" | "DONE" | "REJECTED" | "FAILED";

export interface Action {
  id: string;
  invoiceId: string;
  replyId: string | null;
  type: ActionType;
  title: string;
  rationale: string;
  payload: ActionPayload;
  warnings: string[];
  status: ActionStatus;
  error: string | null;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  invoiceId: string;
  text: string;
  day: string | null;
  createdAt: string;
}

export interface Settings {
  targetDate: string;
  obligation: number;
  obligationLabel: string;
  businessName: string;
  cashOnHand: number;
  clockOffsetDays: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, paypal_id TEXT NOT NULL UNIQUE, number TEXT NOT NULL, customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, paid INTEGER NOT NULL,
  due_date TEXT NOT NULL, status TEXT NOT NULL, pay_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), body TEXT NOT NULL,
  analysis TEXT NOT NULL, source TEXT NOT NULL, notice TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promises (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), reply_id TEXT, amount INTEGER NOT NULL,
  due_date TEXT NOT NULL, paid_at_creation INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), reply_id TEXT, type TEXT NOT NULL,
  title TEXT NOT NULL, rationale TEXT NOT NULL, payload TEXT NOT NULL, warnings TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS promise_links (
  token TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_history (
  email TEXT PRIMARY KEY, kept INTEGER NOT NULL, broken INTEGER NOT NULL
);
`;

type Row = Record<string, any>;
const now = () => new Date().toISOString();

const toInvoice = (r: Row): Invoice => ({
  id: r.id,
  paypalId: r.paypal_id,
  number: r.number,
  customerName: r.customer_name,
  customerEmail: r.customer_email,
  description: r.description,
  amount: r.amount,
  paid: r.paid,
  dueDate: r.due_date,
  status: r.status,
  payUrl: r.pay_url,
  createdAt: r.created_at,
});
const toPromise = (r: Row): PaymentPromise => ({
  id: r.id,
  invoiceId: r.invoice_id,
  replyId: r.reply_id,
  amount: r.amount,
  dueDate: r.due_date,
  paidAtCreation: r.paid_at_creation,
  status: r.status,
  createdAt: r.created_at,
});
const toReply = (r: Row): Reply => ({
  id: r.id,
  invoiceId: r.invoice_id,
  body: r.body,
  analysis: JSON.parse(r.analysis),
  source: r.source,
  notice: r.notice,
  createdAt: r.created_at,
});
const toAction = (r: Row): Action => ({
  id: r.id,
  invoiceId: r.invoice_id,
  replyId: r.reply_id,
  type: r.type,
  title: r.title,
  rationale: r.rationale,
  payload: JSON.parse(r.payload),
  warnings: JSON.parse(r.warnings),
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

export class Store {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Row[];
    if (!columns.some((c) => c.name === "day")) this.db.exec("ALTER TABLE events ADD COLUMN day TEXT;");
  }

  reset() {
    this.db.exec("DELETE FROM promise_links; DELETE FROM customer_history; DELETE FROM events; DELETE FROM actions; DELETE FROM promises; DELETE FROM replies; DELETE FROM invoices; DELETE FROM settings;");
  }

  settings(defaults: Settings): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE id = 1").get() as Row | undefined;
    return row ? { ...defaults, ...JSON.parse(row.value) } : defaults;
  }

  saveSettings(settings: Settings) {
    this.db
      .prepare("INSERT INTO settings (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
  }

  addInvoice(input: Omit<Invoice, "id" | "createdAt">): Invoice {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.paypalId, input.number, input.customerName, input.customerEmail, input.description, input.amount, input.paid, input.dueDate, input.status, input.payUrl, now());
    return this.invoice(id)!;
  }

  invoice(id: string): Invoice | null {
    const row = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as Row | undefined;
    return row ? toInvoice(row) : null;
  }

  invoiceByPaypalId(paypalId: string): Invoice | null {
    const row = this.db.prepare("SELECT * FROM invoices WHERE paypal_id = ?").get(paypalId) as Row | undefined;
    return row ? toInvoice(row) : null;
  }

  invoices(): Invoice[] {
    return (this.db.prepare("SELECT * FROM invoices ORDER BY due_date, number").all() as Row[]).map(toInvoice);
  }

  nextInvoiceNumber(): string {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM invoices").get() as Row;
    return `PP-${Date.now().toString(36).toUpperCase()}-${Number(row.n) + 1}`;
  }

  updateInvoice(id: string, fields: { amount: number; paid: number; status: InvoiceStatus; payUrl: string | null }) {
    this.db
      .prepare("UPDATE invoices SET amount = ?, paid = ?, status = ?, pay_url = ? WHERE id = ?")
      .run(fields.amount, fields.paid, fields.status, fields.payUrl, id);
  }

  addReply(reply: Omit<Reply, "id" | "createdAt">): Reply {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO replies VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, reply.invoiceId, reply.body, JSON.stringify(reply.analysis), reply.source, reply.notice, now());
    return this.replies(reply.invoiceId).find((r) => r.id === id)!;
  }

  replies(invoiceId: string): Reply[] {
    return (this.db.prepare("SELECT * FROM replies WHERE invoice_id = ? ORDER BY created_at, rowid").all(invoiceId) as Row[]).map(toReply);
  }

  addPromise(input: Omit<PaymentPromise, "id" | "createdAt" | "status">): PaymentPromise {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO promises VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)")
      .run(id, input.invoiceId, input.replyId, input.amount, input.dueDate, input.paidAtCreation, now());
    return this.promises(input.invoiceId).find((p) => p.id === id)!;
  }

  promises(invoiceId: string): PaymentPromise[] {
    return (this.db.prepare("SELECT * FROM promises WHERE invoice_id = ? ORDER BY created_at, rowid").all(invoiceId) as Row[]).map(toPromise);
  }

  setPromiseStatus(id: string, status: PaymentPromise["status"]) {
    this.db.prepare("UPDATE promises SET status = ? WHERE id = ?").run(status, id);
  }

  addAction(input: Pick<Action, "invoiceId" | "replyId" | "type" | "title" | "rationale" | "payload" | "warnings">): Action {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?)")
      .run(id, input.invoiceId, input.replyId, input.type, input.title, input.rationale, JSON.stringify(input.payload), JSON.stringify(input.warnings), now());
    return this.action(id)!;
  }

  action(id: string): Action | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
    return row ? toAction(row) : null;
  }

  actions(invoiceId: string): Action[] {
    return (this.db.prepare("SELECT * FROM actions WHERE invoice_id = ? ORDER BY created_at, rowid").all(invoiceId) as Row[]).map(toAction);
  }

  // Compare-and-set so a double click cannot run an approved action twice.
  claimAction(id: string, next: ActionStatus): boolean {
    return this.db.prepare("UPDATE actions SET status = ? WHERE id = ? AND status = 'PENDING'").run(next, id).changes === 1;
  }

  finishAction(id: string, status: ActionStatus, error: string | null = null) {
    this.db.prepare("UPDATE actions SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  addEvent(invoiceId: string, text: string, day: string | null = null) {
    this.db
      .prepare("INSERT INTO events (id, invoice_id, text, created_at, day) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), invoiceId, text, now(), day);
  }

  // One unguessable link per invoice, so a customer's bookmark keeps working.
  promiseLink(invoiceId: string): string {
    const row = this.db.prepare("SELECT token FROM promise_links WHERE invoice_id = ?").get(invoiceId) as Row | undefined;
    if (row) return row.token;
    const token = randomBytes(16).toString("base64url");
    this.db.prepare("INSERT INTO promise_links VALUES (?, ?, ?)").run(token, invoiceId, now());
    return token;
  }

  invoiceByLink(token: string): Invoice | null {
    const row = this.db.prepare("SELECT invoice_id FROM promise_links WHERE token = ?").get(token) as Row | undefined;
    return row ? this.invoice(row.invoice_id) : null;
  }

  setHistory(email: string, kept: number, broken: number) {
    this.db
      .prepare("INSERT INTO customer_history VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET kept = excluded.kept, broken = excluded.broken")
      .run(email.toLowerCase(), kept, broken);
  }

  history(email: string): { kept: number; broken: number } {
    const row = this.db.prepare("SELECT kept, broken FROM customer_history WHERE email = ?").get(email.toLowerCase()) as Row | undefined;
    return row ? { kept: row.kept, broken: row.broken } : { kept: 0, broken: 0 };
  }

  events(invoiceId: string): TimelineEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE invoice_id = ? ORDER BY created_at DESC, rowid DESC").all(invoiceId) as Row[]).map((r) => ({
      id: r.id,
      invoiceId: r.invoice_id,
      text: r.text,
      day: r.day,
      createdAt: r.created_at,
    }));
  }
}
