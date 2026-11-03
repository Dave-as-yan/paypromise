import { describe, expect, it } from "vitest";
import { analyzeWithRules, RulesAnalyzer } from "../server/ai.ts";
import { type Analysis, type Invoice, proposeAction } from "../server/domain.ts";
import { type PaypalInvoiceState, SimulatedPaypal } from "../server/paypal.ts";
import { Service } from "../server/service.ts";
import { Store } from "../server/store.ts";

const TODAY = "2026-11-03"; // a Tuesday

const invoice: Invoice = {
  id: "i1",
  paypalId: "p1",
  number: "PP-1",
  customerName: "Test Co",
  customerEmail: "a@test.example",
  description: "Work",
  amount: 100000,
  paid: 0,
  dueDate: "2026-10-20",
  status: "SENT",
  payUrl: null,
  createdAt: "",
};

const analysis = (fields: Partial<Analysis>): Analysis => ({
  intent: "OTHER",
  promisedDate: null,
  promisedAmount: null,
  correctedAmount: null,
  reason: "",
  confidence: 0.9,
  draftReply: "Thanks",
  ...fields,
});

function newService() {
  return new Service(new Store(), new SimulatedPaypal(), new RulesAnalyzer(), () => TODAY);
}

async function withInvoice() {
  const service = newService();
  const created = await service.createInvoice({
    customerName: "Test Co",
    customerEmail: "a@test.example",
    description: "Work",
    amount: 100000,
    dueDate: "2026-10-20",
  });
  return { service, created };
}

describe("proposeAction guardrails", () => {
  it("sends low-confidence replies to the owner", () => {
    const result = proposeAction(analysis({ intent: "PROMISE_TO_PAY", promisedDate: "2026-11-06", confidence: 0.3 }), invoice, TODAY);
    expect(result.type).toBe("REVIEW");
  });

  it("caps a promise at the open balance", () => {
    const result = proposeAction(analysis({ intent: "PROMISE_TO_PAY", promisedDate: "2026-11-06", promisedAmount: 99999 }), invoice, TODAY);
    expect(result.payload.amount).toBe(100000);
  });

  it("ignores a promised date in the past", () => {
    const result = proposeAction(analysis({ intent: "PROMISE_TO_PAY", promisedDate: "2026-10-01" }), invoice, TODAY);
    expect(result.type).toBe("SEND_REMINDER");
  });

  it.each([0, -5, 1000, 1500])("rejects an invalid corrected amount of $%d", (correctedAmount) => {
    const result = proposeAction(analysis({ intent: "AMOUNT_DISPUTE", correctedAmount }), invoice, TODAY);
    expect(result.type).toBe("REVIEW");
  });

  it("rejects a correction below what was already paid", () => {
    const result = proposeAction(analysis({ intent: "AMOUNT_DISPUTE", correctedAmount: 200 }), { ...invoice, paid: 50000, status: "PARTIALLY_PAID" }, TODAY);
    expect(result.type).toBe("REVIEW");
  });

  it("warns on a large reduction", () => {
    const result = proposeAction(analysis({ intent: "AMOUNT_DISPUTE", correctedAmount: 100 }), invoice, TODAY);
    expect(result.type).toBe("CORRECT_INVOICE");
    expect(result.warnings).toHaveLength(1);
  });
});

describe("offline rules", () => {
  it("resolves a weekday to its next occurrence", () => {
    const result = analyzeWithRules("I will pay on Friday", TODAY);
    expect(result).toMatchObject({ intent: "PROMISE_TO_PAY", promisedDate: "2026-11-06" });
  });

  it("reads a dispute with a corrected amount", () => {
    expect(analyzeWithRules("This is wrong, it should be $800", TODAY)).toMatchObject({ intent: "AMOUNT_DISPUTE", correctedAmount: 800 });
  });
});

describe("approval flow", () => {
  it("changes nothing until the owner approves", async () => {
    const { service, created } = await withInvoice();
    await service.addReply(created.id, "It should be $800, the amount is wrong");
    expect(service.store.invoice(created.id)!.amount).toBe(100000);

    const [action] = service.store.actions(created.id);
    await service.decide(action.id, true);
    expect(service.store.invoice(created.id)!.amount).toBe(80000);
  });

  it("does not run an action twice", async () => {
    const { service, created } = await withInvoice();
    const { action } = await service.addReply(created.id, "I will pay on Friday");
    await service.decide(action.id, true);
    await expect(service.decide(action.id, true)).rejects.toMatchObject({ status: 409 });
    expect(service.store.promises(created.id)).toHaveLength(1);
  });

  it("does not execute a rejected action", async () => {
    const { service, created } = await withInvoice();
    const { action } = await service.addReply(created.id, "I will pay on Friday");
    await service.decide(action.id, false);
    expect(service.store.promises(created.id)).toHaveLength(0);
  });
});

describe("promise tracking", () => {
  async function promised() {
    const context = await withInvoice();
    const { action } = await context.service.addReply(context.created.id, "I will pay on Friday");
    await context.service.decide(action.id, true);
    return context;
  }

  it("marks a promise kept when the money arrives", async () => {
    const { service, created } = await promised();
    service.simulatePayment(created.id, 100000);
    expect(service.store.promises(created.id)[0].status).toBe("KEPT");
  });

  it("marks a promise broken after its date and queues one follow-up", async () => {
    const { service, created } = await promised();
    service.advanceClock(4);
    service.settlePromises();
    expect(service.store.promises(created.id)[0].status).toBe("BROKEN");
    expect(service.store.actions(created.id).filter((a) => a.status === "PENDING")).toHaveLength(1);
  });

  it("stays open through its due date", async () => {
    const { service, created } = await promised();
    service.advanceClock(3);
    expect(service.store.promises(created.id)[0].status).toBe("OPEN");
  });
});

describe("cash forecast", () => {
  it("counts only reliable promises as expected cash", async () => {
    const { service, created } = await withInvoice();
    service.updateSettings({ targetDate: "2026-11-10", obligation: 150000, cashOnHand: 20000 });

    let state = service.state().forecast;
    expect(state).toMatchObject({ promised: 0, atRisk: 100000, shortfall: 130000, shortfallIfRiskPays: 30000 });

    const { action } = await service.addReply(created.id, "I will pay on Friday");
    await service.decide(action.id, true);
    state = service.state().forecast;
    expect(state).toMatchObject({ promised: 100000, atRisk: 0, shortfall: 30000 });

    service.advanceClock(4);
    state = service.state().forecast;
    expect(state).toMatchObject({ promised: 0, atRisk: 100000 });
  });

  it("moves a received payment into cash and lowers the shortfall", async () => {
    const { service, created } = await withInvoice();
    service.updateSettings({ targetDate: "2026-11-10", obligation: 150000, cashOnHand: 20000 });
    service.simulatePayment(created.id, 100000);
    expect(service.state().forecast).toMatchObject({ cashOnHand: 120000, atRisk: 0, shortfall: 30000 });
  });

  it("does not count a promise dated after the target", async () => {
    const { service, created } = await withInvoice();
    service.updateSettings({ targetDate: "2026-11-05", obligation: 50000, cashOnHand: 0 });
    const { action } = await service.addReply(created.id, "I will pay on Friday");
    await service.decide(action.id, true);
    expect(service.state().forecast).toMatchObject({ promised: 0, later: 100000, shortfall: 50000 });
  });
});

describe("PayPal payment events", () => {
  class PaidPaypal extends SimulatedPaypal {
    remote: PaypalInvoiceState | null = null;
    override async get() {
      return this.remote;
    }
  }

  it("records a new PayPal payment once in the invoice history", async () => {
    const paypal = new PaidPaypal();
    const service = new Service(new Store(), paypal, new RulesAnalyzer(), () => TODAY);
    const created = await service.createInvoice({
      customerName: "Test Co",
      customerEmail: "a@test.example",
      description: "Work",
      amount: 100000,
      dueDate: "2026-11-20",
    });
    paypal.remote = { paypalId: created.paypalId, amount: 100000, paid: 40000, status: "PARTIALLY_PAID", payUrl: null };

    await service.syncByPaypalId(created.paypalId);
    await service.syncByPaypalId(created.paypalId);

    const payments = service.store.events(created.id).filter((e) => e.text.startsWith("PayPal confirmed"));
    expect(payments).toHaveLength(1);
    expect(payments[0].text).toContain("$400.00");
    expect(service.settings().cashOnHand).toBe(40000);
  });
});
