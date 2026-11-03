import { MotionConfig } from "motion/react";
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { type AppState, api, shortDate, usd, useRoute, useTheme } from "./lib.ts";
import { CashPlan } from "./pages/CashPlan.tsx";
import { Customers } from "./pages/Customers.tsx";
import { PromiseLink } from "./pages/PromiseLink.tsx";
import { Review } from "./pages/Review.tsx";
import { Dialog } from "./ui.tsx";

// The grid and chart are heavy, and customers opening a promise link on a phone never need them.
const Today = lazy(() => import("./pages/Today.tsx").then((m) => ({ default: m.Today })));

const UNDO_SECONDS = 10;

interface Queued {
  actionId: string;
  title: string;
  note?: string;
}

export interface Workspace {
  state: AppState;
  busy: boolean;
  queuedId: string | null;
  navigate: (to: string) => void;
  approve: (actionId: string, title: string, note?: string) => void;
  reject: (actionId: string) => void;
  run: (task: () => Promise<unknown>) => Promise<void>;
  openReply: (invoiceId: string) => void;
  version: number;
}

export function App() {
  const { path, navigate } = useRoute();
  if (path.startsWith("/p/")) return <PromiseLink token={path.slice(3)} />;
  return <Dashboard path={path} navigate={navigate} />;
}

function Dashboard({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const [state, setState] = useState<AppState | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<Queued | null>(null);
  const [dialog, setDialog] = useState<"invoice" | "payroll" | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const { theme, toggle } = useTheme();

  const refresh = useCallback(async () => {
    setState(await api<AppState>("/state"));
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  // PayPal's webhook changes the server, so it tells open pages. Polling covers a lost stream.
  // Waits for the first state, which is what sets a new visitor's demo cookie.
  const ready = state !== null;
  useEffect(() => {
    if (!ready) return;
    const stream = new EventSource("/api/events");
    stream.addEventListener("changed", () => refresh().catch(() => {}));
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch(() => {});
    }, 20_000);
    return () => {
      stream.close();
      clearInterval(timer);
    };
  }, [ready, refresh]);

  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await task();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const send = useCallback(
    (item: Queued) =>
      run(async () => {
        const result = await api<{ status: string; error: string | null }>(`/actions/${item.actionId}/approve`, { method: "POST", body: item.note ? { note: item.note } : {} });
        if (result.status === "FAILED") throw new Error(result.error ?? "PayPal couldn't complete this.");
      }),
    [run],
  );

  // Approvals wait in the browser, so closing the tab during the delay also cancels them.
  const queuedRef = useRef<Queued | null>(null);
  queuedRef.current = queued;
  const approve = useCallback(
    (actionId: string, title: string, note?: string) => {
      if (queuedRef.current) void send(queuedRef.current);
      setQueued({ actionId, title, note });
    },
    [send],
  );
  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => {
      setQueued(null);
      void send(queued);
    }, UNDO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [queued, send]);

  const [switching, setSwitching] = useState(false);
  const startDemo = async (kind: "simulated" | "sandbox") => {
    setSwitching(true);
    setError(null);
    try {
      await api("/demo/workspace", { method: "POST", body: { kind } });
      window.location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setSwitching(false);
    }
  };

  const reject = useCallback((actionId: string) => void run(() => api(`/actions/${actionId}/reject`, { method: "POST", body: {} })), [run]);

  if (!state) return <div className="empty">{error ?? "Loading PayPromise..."}</div>;

  const simulated = state.modes.paypal === "simulated";
  const workspace: Workspace = { state, busy, queuedId: queued?.actionId ?? null, navigate, approve, reject, run, openReply: setReplyFor, version };
  const link = (to: string, label: string, on: boolean) => (
    <a
      href={to}
      className={on ? "on" : ""}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );
  const decision = path.match(/^\/decisions\/([^/]+)/)?.[1];
  const customer = path.match(/^\/customers\/([^/]+)/)?.[1];

  return (
    <MotionConfig reducedMotion="user">
      <div className="page">
        <header className="top">
          <a className="logo" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}><span className="mark">P</span>PayPromise</a>
          <nav className="nav" aria-label="Main">
            {link("/", "Today", path === "/" || !!decision)}
            {link("/cash", "Cash plan", path === "/cash")}
            {link("/customers", "Customers", path.startsWith("/customers"))}
          </nav>
          <div className="top-right">
            <span className="live"><span className={`dot ${simulated ? "off" : ""}`} />{simulated ? "PayPal simulated" : "PayPal sandbox connected"}</span>
            <span className="live">AI: {state.modes.ai === "claude" ? "Claude" : "offline rules"}</span>
            {!simulated && <button className="btn sm" disabled={busy} onClick={() => run(() => api("/sync", { method: "POST" }))}>Check PayPal</button>}
            <button className="btn sm ghost" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? "Light" : "Dark"}</button>
            <button className="btn primary" onClick={() => setDialog("invoice")}>New invoice</button>
          </div>
        </header>

        {state.modes.demoClock && (
          <div className="demobar">
            <span>
              {switching ? (
                "Creating real invoices on PayPal's sandbox. This takes about 20 seconds..."
              ) : (
                <>
                  {state.workspace.isolated ? "This is your private demo with sample data. " : "Sample data for this demo. "}
                  {simulated ? "PayPal is simulated. " : state.workspace.isolated ? "Its invoices are real PayPal sandbox invoices. " : ""}
                  The app's date is <b>{shortDate(state.today)}</b>.
                </>
              )}
            </span>
            <button className="btn sm" disabled={busy || switching} onClick={() => run(() => api("/demo/advance", { method: "POST", body: { days: 1 } }))}>Next day</button>
            {(simulated || state.workspace.isolated) && <button className="btn sm" disabled={busy || switching} onClick={() => run(async () => { await api("/demo/reset", { method: "POST" }); navigate("/"); })}>Reset demo</button>}
            {simulated && state.workspace.canUseSandbox && <button className="btn sm primary" disabled={busy || switching} onClick={() => void startDemo("sandbox")}>Use real PayPal sandbox</button>}
            {!simulated && state.workspace.isolated && <button className="btn sm" disabled={busy || switching} onClick={() => void startDemo("simulated")}>Use simulated PayPal</button>}
          </div>
        )}

        {error && <div className="notice error" role="alert">{error}</div>}

        {decision ? (
          <Review id={decision} {...workspace} />
        ) : path === "/cash" ? (
          <CashPlan {...workspace} onEditPayroll={() => setDialog("payroll")} />
        ) : path.startsWith("/customers") ? (
          <Customers selected={customer ? decodeURIComponent(customer) : null} {...workspace} />
        ) : (
          <Suspense fallback={<div className="empty">Loading...</div>}><Today {...workspace} onEditPayroll={() => setDialog("payroll")} /></Suspense>
        )}

      </div>

      {queued && <UndoToast key={queued.actionId} title={queued.title} onUndo={() => setQueued(null)} onNow={() => { setQueued(null); void send(queued); }} />}

      <NewInvoiceDialog open={dialog === "invoice"} today={state.today} busy={busy} onClose={() => setDialog(null)} run={run} />
      <PayrollDialog open={dialog === "payroll"} state={state} busy={busy} onClose={() => setDialog(null)} run={run} />
      <ReplyDialog invoice={state.invoices.find((i) => i.id === replyFor) ?? null} busy={busy} simulated={simulated} onClose={() => setReplyFor(null)} run={run} />
    </MotionConfig>
  );
}

function UndoToast({ title, onUndo, onNow }: { title: string; onUndo: () => void; onNow: () => void }) {
  const [left, setLeft] = useState(UNDO_SECONDS);
  useEffect(() => {
    const timer = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="undo" role="status">
      <div className="undo-row">
        <span>{title}, in {left} second{left === 1 ? "" : "s"}</span>
        <button onClick={onNow}>Do it now</button>
        <button onClick={onUndo}>Undo</button>
      </div>
      <div className="bar"><span style={{ transform: `scaleX(${left / UNDO_SECONDS})`, transition: "transform 1s linear" }} /></div>
    </div>
  );
}

function NewInvoiceDialog({ open, today, busy, onClose, run }: { open: boolean; today: string; busy: boolean; onClose: () => void; run: Workspace["run"] }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      customerName: String(data.get("customerName")),
      customerEmail: String(data.get("customerEmail")),
      description: String(data.get("description")),
      amount: Number(data.get("amount")),
      dueDate: String(data.get("dueDate")),
    };
    onClose();
    void run(() => api("/invoices", { method: "POST", body }));
  }
  return (
    <Dialog open={open} onClose={onClose} title="New PayPal invoice">
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <label className="field">Customer<input name="customerName" required maxLength={120} /></label>
        <label className="field">Email<input name="customerEmail" type="email" required /></label>
        <label className="field">Work<input name="description" required maxLength={200} /></label>
        <label className="field">Amount ($)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label className="field">Due<input name="dueDate" type="date" required defaultValue={today} /></label>
        <div className="acts"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Create and send</button></div>
      </form>
    </Dialog>
  );
}

function PayrollDialog({ open, state, busy, onClose, run }: { open: boolean; state: AppState; busy: boolean; onClose: () => void; run: Workspace["run"] }) {
  const { settings } = state;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      obligationLabel: String(data.get("label")),
      businessName: String(data.get("business")),
      targetDate: String(data.get("targetDate")),
      obligation: Number(data.get("obligation")),
      cashOnHand: Number(data.get("cashOnHand")),
    };
    onClose();
    void run(() => api("/settings", { method: "PUT", body }));
  }
  return (
    <Dialog open={open} onClose={onClose} title="What are you saving for?">
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <label className="field">Your business name<input name="business" required maxLength={80} defaultValue={settings.businessName} /></label>
        <label className="field">Bill to cover<input name="label" required maxLength={40} defaultValue={settings.obligationLabel} /></label>
        <label className="field">Date<input name="targetDate" type="date" required defaultValue={settings.targetDate} /></label>
        <label className="field">Amount ($)<input name="obligation" type="number" min="0" step="0.01" required defaultValue={settings.obligation / 100} /></label>
        <label className="field">Cash on hand ($)<input name="cashOnHand" type="number" min="0" step="0.01" required defaultValue={settings.cashOnHand / 100} /></label>
        <div className="acts"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>Save</button></div>
      </form>
    </Dialog>
  );
}

const sampleReplies = (amount: number) => [
  { label: "Promise", text: "Sorry for the delay, cash is tight this month. I will pay the full amount on Friday." },
  { label: "Wrong amount", text: `This looks wrong. We agreed on ${usd(Math.round(amount * 0.009) * 100)} for the job, so the invoice should be ${usd(Math.round(amount * 0.009) * 100)}.` },
  { label: "Partial", text: "I can't pay it all at once. I can do half now and the rest later if that works." },
  { label: "Already paid", text: "We already paid this last week, please check on your side." },
];

function ReplyDialog({ invoice, busy, simulated, onClose, run }: { invoice: AppState["invoices"][number] | null; busy: boolean; simulated: boolean; onClose: () => void; run: Workspace["run"] }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setText("");
    setCopied(false);
  }, [invoice?.id]);
  if (!invoice) return null;
  const id = invoice.id;
  return (
    <Dialog open onClose={onClose} title={invoice.customerName}>
      <form
        style={{ display: "grid", gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          void run(() => api(`/invoices/${id}/replies`, { method: "POST", body: { body: text } }));
        }}
      >
        <label className="field">Paste what the customer wrote<textarea rows={4} maxLength={4000} required value={text} onChange={(e) => setText(e.target.value)} /></label>
        <div className="chips" aria-label="Sample replies">
          {sampleReplies(invoice.amount).map((s) => <button type="button" className="pill" key={s.label} onClick={() => setText(s.text)}>{s.label}</button>)}
        </div>
        <button className="btn primary" disabled={busy || !text.trim()}>Read reply</button>
      </form>
      <div className="row">
        <span className="muted">No reply yet? Let them choose a date.</span>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => { void navigator.clipboard?.writeText(invoice.promiseLink); setCopied(true); }}>{copied ? "Copied" : "Copy customer link"}</button>
        <a className="btn" href={invoice.promiseLink} target="_blank" rel="noreferrer">Preview link</a>
        <button className="btn" disabled={busy} onClick={() => { onClose(); void run(() => api(`/invoices/${id}/ask-for-date`, { method: "POST" })); }}>Ask by PayPal reminder</button>
      </div>
      {simulated && (
        <button className="btn" disabled={busy} onClick={() => { onClose(); void run(() => api("/demo/pay", { method: "POST", body: { invoiceId: id, amount: invoice.balance / 100 } })); }}>
          Simulate full payment
        </button>
      )}
    </Dialog>
  );
}
