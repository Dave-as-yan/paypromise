import { AllCommunityModule, type ColDef, type ICellRendererParams, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Forecast, Invoice, PaymentPromise, RiskTag } from "../server/domain.ts";
import type { Action, Reply, Settings, TimelineEvent } from "../server/store.ts";

ModuleRegistry.registerModules([AllCommunityModule]);

interface Row extends Invoice {
  balance: number;
  risk: RiskTag;
  promiseDate: string | null;
  lastIntent: string | null;
  pending: number;
}

interface AppState {
  today: string;
  modes: { paypal: "simulated" | "sandbox"; ai: "claude" | "rules"; demoClock: boolean };
  settings: Settings;
  forecast: Forecast;
  invoices: Row[];
}

interface Detail {
  invoice: Invoice & { balance: number };
  replies: Reply[];
  promises: PaymentPromise[];
  actions: Action[];
  events: TimelineEvent[];
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data as T;
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const RISK_LABELS: Record<RiskTag, string> = {
  PAID: "Paid",
  ON_TRACK: "Not due yet",
  PROMISED: "Promised",
  DISPUTED: "Disputed",
  BROKEN: "Broken promise",
  OVERDUE: "Overdue",
  CANCELLED: "Cancelled",
};

const INTENT_LABELS: Record<string, string> = {
  PROMISE_TO_PAY: "Promise to pay",
  PARTIAL_PAYMENT_REQUEST: "Asks for partial payment",
  AMOUNT_DISPUTE: "Disputes the amount",
  ALREADY_PAID: "Says it is already paid",
  NEEDS_INFO: "Needs information",
  REFUSAL: "Refuses to pay",
  OTHER: "Unclear",
};

const SAMPLE_REPLIES = [
  { label: "Promise", text: "Sorry for the delay, cash is tight this month. I will pay the full amount on Friday." },
  { label: "Wrong amount", text: "This looks wrong. We agreed on $1,650 for the job, so the invoice should be $1,650." },
  { label: "Partial", text: "I can't pay it all at once. I can do half now and the rest later if that works." },
  { label: "Already paid", text: "We already paid this last week, please check on your side." },
];

const theme = themeQuartz.withParams({
  accentColor: "var(--accent)",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  borderColor: "var(--border)",
  headerBackgroundColor: "var(--surface-2)",
  fontFamily: "inherit",
  fontSize: 14,
  headerFontWeight: 600,
  wrapperBorderRadius: 10,
  rowHoverColor: "var(--surface-2)",
  selectedRowBackgroundColor: "var(--accent-soft)",
});

function RiskPill({ value }: ICellRendererParams<Row, RiskTag>) {
  return value ? <span className={`pill risk-${value}`}>{RISK_LABELS[value]}</span> : null;
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    setState(await api<AppState>("/state"));
  }, []);

  const loadDetail = useCallback(async (id: string | null) => {
    setDetail(id ? await api<Detail>(`/invoices/${id}`) : null);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  useEffect(() => {
    loadDetail(selectedId).catch((e) => setError(e.message));
  }, [selectedId, loadDetail]);

  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await task();
        await refresh();
        await loadDetail(selectedId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [refresh, loadDetail, selectedId],
  );

  // PayPal's webhook updates the server, so an open dashboard has to ask for the news.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      Promise.all([refresh(), loadDetail(selectedId)]).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, loadDetail, selectedId]);

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: "customerName", headerName: "Customer", flex: 2, minWidth: 170 },
      { field: "balance", headerName: "Balance", flex: 1, minWidth: 110, type: "rightAligned", valueFormatter: (p) => usd(p.value ?? 0) },
      { field: "dueDate", headerName: "Due", flex: 1, minWidth: 90, valueFormatter: (p) => (p.value ? shortDate(p.value) : "") },
      { field: "risk", headerName: "Status", flex: 1.3, minWidth: 140, cellRenderer: RiskPill },
      { field: "promiseDate", headerName: "Promise", flex: 1, minWidth: 90, valueFormatter: (p) => (p.value ? shortDate(p.value) : "None") },
      {
        field: "pending",
        headerName: "Approve",
        flex: 0.8,
        minWidth: 90,
        cellRenderer: (p: ICellRendererParams<Row, number>) => (p.value ? <span className="count">{p.value}</span> : null),
      },
    ],
    [],
  );

  if (!state) {
    return <div className="loading">{error ?? "Loading PayPromise..."}</div>;
  }

  const simulated = state.modes.paypal === "simulated";

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>PayPromise</h1>
          <p>Every "I'll pay Friday" tracked and checked against PayPal.</p>
        </div>
        <div className="topbar-actions">
          <span className={`mode ${simulated ? "mode-demo" : "mode-live"}`}>PayPal: {simulated ? "simulated" : "sandbox"}</span>
          <span className={`mode ${state.modes.ai === "claude" ? "mode-live" : "mode-demo"}`}>AI: {state.modes.ai === "claude" ? "Claude" : "offline rules"}</span>
          {!simulated && (
            <button disabled={busy} onClick={() => run(() => api("/sync", { method: "POST" }))}>Sync with PayPal</button>
          )}
          <button className="primary" onClick={() => setShowNew((v) => !v)}>New invoice</button>
        </div>
      </header>

      {error && <div className="error" role="alert">{error}</div>}
      {showNew && (
        <NewInvoice
          today={state.today}
          busy={busy}
          onCancel={() => setShowNew(false)}
          onSubmit={(input) =>
            run(async () => {
              await api("/invoices", { method: "POST", body: input });
              setShowNew(false);
            })
          }
        />
      )}

      <CashPanel state={state} busy={busy} onSave={(changes) => run(() => api("/settings", { method: "PUT", body: changes }))} />

      {state.modes.demoClock && (
        <div className="demobar">
          <span>Demo controls. Today is <strong>{shortDate(state.today)}</strong>.</span>
          <button disabled={busy} onClick={() => run(() => api("/demo/advance", { method: "POST", body: { days: 1 } }))}>Next day</button>
          {simulated && <button disabled={busy} onClick={() => run(async () => { await api("/demo/reset", { method: "POST" }); setSelectedId(null); })}>Reset demo</button>}
        </div>
      )}

      <main className="workspace">
        <section className="grid-wrap" aria-label="Invoices">
          <AgGridReact<Row>
            theme={theme}
            rowData={state.invoices}
            columnDefs={columns}
            getRowId={(p) => p.data.id}
            domLayout="autoHeight"
            rowSelection={{ mode: "singleRow", enableClickSelection: true, checkboxes: false }}
            onRowClicked={(e) => e.data && setSelectedId(e.data.id)}
            overlayNoRowsTemplate="No invoices yet. Create your first one."
          />
        </section>
        <aside className="panel">
          {detail ? (
            <InvoicePanel detail={detail} busy={busy} simulated={simulated} run={run} />
          ) : (
            <div className="empty">
              <h2>Select an invoice</h2>
              <p>Paste the customer's reply, then approve what the AI proposes.</p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function CashPanel({ state, busy, onSave }: { state: AppState; busy: boolean; onSave: (c: { targetDate: string; obligation: number; cashOnHand: number }) => void }) {
  const { forecast: f, settings } = state;
  const [editing, setEditing] = useState(false);
  const covered = f.shortfall === 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      targetDate: String(data.get("targetDate")),
      obligation: Number(data.get("obligation")),
      cashOnHand: Number(data.get("cashOnHand")),
    });
    setEditing(false);
  }

  return (
    <section className={`cash ${covered ? "cash-ok" : "cash-short"}`} aria-label="Cash forecast">
      <div className="cash-headline">
        <span className="eyebrow">{settings.obligationLabel} on {shortDate(f.targetDate)}: {usd(f.obligation)}</span>
        <strong>{covered ? "Covered by cash and reliable promises" : `${usd(f.shortfall)} short`}</strong>
        <span className="cash-note">
          {covered
            ? "No action needed for this date."
            : f.shortfallIfRiskPays === 0
              ? "You are covered only if at-risk customers pay on time."
              : `Still ${usd(f.shortfallIfRiskPays)} short even if every at-risk customer pays.`}
        </span>
      </div>
      <dl className="stats">
        <div><dt>Cash on hand</dt><dd>{usd(f.cashOnHand)}</dd></div>
        <div><dt>Promised by then</dt><dd>{usd(f.promised)}</dd></div>
        <div><dt>At risk</dt><dd>{usd(f.atRisk)}</dd></div>
        <div><dt>Due later</dt><dd>{usd(f.later)}</dd></div>
      </dl>
      <button className="link" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
      {editing && (
        <form className="cash-form" onSubmit={submit}>
          <label>Date<input name="targetDate" type="date" required defaultValue={settings.targetDate} /></label>
          <label>{settings.obligationLabel} ($)<input name="obligation" type="number" min="0" step="0.01" required defaultValue={settings.obligation / 100} /></label>
          <label>Cash on hand ($)<input name="cashOnHand" type="number" min="0" step="0.01" required defaultValue={settings.cashOnHand / 100} /></label>
          <button className="primary" disabled={busy}>Save</button>
        </form>
      )}
    </section>
  );
}

function NewInvoice({ today, busy, onSubmit, onCancel }: {
  today: string;
  busy: boolean;
  onSubmit: (input: { customerName: string; customerEmail: string; description: string; amount: number; dueDate: string }) => void;
  onCancel: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      customerName: String(data.get("customerName")),
      customerEmail: String(data.get("customerEmail")),
      description: String(data.get("description")),
      amount: Number(data.get("amount")),
      dueDate: String(data.get("dueDate")),
    });
  }
  return (
    <form className="new-invoice" onSubmit={submit}>
      <label>Customer<input name="customerName" required maxLength={120} /></label>
      <label>Email<input name="customerEmail" type="email" required /></label>
      <label>Work<input name="description" required maxLength={200} /></label>
      <label>Amount ($)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
      <label>Due<input name="dueDate" type="date" required defaultValue={today} /></label>
      <div className="form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>Create and send</button>
      </div>
    </form>
  );
}

function InvoicePanel({ detail, busy, simulated, run }: { detail: Detail; busy: boolean; simulated: boolean; run: (task: () => Promise<unknown>) => Promise<void> }) {
  const { invoice, replies, promises, actions, events } = detail;
  const [reply, setReply] = useState("");
  const pending = actions.filter((a) => a.status === "PENDING");
  const failed = actions.filter((a) => a.status === "FAILED").slice(-1);
  const latest = replies.at(-1);

  return (
    <div className="panel-body">
      <div className="panel-head">
        <div>
          <h2>{invoice.customerName}</h2>
          <p>{invoice.description} · {invoice.number}</p>
        </div>
        <div className="panel-amount">
          <strong>{usd(invoice.balance)}</strong>
          <span>of {usd(invoice.amount)}</span>
        </div>
      </div>
      {invoice.payUrl && <a href={invoice.payUrl} target="_blank" rel="noreferrer">Open PayPal invoice</a>}

      {pending.map((action) => (
        <div className="approval" key={action.id}>
          <span className="eyebrow">Waiting for your approval</span>
          <h3>{action.title}</h3>
          <p>{action.rationale}</p>
          {action.payload.note && <blockquote>{action.payload.note}</blockquote>}
          {action.warnings.map((w) => <p className="warning" key={w}>{w}</p>)}
          <div className="approval-actions">
            <button className="primary" disabled={busy} onClick={() => run(() => api(`/actions/${action.id}/approve`, { method: "POST" }))}>
              {action.type === "REVIEW" ? "Mark reviewed" : "Approve"}
            </button>
            {action.type !== "REVIEW" && (
              <button disabled={busy} onClick={() => run(() => api(`/actions/${action.id}/reject`, { method: "POST" }))}>Reject</button>
            )}
          </div>
        </div>
      ))}

      {failed.map((a) => <p className="error" key={a.id}>{a.title} failed: {a.error}</p>)}

      {latest && (
        <div className="analysis">
          <span className="eyebrow">Latest reply, read by {latest.source === "claude" ? "Claude" : "offline rules"}</span>
          <blockquote>{latest.body}</blockquote>
          <dl>
            <div><dt>Meaning</dt><dd>{INTENT_LABELS[latest.analysis.intent]}</dd></div>
            <div><dt>Why late</dt><dd>{latest.analysis.reason}</dd></div>
            {latest.analysis.promisedDate && <div><dt>Date</dt><dd>{shortDate(latest.analysis.promisedDate)}</dd></div>}
            <div><dt>Confidence</dt><dd>{Math.round(latest.analysis.confidence * 100)}%</dd></div>
          </dl>
          {latest.notice && <p className="warning">{latest.notice}</p>}
          <details>
            <summary>Suggested reply to the customer</summary>
            <p>{latest.analysis.draftReply}</p>
          </details>
        </div>
      )}

      {invoice.balance > 0 && (
        <form
          className="reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            const body = reply;
            run(async () => {
              await api(`/invoices/${invoice.id}/replies`, { method: "POST", body: { body } });
              setReply("");
            });
          }}
        >
          <label htmlFor="reply">Customer's reply</label>
          <textarea id="reply" rows={3} maxLength={4000} required value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Paste what the customer wrote" />
          <div className="samples">
            {SAMPLE_REPLIES.map((s) => (
              <button type="button" className="chip" key={s.label} onClick={() => setReply(s.text)}>{s.label}</button>
            ))}
          </div>
          <button className="primary" disabled={busy || !reply.trim()}>{busy ? "Working..." : "Read reply"}</button>
        </form>
      )}

      {promises.length > 0 && (
        <div>
          <h3>Promises</h3>
          <ul className="promises">
            {promises.map((p) => (
              <li key={p.id}><span>{usd(p.amount)} by {shortDate(p.dueDate)}</span><span className={`pill promise-${p.status}`}>{p.status.toLowerCase()}</span></li>
            ))}
          </ul>
        </div>
      )}

      {simulated && invoice.balance > 0 && (
        <button disabled={busy} onClick={() => run(() => api("/demo/pay", { method: "POST", body: { invoiceId: invoice.id, amount: invoice.balance / 100 } }))}>
          Simulate full PayPal payment
        </button>
      )}

      <div>
        <h3>History</h3>
        <ul className="timeline">
          {events.map((e) => <li key={e.id}>{e.text}</li>)}
        </ul>
      </div>
    </div>
  );
}
