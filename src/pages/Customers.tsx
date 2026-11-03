import { useEffect, useState } from "react";
import type { Workspace } from "../App.tsx";
import { api, type CustomerDetail, longDate, shortDate, usd } from "../lib.ts";
import { StatusPill } from "../ui.tsx";

export function Customers({ selected, state, navigate, version, approve, reject, queuedId, busy, run }: Workspace & { selected: string | null }) {
  const email = selected ?? state.customers[0]?.email ?? null;
  const [detail, setDetail] = useState<CustomerDetail | null>(null);

  useEffect(() => {
    if (!email) return;
    api<CustomerDetail>(`/customers/${encodeURIComponent(email)}`).then(setDetail).catch(() => setDetail(null));
  }, [email, version]);

  if (state.customers.length === 0) return <div className="card empty"><b>No customers yet</b>Create an invoice to start a record.</div>;

  return (
    <div className="people">
      <nav className="card people-list" aria-label="Customers">
        {state.customers.map((c) => (
          <a key={c.email} href={`/customers/${encodeURIComponent(c.email)}`} className={c.email === email ? "on" : ""} onClick={(e) => { e.preventDefault(); navigate(`/customers/${encodeURIComponent(c.email)}`); }}>
            <span>{c.name}<small>{usd(c.open)} open</small></span>
            {c.needsAttention && <span className="pill red">Broken</span>}
          </a>
        ))}
      </nav>
      {detail && detail.email === email?.toLowerCase() && <Detail detail={detail} state={state} approve={approve} reject={reject} queuedId={queuedId} busy={busy} run={run} />}
    </div>
  );
}

function Detail({ detail, state, approve, reject, queuedId, busy, run }: { detail: CustomerDetail } & Pick<Workspace, "state" | "approve" | "reject" | "queuedId" | "busy" | "run">) {
  const { record } = detail;
  const total = record.kept + record.broken;
  const notCounted = detail.invoices.some((i) => i.balance > 0 && i.promises.some((p) => p.status === "BROKEN"));
  const reminders = detail.invoices.flatMap((i) => i.pending.filter((a) => a.type === "SEND_REMINDER").map((action) => ({ action, invoice: i })));
  const brokenInvoice = detail.invoices.find((i) => i.balance > 0 && i.promises.some((p) => p.status === "BROKEN"));
  const events = detail.invoices
    .flatMap((i) => i.events.map((e) => ({ ...e, number: i.number })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const simulated = state.modes.paypal === "simulated";

  return (
    <>
      <aside className="card side">
        <div><h1>{detail.name}</h1><span className="muted">{detail.email}</span></div>
        <div>
          <div className="eyebrow">Promises kept</div>
          <div className="score">{total === 0 ? "None yet" : `${record.kept} of ${total}`}</div>
          <div className="dots" style={{ marginTop: 4 }}>
            {Array.from({ length: Math.min(record.kept, 12) }, (_, i) => <i className="k" key={`k${i}`} />)}
            {Array.from({ length: Math.min(record.broken, 12) }, (_, i) => <i className="b" key={`b${i}`} />)}
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>Your own history with this customer{state.modes.demoClock ? ", including sample history" : ""}. It isn't a credit score.</p>
        </div>
        <div>
          <div className="row"><span className="muted">Open balance</span><b>{usd(detail.open)}</b></div>
          <div className="row"><span className="muted">Paid through PayPal</span><b>{usd(detail.paid)}</b></div>
        </div>
        {notCounted && <div className="pill red" style={{ justifyContent: "center", height: 30 }}>Not counted toward {state.settings.obligationLabel.toLowerCase()}</div>}
        {simulated && detail.invoices.filter((i) => i.balance > 0).slice(0, 1).map((i) => (
          <button key={i.id} className="btn" disabled={busy} onClick={() => run(() => api("/demo/pay", { method: "POST", body: { invoiceId: i.id, amount: i.balance / 100 } }))}>Simulate full payment</button>
        ))}
      </aside>

      <section className="card main">
        {reminders.map(({ action, invoice }) => (
          <FollowUp key={action.id} action={action} broken={invoice.id === brokenInvoice?.id} queued={queuedId === action.id} busy={busy} approve={approve} reject={reject} />
        ))}
        {detail.invoices.map((invoice) => (
          <div className="actions" key={invoice.id} style={{ alignItems: "center", marginTop: 14 }}>
            <b>{invoice.number}</b><span className="muted">{invoice.description}</span>
            <span className="muted">{usd(invoice.balance)} of {usd(invoice.amount)} · due {shortDate(invoice.dueDate)}</span>
            <StatusPill risk={invoice.risk} />
            <span style={{ marginLeft: "auto" }} className="actions">
              {invoice.payUrl && <a className="btn sm" href={invoice.payUrl} target="_blank" rel="noreferrer">PayPal invoice</a>}
              {invoice.balance > 0 && <a className="btn sm" href={invoice.promiseLink} target="_blank" rel="noreferrer">Customer link</a>}
            </span>
          </div>
        ))}
        <ul className="tl" aria-label="History">
          {events.map((e) => {
            const bad = /^Promise broken|^Failed/.test(e.text);
            const good = /^Promise kept|^PayPal confirmed|^Simulated PayPal payment/.test(e.text);
            return (
              <li key={e.id} className={bad ? "bad" : good ? "good" : ""}>
                <time>{shortDate(e.day ?? e.createdAt.slice(0, 10))}</time>
                <div>{e.text}</div>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function FollowUp({ action, broken, queued, busy, approve, reject }: { action: CustomerDetail["invoices"][number]["pending"][number]; broken: boolean; queued: boolean; busy: boolean } & Pick<Workspace, "approve" | "reject">) {
  const [note, setNote] = useState(action.payload.note ?? "");
  const { dueDate } = action.payload;
  return (
    <div className={`alert ${broken ? "" : "plain"}`}>
      <h2>{broken ? "A promise was broken" : action.title}</h2>
      <p>{action.rationale}{dueDate ? ` (${longDate(dueDate)})` : ""}</p>
      <label className="field">Message to send through PayPal<textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="acts">
        <button className="btn" disabled={busy || queued} onClick={() => reject(action.id)}>Not now</button>
        <button className="btn primary" disabled={busy || queued || !note.trim()} onClick={() => approve(action.id, "Sending follow-up", note)}>{queued ? "Waiting..." : "Send follow-up"}</button>
      </div>
    </div>
  );
}
