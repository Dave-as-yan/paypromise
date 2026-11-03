import { type Analyzer, analyzeWithRules } from "./ai.ts";
import {
  actionImpact,
  addDays,
  type Analysis,
  balanceOf,
  forecast,
  type Invoice,
  niceDate,
  planItems,
  promiseRecord,
  proposeAction,
  type RiskInput,
  riskTag,
  settlePromise,
  usd,
} from "./domain.ts";
import type { PaypalGateway } from "./paypal.ts";
import type { Action, Settings, Store } from "./store.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface NewInvoiceInput {
  customerName: string;
  customerEmail: string;
  description: string;
  amount: number;
  dueDate: string;
}

export interface CustomerResponse {
  choice: "DATE" | "PARTIAL" | "DISPUTE" | "PAID";
  date?: string;
  amount?: number;
  correctedAmount?: number;
  note?: string;
}

const realToday = () => new Date().toISOString().slice(0, 10);
const LATEST_PROMISE_DAYS = 60;

const publicBase = () => process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:5173";

const riskIsBroken = (invoice: Invoice, store: Store) => store.promises(invoice.id).some((p) => p.status === "BROKEN");

export class Service {
  constructor(
    readonly store: Store,
    readonly paypal: PaypalGateway,
    readonly analyzer: Analyzer,
    private clock: () => string = realToday,
  ) {}

  private defaults(): Settings {
    return {
      targetDate: addDays(this.clock(), 7),
      obligation: 0,
      obligationLabel: "Payroll",
      businessName: "Your business",
      cashOnHand: 0,
      clockOffsetDays: 0,
    };
  }

  settings(): Settings {
    return this.store.settings(this.defaults());
  }

  today(): string {
    return addDays(this.clock(), this.settings().clockOffsetDays);
  }

  private riskInput(invoice: Invoice): RiskInput {
    const replies = this.store.replies(invoice.id);
    const last = replies.at(-1);
    const corrected = this.store.actions(invoice.id).some((a) => a.type === "CORRECT_INVOICE" && a.status === "DONE" && a.replyId === last?.id);
    return {
      invoice,
      promises: this.store.promises(invoice.id),
      disputed: last?.analysis.intent === "AMOUNT_DISPUTE" && !corrected,
    };
  }

  state() {
    const today = this.today();
    const settings = this.settings();
    const inputs = this.store.invoices().map((invoice) => this.riskInput(invoice));
    return {
      today,
      modes: { paypal: this.paypal.mode, ai: this.analyzer.name, demoClock: this.clockAllowed() },
      settings,
      forecast: forecast(inputs, settings, today),
      plan: planItems(inputs, settings, today).map((item) => ({ ...item, record: this.customerRecord(item.customerEmail) })),
      decisions: this.decisions(inputs),
      customers: this.customerSummaries(),
      invoices: inputs.map((input) => {
        const openPromise = input.promises.find((p) => p.status === "OPEN") ?? null;
        const replies = this.store.replies(input.invoice.id);
        const pending = this.store.actions(input.invoice.id).filter((a) => a.status === "PENDING");
        return {
          ...input.invoice,
          balance: balanceOf(input.invoice),
          risk: riskTag(input, today),
          promiseDate: openPromise?.dueDate ?? null,
          lastIntent: replies.at(-1)?.analysis.intent ?? null,
          lastReply: replies.at(-1) ?? null,
          pending: pending.length,
          pendingActionId: pending[0]?.id ?? null,
          record: this.customerRecord(input.invoice.customerEmail),
          promiseLink: this.linkFor(input.invoice.id),
        };
      }),
    };
  }

  private customerRecord(email: string) {
    const invoices = this.store.invoices().filter((i) => i.customerEmail.toLowerCase() === email.toLowerCase());
    return promiseRecord(invoices.flatMap((i) => this.store.promises(i.id)), this.store.history(email));
  }

  // Pending proposals, biggest payroll improvement first, each with what approving would change.
  private decisions(inputs: RiskInput[]) {
    const settings = this.settings();
    const today = this.today();
    return inputs
      .flatMap(({ invoice }) => {
        const replies = this.store.replies(invoice.id);
        return this.store
          .actions(invoice.id)
          .filter((a) => a.status === "PENDING")
          .map((action) => ({
            action,
            invoice: { ...invoice, balance: balanceOf(invoice) },
            reply: replies.find((r) => r.id === action.replyId) ?? null,
            record: this.customerRecord(invoice.customerEmail),
            impact: actionImpact(inputs, settings, today, action),
          }));
      })
      .sort(
        (a, b) =>
          a.impact.shortfallAfter - a.impact.shortfallBefore - (b.impact.shortfallAfter - b.impact.shortfallBefore) ||
          Number(riskIsBroken(b.invoice, this.store)) - Number(riskIsBroken(a.invoice, this.store)) ||
          a.action.createdAt.localeCompare(b.action.createdAt),
      );
  }

  private customerSummaries() {
    const groups = new Map<string, Invoice[]>();
    for (const invoice of this.store.invoices()) {
      const key = invoice.customerEmail.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), invoice]);
    }
    return [...groups.entries()]
      .map(([email, invoices]) => ({
        email,
        name: invoices[0].customerName,
        open: invoices.reduce((sum, i) => sum + balanceOf(i), 0),
        paid: invoices.reduce((sum, i) => sum + i.paid, 0),
        record: this.customerRecord(email),
        needsAttention: invoices.some((i) => this.store.promises(i.id).some((p) => p.status === "BROKEN") && balanceOf(i) > 0),
      }))
      .sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || b.open - a.open);
  }

  customerDetail(email: string) {
    const invoices = this.store.invoices().filter((i) => i.customerEmail.toLowerCase() === email.toLowerCase());
    if (invoices.length === 0) throw new HttpError(404, "Customer not found.");
    const today = this.today();
    return {
      email: email.toLowerCase(),
      name: invoices[0].customerName,
      record: this.customerRecord(email),
      paid: invoices.reduce((sum, i) => sum + i.paid, 0),
      open: invoices.reduce((sum, i) => sum + balanceOf(i), 0),
      invoices: invoices.map((invoice) => {
        const input = this.riskInput(invoice);
        return {
          ...invoice,
          balance: balanceOf(invoice),
          risk: riskTag(input, today),
          promises: input.promises,
          replies: this.store.replies(invoice.id),
          pending: this.store.actions(invoice.id).filter((a) => a.status === "PENDING"),
          events: this.store.events(invoice.id),
          promiseLink: this.linkFor(invoice.id),
        };
      }),
    };
  }

  private linkFor(invoiceId: string) {
    return `${publicBase()}/p/${this.store.promiseLink(invoiceId)}`;
  }

  private event(invoiceId: string, text: string) {
    this.store.addEvent(invoiceId, text, this.today());
  }

  // Only what a customer needs to decide. Never another customer's data or the owner's numbers.
  publicInvoice(token: string) {
    const invoice = this.store.invoiceByLink(token);
    if (!invoice) throw new HttpError(404, "This link isn't valid.");
    const today = this.today();
    return {
      businessName: this.settings().businessName,
      number: invoice.number,
      description: invoice.description,
      customerName: invoice.customerName,
      amount: invoice.amount,
      balance: balanceOf(invoice),
      dueDate: invoice.dueDate,
      payUrl: invoice.payUrl,
      status: invoice.status,
      today,
      latestDate: addDays(today, LATEST_PROMISE_DAYS),
    };
  }

  // A form answer is still only a proposal. The note is shown to the owner and never sent to the AI.
  respondFromLink(token: string, response: CustomerResponse) {
    const invoice = this.store.invoiceByLink(token);
    if (!invoice) throw new HttpError(404, "This link isn't valid.");
    if (balanceOf(invoice) === 0) throw new HttpError(409, "This invoice has nothing left to pay.");
    const today = this.today();
    if (response.date && (response.date < today || response.date > addDays(today, LATEST_PROMISE_DAYS))) {
      throw new HttpError(400, "Choose a date in the next 60 days.");
    }

    const answers: Record<CustomerResponse["choice"], Pick<Analysis, "intent" | "reason" | "draftReply"> & { body: string }> = {
      DATE: {
        intent: "PROMISE_TO_PAY",
        body: `Chose to pay on ${response.date ? niceDate(response.date) : "a date"}.`,
        reason: "The customer picked this date on their promise link.",
        draftReply: "Thank you. I've noted your payment date.",
      },
      PARTIAL: {
        intent: "PARTIAL_PAYMENT_REQUEST",
        body: "Asked to pay part now.",
        reason: "The customer asked for partial payment on their promise link.",
        draftReply: "Thanks for letting me know. I've turned on partial payment for this invoice.",
      },
      DISPUTE: {
        intent: "AMOUNT_DISPUTE",
        body: "Said something looks wrong with the invoice.",
        reason: "The customer questioned this invoice on their promise link.",
        draftReply: "Thanks for flagging this. I'm checking it against my records.",
      },
      PAID: {
        intent: "ALREADY_PAID",
        body: "Said this invoice is already paid.",
        reason: "The customer said on their promise link that they already paid.",
        draftReply: "Thanks. I'm checking PayPal's record and will confirm.",
      },
    };
    const { body, ...answer } = answers[response.choice];
    const analysis: Analysis = {
      ...answer,
      promisedDate: response.date ?? null,
      promisedAmount: response.amount ?? null,
      correctedAmount: response.correctedAmount ?? null,
      evidence: null,
      confidence: 1,
    };

    for (const action of this.store.actions(invoice.id).filter((a) => a.status === "PENDING")) {
      if (this.store.replies(invoice.id).find((r) => r.id === action.replyId)?.source !== "customer") continue;
      if (this.store.claimAction(action.id, "REJECTED")) this.event(invoice.id, "An earlier answer from the customer's link was replaced.");
    }

    const reply = this.store.addReply({ invoiceId: invoice.id, body: response.note ? `${body} Note: ${response.note}` : body, analysis, source: "customer", notice: null });
    const action = this.store.addAction({ invoiceId: invoice.id, replyId: reply.id, ...proposeAction(analysis, invoice, today) });
    this.event(invoice.id, `Customer answered on their link: ${body}`);
    return { received: true, actionId: action.id };
  }

  // Asks an unresponsive customer for a date. The owner still approves before it goes out.
  askForDate(invoiceId: string) {
    const invoice = this.requireInvoice(invoiceId);
    if (balanceOf(invoice) === 0) throw new HttpError(409, "This invoice has nothing left to pay.");
    if (this.store.actions(invoiceId).some((a) => a.status === "PENDING" && a.type === "SEND_REMINDER")) {
      throw new HttpError(409, "A reminder is already waiting for your approval.");
    }
    return this.store.addAction({
      invoiceId,
      replyId: null,
      type: "SEND_REMINDER",
      title: "Ask for a payment date",
      rationale: "This sends a PayPal reminder with a link where the customer can choose a date.",
      payload: { note: `Hi ${invoice.customerName}, could you let me know when you can pay this invoice? You can choose a date here: ${this.linkFor(invoiceId)}` },
      warnings: [],
    });
  }

  detail(invoiceId: string) {
    const invoice = this.requireInvoice(invoiceId);
    return {
      invoice: { ...invoice, balance: balanceOf(invoice) },
      replies: this.store.replies(invoiceId),
      promises: this.store.promises(invoiceId),
      actions: this.store.actions(invoiceId),
      events: this.store.events(invoiceId),
    };
  }

  private requireInvoice(id: string): Invoice {
    const invoice = this.store.invoice(id);
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    return invoice;
  }

  async createInvoice(input: NewInvoiceInput): Promise<Invoice> {
    const number = this.store.nextInvoiceNumber();
    const created = await this.paypal.createAndSend({ ...input, number });
    const invoice = this.store.addInvoice({
      ...input,
      number,
      paypalId: created.paypalId,
      amount: created.amount || input.amount,
      paid: created.paid,
      status: created.status,
      payUrl: created.payUrl,
    });
    this.event(invoice.id, `Invoice ${number} for ${usd(invoice.amount)} sent through PayPal.`);
    return invoice;
  }

  // The AI only proposes. Nothing reaches PayPal until the owner approves the action.
  async addReply(invoiceId: string, body: string) {
    const invoice = this.requireInvoice(invoiceId);
    const today = this.today();
    const { analysis, source, notice } = await this.analyzer.analyze(body, invoice, today);
    const reply = this.store.addReply({ invoiceId, body, analysis, source, notice });
    const proposal = proposeAction(analysis, invoice, today);
    const action = this.store.addAction({ invoiceId, replyId: reply.id, ...proposal });
    this.event(invoiceId, `Customer replied. Read as ${analysis.intent.toLowerCase().replaceAll("_", " ")}.`);
    return { reply, action };
  }

  async decide(actionId: string, approve: boolean, note?: string): Promise<Action> {
    const action = this.store.action(actionId);
    if (!action) throw new HttpError(404, "Action not found.");
    if (!this.store.claimAction(actionId, approve ? "EXECUTING" : "REJECTED")) {
      throw new HttpError(409, "This action was already decided.");
    }
    if (!approve) {
      this.event(action.invoiceId, `You rejected: ${action.title}.`);
      return this.store.action(actionId)!;
    }
    try {
      await this.execute(note && action.type === "SEND_REMINDER" ? { ...action, payload: { ...action.payload, note } } : action);
      this.store.finishAction(actionId, "DONE");
      this.event(action.invoiceId, `You approved: ${action.title}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.store.finishAction(actionId, "FAILED", message);
      this.event(action.invoiceId, `Failed: ${action.title}.`);
    }
    return this.store.action(actionId)!;
  }

  private async execute(action: Action) {
    // A webhook can be late or missed, so ask PayPal before acting on an old proposal.
    if (action.type !== "REVIEW" && action.type !== "VERIFY_PAYMENT") {
      await this.syncInvoice(this.requireInvoice(action.invoiceId));
    }
    const invoice = this.requireInvoice(action.invoiceId);
    const { payload } = action;

    if (action.type !== "REVIEW" && action.type !== "VERIFY_PAYMENT" && balanceOf(invoice) === 0) {
      throw new Error(`PayPal shows invoice ${invoice.number} has nothing left to pay, so nothing was changed.`);
    }
    if (payload.dueDate && payload.dueDate < this.today()) {
      throw new Error(`The promised date, ${niceDate(payload.dueDate)}, has already passed. Ask the customer for a new one.`);
    }

    // The invoice may have changed since this was proposed, so check again before acting.
    if (action.type === "ALLOW_PARTIAL" && payload.minimumDue! > balanceOf(invoice)) {
      throw new Error(`The ${usd(payload.minimumDue!)} minimum is now above the open balance.`);
    }
    if (action.type === "CORRECT_INVOICE" && payload.newAmount! < invoice.paid) {
      throw new Error(`The new amount is below the ${usd(invoice.paid)} already paid.`);
    }

    switch (action.type) {
      case "TRACK_PROMISE":
        this.trackPromise(invoice, action);
        return;
      case "ALLOW_PARTIAL":
        await this.paypal.allowPartial(invoice.paypalId, payload.minimumDue!);
        if (payload.dueDate) this.trackPromise(invoice, action);
        return;
      case "CORRECT_INVOICE":
        await this.paypal.setAmount(invoice.paypalId, payload.newAmount!);
        this.store.updateInvoice(invoice.id, { ...invoice, amount: payload.newAmount! });
        await this.syncInvoice(this.requireInvoice(invoice.id));
        return;
      case "SEND_REMINDER":
        await this.paypal.remind(invoice.paypalId, payload.note ?? "Please review this invoice.");
        return;
      case "VERIFY_PAYMENT": {
        await this.syncInvoice(invoice);
        const updated = this.requireInvoice(invoice.id);
        if (updated.paid === invoice.paid) {
          this.event(invoice.id, `PayPal shows no new payment. Paid so far: ${usd(updated.paid)}.`);
        }
        return;
      }
      case "REVIEW":
        return;
    }
  }

  private trackPromise(invoice: Invoice, action: Action) {
    const { amount, dueDate } = action.payload;
    for (const open of this.store.promises(invoice.id).filter((p) => p.status === "OPEN")) {
      this.store.setPromiseStatus(open.id, "BROKEN");
      this.event(invoice.id, `Earlier promise for ${niceDate(open.dueDate)} replaced by a new one.`);
    }
    this.store.addPromise({
      invoiceId: invoice.id,
      replyId: action.replyId,
      amount: amount!,
      dueDate: dueDate!,
      paidAtCreation: invoice.paid,
    });
  }

  private async syncInvoice(invoice: Invoice) {
    const remote = await this.paypal.get(invoice.paypalId);
    if (remote) {
      this.store.updateInvoice(invoice.id, {
        amount: remote.amount || invoice.amount,
        paid: remote.paid,
        status: remote.status,
        payUrl: remote.payUrl ?? invoice.payUrl,
      });
      if (remote.paid > invoice.paid) {
        this.event(invoice.id, `PayPal confirmed a payment of ${usd(remote.paid - invoice.paid)}. Paid so far: ${usd(remote.paid)}.`);
        this.addCash(remote.paid - invoice.paid);
      }
    }
  }

  async syncAll() {
    for (const invoice of this.store.invoices()) {
      if (invoice.status === "PAID" || invoice.status === "CANCELLED") continue;
      await this.syncInvoice(invoice);
    }
    this.settlePromises();
  }

  async syncByPaypalId(paypalId: string) {
    const invoice = this.store.invoiceByPaypalId(paypalId);
    if (!invoice) return;
    await this.syncInvoice(invoice);
    this.settlePromises();
  }

  // Runs on every refresh. A broken promise queues one reminder for the owner to approve.
  settlePromises() {
    const today = this.today();
    for (const invoice of this.store.invoices()) {
      this.closeStaleActions(invoice, today);
      for (const promise of this.store.promises(invoice.id)) {
        const status = settlePromise(promise, invoice, today);
        if (status === promise.status) continue;
        this.store.setPromiseStatus(promise.id, status);
        if (status === "KEPT") {
          this.event(invoice.id, `Promise kept: ${usd(promise.amount)} arrived by ${niceDate(promise.dueDate)}.`);
        } else {
          this.event(invoice.id, `Promise broken: ${usd(promise.amount)} did not arrive by ${niceDate(promise.dueDate)}.`);
          this.store.addAction({
            invoiceId: invoice.id,
            replyId: null,
            type: "SEND_REMINDER",
            title: "Follow up on the broken promise",
            rationale: `${invoice.customerName} promised ${usd(promise.amount)} by ${niceDate(promise.dueDate)} and PayPal shows it has not arrived.`,
            payload: {
              note: `Hi ${invoice.customerName}, we expected ${usd(promise.amount)} by ${niceDate(promise.dueDate)} and have not received it. You can choose a new date here: ${this.linkFor(invoice.id)}`,
            },
            warnings: [],
          });
        }
      }
    }
  }

  // A proposal stops making sense once the invoice is settled or its date has gone by.
  private closeStaleActions(invoice: Invoice, today: string) {
    for (const action of this.store.actions(invoice.id).filter((a) => a.status === "PENDING")) {
      const settled = balanceOf(invoice) === 0;
      const expired = !!action.payload.dueDate && action.payload.dueDate < today;
      if ((settled || expired) && this.store.claimAction(action.id, "REJECTED")) {
        this.event(invoice.id, `Closed without action, because ${settled ? "the invoice has nothing left to pay" : "the date has passed"}: ${action.title}.`);
      }
    }
  }

  // Money that arrives moves from "owed" to cash, so the forecast must count it.
  private addCash(amount: number) {
    const settings = this.settings();
    this.store.saveSettings({ ...settings, cashOnHand: settings.cashOnHand + amount });
  }

  updateSettings(changes: Partial<Pick<Settings, "targetDate" | "obligation" | "obligationLabel" | "businessName" | "cashOnHand">>) {
    this.store.saveSettings({ ...this.settings(), ...changes });
  }

  private requireSimulated() {
    if (this.paypal.mode !== "simulated") throw new HttpError(400, "Demo controls only work in simulated mode.");
  }

  simulatePayment(invoiceId: string, amount: number) {
    this.requireSimulated();
    const invoice = this.requireInvoice(invoiceId);
    const paid = Math.min(invoice.amount, invoice.paid + amount);
    this.store.updateInvoice(invoice.id, { ...invoice, paid, status: paid >= invoice.amount ? "PAID" : "PARTIALLY_PAID" });
    this.event(invoice.id, `Simulated PayPal payment of ${usd(paid - invoice.paid)} received.`);
    this.addCash(paid - invoice.paid);
    this.settlePromises();
  }

  // Moving the app's own date never touches PayPal, so a hosted sandbox demo can use it too.
  private clockAllowed() {
    return this.paypal.mode === "simulated" || process.env.DEMO_TOOLS === "true";
  }

  advanceClock(days: number) {
    if (!this.clockAllowed()) throw new HttpError(400, "The demo clock is turned off.");
    const settings = this.settings();
    this.store.saveSettings({ ...settings, clockOffsetDays: settings.clockOffsetDays + days });
    this.settlePromises();
  }

  async resetDemo() {
    if (!this.clockAllowed()) throw new HttpError(400, "Demo controls are turned off.");
    this.store.reset();
    await this.seedDemo();
  }

  async seedDemo() {
    const today = this.clock();
    this.store.saveSettings({
      ...this.defaults(),
      targetDate: addDays(today, 7),
      obligation: 620000,
      obligationLabel: "Payroll",
      businessName: "Brightline Electric",
      cashOnHand: 150000,
    });
    const samples: NewInvoiceInput[] = [
      { customerName: "Harbor Street Cafe", customerEmail: "harbor.cafe@example.com", description: "Kitchen rewiring", amount: 240000, dueDate: addDays(today, -12) },
      { customerName: "Maple Dental", customerEmail: "maple.dental@example.com", description: "Lighting upgrade", amount: 185000, dueDate: addDays(today, -6) },
      { customerName: "Northside Gym", customerEmail: "northside.gym@example.com", description: "Panel replacement", amount: 320000, dueDate: addDays(today, -3) },
      { customerName: "Lena Brooks", customerEmail: "lena.brooks@example.com", description: "Home EV charger install", amount: 96000, dueDate: addDays(today, 2) },
      { customerName: "Oak & Iron Studio", customerEmail: "oak.iron@example.com", description: "Workshop circuits", amount: 150000, dueDate: addDays(today, 14) },
    ];
    const invoices = [];
    for (const sample of samples) invoices.push(await this.createInvoice(sample));

    // Sample history and replies, so a first-time visitor sees the product working. These use
    // the offline rules, so a server restart never spends an AI call.
    const history: [number, number][] = [[3, 0], [0, 1], [1, 0], [0, 0], [4, 0]];
    invoices.forEach((invoice, i) => this.store.setHistory(invoice.customerEmail, ...history[i]));
    const replies = [
      "Sorry for the delay, cash is tight this month. I will pay the full amount on Friday.",
      "This looks wrong. We agreed on $1,650 for the job, so the invoice should be $1,650.",
      "I can't pay it all at once. I can do half now and the rest later if that works.",
    ];
    for (const [i, body] of replies.entries()) {
      const analysis = analyzeWithRules(body, today);
      const reply = this.store.addReply({ invoiceId: invoices[i].id, body, analysis, source: "rules", notice: null });
      this.store.addAction({ invoiceId: invoices[i].id, replyId: reply.id, ...proposeAction(analysis, invoices[i], today) });
      this.event(invoices[i].id, "Customer replied. Sample reply, read by the offline rules.");
    }
  }
}
