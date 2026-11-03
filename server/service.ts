import type { Analyzer } from "./ai.ts";
import {
  addDays,
  balanceOf,
  forecast,
  type Invoice,
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

const realToday = () => new Date().toISOString().slice(0, 10);

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
      modes: { paypal: this.paypal.mode, ai: this.analyzer.name },
      settings,
      forecast: forecast(inputs, settings, today),
      invoices: inputs.map((input) => {
        const openPromise = input.promises.find((p) => p.status === "OPEN") ?? null;
        const replies = this.store.replies(input.invoice.id);
        return {
          ...input.invoice,
          balance: balanceOf(input.invoice),
          risk: riskTag(input, today),
          promiseDate: openPromise?.dueDate ?? null,
          lastIntent: replies.at(-1)?.analysis.intent ?? null,
          pending: this.store.actions(input.invoice.id).filter((a) => a.status === "PENDING").length,
        };
      }),
    };
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
    this.store.addEvent(invoice.id, `Invoice ${number} for ${usd(invoice.amount)} sent through PayPal.`);
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
    this.store.addEvent(invoiceId, `Customer replied. Read as ${analysis.intent.toLowerCase().replaceAll("_", " ")}.`);
    return { reply, action };
  }

  async decide(actionId: string, approve: boolean): Promise<Action> {
    const action = this.store.action(actionId);
    if (!action) throw new HttpError(404, "Action not found.");
    if (!this.store.claimAction(actionId, approve ? "EXECUTING" : "REJECTED")) {
      throw new HttpError(409, "This action was already decided.");
    }
    if (!approve) {
      this.store.addEvent(action.invoiceId, `Owner rejected: ${action.title}.`);
      return this.store.action(actionId)!;
    }
    try {
      await this.execute(action);
      this.store.finishAction(actionId, "DONE");
      this.store.addEvent(action.invoiceId, `Owner approved: ${action.title}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.store.finishAction(actionId, "FAILED", message);
      this.store.addEvent(action.invoiceId, `Failed: ${action.title}.`);
    }
    return this.store.action(actionId)!;
  }

  private async execute(action: Action) {
    const invoice = this.requireInvoice(action.invoiceId);
    const { payload } = action;

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
        this.store.addEvent(
          invoice.id,
          updated.paid > invoice.paid
            ? `PayPal confirms a new payment. Paid so far: ${usd(updated.paid)}.`
            : `PayPal shows no new payment. Paid so far: ${usd(updated.paid)}.`,
        );
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
      this.store.addEvent(invoice.id, `Earlier promise for ${open.dueDate} replaced by a new one.`);
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
      for (const promise of this.store.promises(invoice.id)) {
        const status = settlePromise(promise, invoice, today);
        if (status === promise.status) continue;
        this.store.setPromiseStatus(promise.id, status);
        if (status === "KEPT") {
          this.store.addEvent(invoice.id, `Promise kept: ${usd(promise.amount)} arrived by ${promise.dueDate}.`);
        } else {
          this.store.addEvent(invoice.id, `Promise broken: ${usd(promise.amount)} did not arrive by ${promise.dueDate}.`);
          this.store.addAction({
            invoiceId: invoice.id,
            replyId: null,
            type: "SEND_REMINDER",
            title: "Follow up on the broken promise",
            rationale: `${invoice.customerName} promised ${usd(promise.amount)} by ${promise.dueDate} and PayPal shows it has not arrived.`,
            payload: {
              note: `Hi ${invoice.customerName}, we expected ${usd(promise.amount)} by ${promise.dueDate} and have not received it. Could you confirm a new date?`,
            },
            warnings: [],
          });
        }
      }
    }
  }

  updateSettings(changes: Partial<Pick<Settings, "targetDate" | "obligation" | "obligationLabel" | "cashOnHand">>) {
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
    this.store.addEvent(invoice.id, `Simulated PayPal payment of ${usd(paid - invoice.paid)} received.`);
    this.settlePromises();
  }

  advanceClock(days: number) {
    this.requireSimulated();
    const settings = this.settings();
    this.store.saveSettings({ ...settings, clockOffsetDays: settings.clockOffsetDays + days });
    this.settlePromises();
  }

  async resetDemo() {
    this.requireSimulated();
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
      cashOnHand: 150000,
    });
    const samples: NewInvoiceInput[] = [
      { customerName: "Harbor Street Cafe", customerEmail: "owner@harborcafe.example", description: "Kitchen rewiring", amount: 240000, dueDate: addDays(today, -12) },
      { customerName: "Maple Dental", customerEmail: "office@mapledental.example", description: "Lighting upgrade", amount: 185000, dueDate: addDays(today, -6) },
      { customerName: "Northside Gym", customerEmail: "finance@northsidegym.example", description: "Panel replacement", amount: 320000, dueDate: addDays(today, -3) },
      { customerName: "Lena Brooks", customerEmail: "lena@brooks.example", description: "Home EV charger install", amount: 96000, dueDate: addDays(today, 2) },
      { customerName: "Oak & Iron Studio", customerEmail: "hello@oakiron.example", description: "Workshop circuits", amount: 150000, dueDate: addDays(today, 14) },
    ];
    for (const sample of samples) await this.createInvoice(sample);
  }
}
