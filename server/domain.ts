// Pure business rules. All money is integer cents; all dates are YYYY-MM-DD.
import { z } from "zod";
import type { PlanItem } from "./plan.ts";

export const INTENTS = [
  "PROMISE_TO_PAY",
  "PARTIAL_PAYMENT_REQUEST",
  "AMOUNT_DISPUTE",
  "ALREADY_PAID",
  "NEEDS_INFO",
  "REFUSAL",
  "OTHER",
] as const;

export const AnalysisSchema = z.object({
  intent: z.enum(INTENTS),
  promisedDate: z.string().nullable().describe("YYYY-MM-DD the customer committed to, or null"),
  promisedAmount: z.number().nullable().describe("US dollars the customer committed to pay, or null"),
  correctedAmount: z.number().nullable().describe("US dollars the customer says the full invoice should be, or null"),
  evidence: z.string().nullable().describe("The shortest exact quote from the reply that supports this reading, or null"),
  reason: z.string().describe("One short sentence: why payment is late, in the customer's terms"),
  confidence: z.number().describe("0 to 1"),
  draftReply: z.string().describe("Short, polite reply the business owner could send"),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export type InvoiceStatus = "SENT" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";

export interface Invoice {
  id: string;
  paypalId: string;
  number: string;
  customerName: string;
  customerEmail: string;
  description: string;
  amount: number;
  paid: number;
  dueDate: string;
  status: InvoiceStatus;
  payUrl: string | null;
  createdAt: string;
}

export interface PaymentPromise {
  id: string;
  invoiceId: string;
  replyId: string | null;
  amount: number;
  dueDate: string;
  paidAtCreation: number;
  status: "OPEN" | "KEPT" | "BROKEN" | "RESCHEDULED";
  createdAt: string;
}

export type ActionType =
  | "TRACK_PROMISE"
  | "ALLOW_PARTIAL"
  | "CORRECT_INVOICE"
  | "SEND_REMINDER"
  | "VERIFY_PAYMENT"
  | "REVIEW";

export interface ActionPayload {
  amount?: number;
  dueDate?: string;
  minimumDue?: number;
  newAmount?: number;
  note?: string;
}

export interface Proposal {
  type: ActionType;
  title: string;
  rationale: string;
  payload: ActionPayload;
  warnings: string[];
}

export const MIN_CONFIDENCE = 0.6;

export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const money = (cents: number) => usd(cents).replace(/\.00$/, "");

export const niceDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export const toCents = (dollars: number) => Math.round(dollars * 100);

export const balanceOf = (invoice: Pick<Invoice, "amount" | "paid" | "status">) =>
  invoice.status === "CANCELLED" ? 0 : Math.max(0, invoice.amount - invoice.paid);

export function isValidDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// Turns an untrusted AI reading of a customer's message into one proposed step.
// The limits live here, not in the prompt, so a misleading reply cannot widen them.
export function proposeAction(analysis: Analysis, invoice: Invoice, today: string): Proposal {
  const balance = balanceOf(invoice);
  const review = (rationale: string): Proposal => ({
    type: "REVIEW",
    title: "Review this reply yourself",
    rationale,
    payload: {},
    warnings: [],
  });

  if (balance === 0) return review("This invoice has no open balance.");
  if (analysis.confidence < MIN_CONFIDENCE) {
    return review(`The AI is unsure how to read this reply (${Math.round(analysis.confidence * 100)}% confidence).`);
  }

  const date = isValidDate(analysis.promisedDate) && analysis.promisedDate >= today ? analysis.promisedDate : null;
  const promised =
    analysis.promisedAmount != null && analysis.promisedAmount > 0
      ? Math.min(toCents(analysis.promisedAmount), balance)
      : null;

  switch (analysis.intent) {
    case "PROMISE_TO_PAY": {
      if (!date) {
        return {
          type: "SEND_REMINDER",
          title: "Ask for a firm payment date",
          rationale: "The customer intends to pay but gave no usable date.",
          payload: { note: analysis.draftReply },
          warnings: [],
        };
      }
      const amount = promised ?? balance;
      return {
        type: "TRACK_PROMISE",
        title: `Track ${money(amount)} by ${niceDate(date)}`,
        rationale: "PayPromise will check PayPal on that date and flag the promise if the money has not arrived.",
        payload: { amount, dueDate: date },
        warnings: [],
      };
    }
    case "PARTIAL_PAYMENT_REQUEST": {
      const minimumDue = promised ?? Math.ceil(balance / 2);
      const warnings = minimumDue < balance / 4 ? [`Minimum payment is under 25% of the ${usd(balance)} balance.`] : [];
      return {
        type: "ALLOW_PARTIAL",
        title: `Allow partial payment, ${money(minimumDue)} minimum`,
        rationale: "The customer cannot pay in full at once. This opens partial payment on the PayPal invoice. It is not credit.",
        payload: { minimumDue, ...(date ? { amount: minimumDue, dueDate: date } : {}) },
        warnings,
      };
    }
    case "AMOUNT_DISPUTE": {
      if (analysis.correctedAmount == null) {
        return review("The customer disputes the amount but did not say what it should be.");
      }
      const newAmount = toCents(analysis.correctedAmount);
      if (newAmount <= 0 || newAmount >= invoice.amount || newAmount < invoice.paid) {
        return review(`The customer's figure (${usd(newAmount)}) is not a valid correction for this invoice.`);
      }
      const reduction = (invoice.amount - newAmount) / invoice.amount;
      return {
        type: "CORRECT_INVOICE",
        title: `Change the invoice from ${money(invoice.amount)} to ${money(newAmount)}`,
        rationale: "Only the customer claims this figure. Check it against your records before approving.",
        payload: { newAmount },
        warnings: reduction > 0.3 ? [`This lowers the invoice by ${Math.round(reduction * 100)}%.`] : [],
      };
    }
    case "ALREADY_PAID":
      return {
        type: "VERIFY_PAYMENT",
        title: "Check PayPal for this payment",
        rationale: "The customer says it is paid. PayPromise trusts PayPal's record, not the message.",
        payload: {},
        warnings: [],
      };
    case "NEEDS_INFO":
      return {
        type: "SEND_REMINDER",
        title: "Send the requested details",
        rationale: "The customer needs information before paying.",
        payload: { note: analysis.draftReply },
        warnings: [],
      };
    default:
      return review(`No safe automatic step for this reply (${analysis.intent.toLowerCase()}).`);
  }
}

// A new date given before the old one passed is a reschedule, not a broken promise.
export const replacedStatus = (promise: Pick<PaymentPromise, "dueDate">, today: string): PaymentPromise["status"] =>
  promise.dueDate >= today ? "RESCHEDULED" : "BROKEN";

// A promise is kept when enough new money arrives, and broken once its date has passed.
export function settlePromise(promise: PaymentPromise, invoice: Invoice, today: string): PaymentPromise["status"] {
  if (promise.status !== "OPEN") return promise.status;
  if (invoice.status === "PAID" || invoice.paid - promise.paidAtCreation >= promise.amount) return "KEPT";
  return promise.dueDate < today ? "BROKEN" : "OPEN";
}

export type RiskTag = "PAID" | "ON_TRACK" | "PROMISED" | "DISPUTED" | "BROKEN" | "OVERDUE" | "CANCELLED";

export interface RiskInput {
  invoice: Invoice;
  promises: PaymentPromise[];
  disputed: boolean;
}

export function riskTag({ invoice, promises, disputed }: RiskInput, today: string): RiskTag {
  if (invoice.status === "CANCELLED") return "CANCELLED";
  if (balanceOf(invoice) === 0) return "PAID";
  if (promises.some((p) => p.status === "BROKEN")) return "BROKEN";
  if (disputed) return "DISPUTED";
  if (promises.some((p) => p.status === "OPEN")) return "PROMISED";
  return invoice.dueDate < today ? "OVERDUE" : "ON_TRACK";
}

export interface Forecast {
  targetDate: string;
  obligation: number;
  cashOnHand: number;
  promised: number;
  atRisk: number;
  later: number;
  shortfall: number;
  shortfallIfRiskPays: number;
}

// Only an open promise from a customer with a clean record counts as expected cash.
export function forecast(
  inputs: RiskInput[],
  settings: { targetDate: string; obligation: number; cashOnHand: number },
  today: string,
): Forecast {
  let promised = 0;
  let atRisk = 0;
  let later = 0;

  for (const input of inputs) {
    const { invoice, promises } = input;
    const balance = balanceOf(invoice);
    if (balance === 0) continue;

    const tag = riskTag(input, today);
    const reliable =
      tag === "PROMISED"
        ? promises
            .filter((p) => p.status === "OPEN" && p.dueDate <= settings.targetDate)
            .reduce((sum, p) => sum + Math.max(0, p.amount - (invoice.paid - p.paidAtCreation)), 0)
        : 0;
    const counted = Math.min(reliable, balance);
    promised += counted;

    const rest = balance - counted;
    const nextDate =
      tag === "PROMISED"
        ? promises.filter((p) => p.status === "OPEN").map((p) => p.dueDate).sort()[0]
        : invoice.dueDate;
    if (rest > 0) {
      if ((tag === "PROMISED" || tag === "ON_TRACK") && nextDate > settings.targetDate) later += rest;
      else atRisk += rest;
    }
  }

  const shortfall = Math.max(0, settings.obligation - settings.cashOnHand - promised);
  return {
    targetDate: settings.targetDate,
    obligation: settings.obligation,
    cashOnHand: settings.cashOnHand,
    promised,
    atRisk,
    later,
    shortfall,
    shortfallIfRiskPays: Math.max(0, shortfall - atRisk),
  };
}

// A customer's record: what PayPal data proved across their promises, plus any sample history.
export interface PromiseRecord {
  kept: number;
  broken: number;
}

export function promiseRecord(promises: Pick<PaymentPromise, "status">[], history: PromiseRecord = { kept: 0, broken: 0 }): PromiseRecord {
  return {
    kept: history.kept + promises.filter((p) => p.status === "KEPT").length,
    broken: history.broken + promises.filter((p) => p.status === "BROKEN").length,
  };
}

// One line for money counted toward the target date, another for the rest of the balance.
export function planItems(inputs: RiskInput[], settings: { targetDate: string }, today: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const input of inputs) {
    const { invoice, promises } = input;
    const balance = balanceOf(invoice);
    if (balance === 0) continue;

    const tag = riskTag(input, today);
    const base = { invoiceId: invoice.id, customerName: invoice.customerName, customerEmail: invoice.customerEmail };
    const open = tag === "PROMISED" ? promises.filter((p) => p.status === "OPEN") : [];
    const counted = open.find((p) => p.dueDate <= settings.targetDate);
    const countedAmount = counted ? Math.min(balance, Math.max(0, counted.amount - (invoice.paid - counted.paidAtCreation))) : 0;
    if (counted && countedAmount > 0) {
      items.push({ ...base, id: `${invoice.id}:promise`, amount: countedAmount, date: counted.dueDate, kind: "PROMISED", counted: true, afterTarget: false });
    }

    const rest = balance - countedAmount;
    if (rest > 0) {
      const date = open[0]?.dueDate ?? invoice.dueDate;
      const kind: PlanItem["kind"] =
        tag === "BROKEN" ? "BROKEN" : tag === "DISPUTED" ? "DISPUTED" : tag === "PROMISED" ? "PROMISED" : invoice.dueDate < today ? "OVERDUE" : "NOT_DUE";
      items.push({ ...base, id: `${invoice.id}:rest`, amount: rest, date, kind, counted: false, afterTarget: date > settings.targetDate });
    }
  }
  return items;
}

export interface ActionImpact {
  shortfallBefore: number;
  shortfallAfter: number;
  bestCaseChange: number;
}

const bestCase = (f: Forecast) => f.cashOnHand + f.promised + f.atRisk;

// What approving would do to the forecast. Mirrors what the action does when it runs.
export function actionImpact(
  inputs: RiskInput[],
  settings: { targetDate: string; obligation: number; cashOnHand: number },
  today: string,
  action: { invoiceId: string; type: ActionType; payload: ActionPayload },
): ActionImpact {
  const projected = inputs.map((input) => {
    if (input.invoice.id !== action.invoiceId) return input;
    const { amount, dueDate, newAmount } = action.payload;
    if (action.type === "CORRECT_INVOICE" && newAmount != null) {
      return { ...input, disputed: false, invoice: { ...input.invoice, amount: newAmount } };
    }
    if ((action.type === "TRACK_PROMISE" || action.type === "ALLOW_PARTIAL") && amount != null && dueDate) {
      const hypothetical: PaymentPromise = {
        id: "projected",
        invoiceId: input.invoice.id,
        replyId: null,
        amount,
        dueDate,
        paidAtCreation: input.invoice.paid,
        status: "OPEN",
        createdAt: "",
      };
      return {
        ...input,
        promises: [...input.promises.map((p) => (p.status === "OPEN" ? { ...p, status: replacedStatus(p, today) } : p)), hypothetical],
      };
    }
    return input;
  });
  const before = forecast(inputs, settings, today);
  const after = forecast(projected, settings, today);
  return { shortfallBefore: before.shortfall, shortfallAfter: after.shortfall, bestCaseChange: bestCase(after) - bestCase(before) };
}
