// Sandbox only: this prototype never talks to PayPal's live API.
import { randomUUID } from "node:crypto";
import type { InvoiceStatus } from "./domain.ts";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export interface NewPaypalInvoice {
  number: string;
  customerName: string;
  customerEmail: string;
  description: string;
  amount: number;
  dueDate: string;
}

export interface PaypalInvoiceState {
  paypalId: string;
  amount: number;
  paid: number;
  status: InvoiceStatus;
  payUrl: string | null;
}

export interface PaypalGateway {
  readonly mode: "simulated" | "sandbox";
  createAndSend(invoice: NewPaypalInvoice): Promise<PaypalInvoiceState>;
  get(paypalId: string): Promise<PaypalInvoiceState | null>;
  remind(paypalId: string, note: string): Promise<void>;
  setAmount(paypalId: string, amount: number): Promise<void>;
  allowPartial(paypalId: string, minimumDue: number): Promise<void>;
}

const money = (cents: number) => ({ currency_code: "USD", value: (cents / 100).toFixed(2) });
const toCents = (value: string | undefined) => (value ? Math.round(Number(value) * 100) : 0);

function mapStatus(status: string): InvoiceStatus {
  switch (status) {
    case "PAID":
    case "MARKED_AS_PAID":
      return "PAID";
    case "PARTIALLY_PAID":
      return "PARTIALLY_PAID";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "SENT";
  }
}

interface PaypalInvoice {
  id: string;
  status: string;
  amount?: { value?: string };
  payments?: { paid_amount?: { value?: string } };
  detail?: { metadata?: { recipient_view_url?: string } };
  items?: { name: string; quantity: string; unit_amount: { currency_code: string; value: string } }[];
  configuration?: Record<string, unknown>;
  [key: string]: unknown;
}

export class SandboxPaypal implements PaypalGateway {
  readonly mode = "sandbox";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private clientId: string,
    private secret: string,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const response = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new Error(`PayPal rejected the sandbox credentials (status ${response.status}).`);
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = async () =>
      fetch(`${SANDBOX_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          "PayPal-Request-Id": requestId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const requestId = randomUUID();
    let response = await send();
    if (response.status === 401) {
      this.token = null;
      response = await send();
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PayPal ${method} ${path.split("?")[0]} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private toState(invoice: PaypalInvoice): PaypalInvoiceState {
    return {
      paypalId: invoice.id,
      amount: toCents(invoice.amount?.value),
      paid: toCents(invoice.payments?.paid_amount?.value),
      status: mapStatus(invoice.status),
      payUrl: invoice.detail?.metadata?.recipient_view_url ?? null,
    };
  }

  async createAndSend(invoice: NewPaypalInvoice): Promise<PaypalInvoiceState> {
    const draft = await this.call<PaypalInvoice>("POST", "/v2/invoicing/invoices", {
      detail: {
        invoice_number: invoice.number,
        currency_code: "USD",
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: invoice.dueDate },
      },
      primary_recipients: [
        {
          billing_info: {
            name: { full_name: invoice.customerName },
            email_address: invoice.customerEmail,
          },
        },
      ],
      items: [{ name: invoice.description, quantity: "1", unit_amount: money(invoice.amount) }],
    });
    await this.call("POST", `/v2/invoicing/invoices/${draft.id}/send`, {
      send_to_invoicer: false,
      send_to_recipient: true,
    });
    return this.toState(await this.call<PaypalInvoice>("GET", `/v2/invoicing/invoices/${draft.id}`));
  }

  async get(paypalId: string): Promise<PaypalInvoiceState | null> {
    return this.toState(await this.call<PaypalInvoice>("GET", `/v2/invoicing/invoices/${paypalId}`));
  }

  async remind(paypalId: string, note: string): Promise<void> {
    await this.call("POST", `/v2/invoicing/invoices/${paypalId}/remind`, {
      subject: "Payment reminder",
      note: note.slice(0, 4000),
      send_to_invoicer: false,
      send_to_recipient: true,
    });
  }

  // PayPal's update replaces the whole invoice, so start from the current copy.
  private async update(paypalId: string, change: (invoice: PaypalInvoice) => void): Promise<void> {
    const invoice = await this.call<PaypalInvoice>("GET", `/v2/invoicing/invoices/${paypalId}`);
    change(invoice);
    await this.call("PUT", `/v2/invoicing/invoices/${paypalId}?send_to_recipient=true&send_to_invoicer=false`, invoice);
  }

  async setAmount(paypalId: string, amount: number): Promise<void> {
    await this.update(paypalId, (invoice) => {
      const name = invoice.items?.[0]?.name ?? "Invoice";
      invoice.items = [{ name, quantity: "1", unit_amount: money(amount) }];
      delete invoice.amount;
    });
  }

  async allowPartial(paypalId: string, minimumDue: number): Promise<void> {
    await this.update(paypalId, (invoice) => {
      invoice.configuration = {
        ...invoice.configuration,
        partial_payment: { allow_partial_payment: true, minimum_amount_due: money(minimumDue) },
      };
    });
  }

  async verifyWebhook(headers: Record<string, string | string[] | undefined>, event: unknown, webhookId: string) {
    const result = await this.call<{ verification_status: string }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
    );
    return result.verification_status === "SUCCESS";
  }
}

// Stands in for PayPal in demo mode. The app's database stays the source of truth there.
export class SimulatedPaypal implements PaypalGateway {
  readonly mode = "simulated";

  async createAndSend(invoice: NewPaypalInvoice): Promise<PaypalInvoiceState> {
    return { paypalId: `SIM-${randomUUID().slice(0, 8)}`, amount: invoice.amount, paid: 0, status: "SENT", payUrl: null };
  }
  async get(): Promise<PaypalInvoiceState | null> {
    return null;
  }
  async remind(): Promise<void> {}
  async setAmount(): Promise<void> {}
  async allowPartial(): Promise<void> {}
}

export function createPaypal(): PaypalGateway {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  return PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
    ? new SandboxPaypal(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET)
    : new SimulatedPaypal();
}
