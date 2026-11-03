import { type FormEvent, useEffect, useMemo, useState } from "react";
import { dateRange } from "../../server/plan.ts";
import { api, dueNote, longDate, type PublicInvoice, shortDate, usd, weekday } from "../lib.ts";

type Step = "menu" | "date" | "partial" | "dispute" | "paid" | "done";

export function PromiseLink({ token }: { token: string }) {
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [step, setStep] = useState<Step>("menu");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Payment options";
    api<PublicInvoice>(`/public/promises/${encodeURIComponent(token)}`).then(setInvoice).catch((e) => setError(e.message));
  }, [token]);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/public/promises/${encodeURIComponent(token)}`, { method: "POST", body });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!invoice) {
    return <main className="promise-page"><div className="promise"><p className="muted" role={error ? "alert" : undefined}>{error ?? "Loading..."}</p></div></main>;
  }
  const back = <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => { setError(null); setStep("menu"); }}>Back</button>;
  const from = <div className="from"><span className="av">{invoice.businessName.slice(0, 1).toUpperCase()}</span>{invoice.businessName}</div>;

  return (
    <main className="promise-page">
      <div className="promise">
        {from}
        {error && <div className="notice error" role="alert" style={{ margin: 0 }}>{error}</div>}
        {invoice.balance === 0 ? (
          <><div className="done">✓</div><h2>Nothing left to pay</h2><p className="muted">Invoice {invoice.number} is settled. Thank you.</p></>
        ) : step === "menu" ? (
          <Menu invoice={invoice} setStep={setStep} />
        ) : step === "date" ? (
          <DateStep invoice={invoice} busy={busy} back={back} send={send} />
        ) : step === "partial" ? (
          <PartialStep invoice={invoice} busy={busy} back={back} send={send} />
        ) : step === "dispute" ? (
          <DisputeStep busy={busy} back={back} send={send} />
        ) : step === "paid" ? (
          <>
            {back}
            <h2>You've already paid?</h2>
            <p className="muted">{invoice.businessName} will check PayPal's record for this invoice.</p>
            <button className="btn primary lg" disabled={busy} onClick={() => send({ choice: "PAID" })}>Ask them to check</button>
          </>
        ) : (
          <><div className="done">✓</div><h2>Thank you</h2><p className="muted">{invoice.businessName} has your answer and will review it. Nothing on the invoice changes until they do.</p></>
        )}
        <div className="foot">No account or sign-in needed. {invoice.businessName} sees what you send here.</div>
      </div>
    </main>
  );
}

function Menu({ invoice, setStep }: { invoice: PublicInvoice; setStep: (s: Step) => void }) {
  return (
    <>
      <div>
        <div className="eyebrow">Invoice {invoice.number} · {dueNote(invoice.dueDate, invoice.today)}</div>
        <div className="amt">{usd(invoice.balance)}</div>
        <div className="muted">{invoice.description}</div>
      </div>
      <h2>What works for you?</h2>
      {invoice.payUrl ? <a className="btn primary lg" href={invoice.payUrl}>Pay now on PayPal</a> : <div className="notice warn small">Paying isn't available in this demo mode.</div>}
      <button className="opt" onClick={() => setStep("date")}>Pick a date to pay<small>Tell them when to expect it</small></button>
      <button className="opt" onClick={() => setStep("partial")}>Pay part now<small>Ask to pay in parts</small></button>
      <button className="opt" onClick={() => setStep("dispute")}>Something looks wrong<small>Question the amount or the work</small></button>
      <button className="opt" onClick={() => setStep("paid")}>I already paid<small>They'll check PayPal's record</small></button>
    </>
  );
}

function DateStep({ invoice, busy, back, send }: { invoice: PublicInvoice; busy: boolean; back: React.ReactNode; send: (b: Record<string, unknown>) => void }) {
  const days = useMemo(() => dateRange(invoice.today, invoice.latestDate).slice(1, 8), [invoice.today, invoice.latestDate]);
  const [date, setDate] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  return (
    <>
      {back}
      <h2>When can you pay {usd(invoice.balance)}?</h2>
      <div className="days" role="group" aria-label="Payment date">
        {days.map((d) => (
          <button key={d} className={`day ${date === d && !other ? "on" : ""}`} aria-pressed={date === d && !other} onClick={() => { setDate(d); setOther(false); }}>
            {weekday(d)}<small>{shortDate(d)}</small>
          </button>
        ))}
        <button className={`day ${other ? "on" : ""}`} aria-pressed={other} onClick={() => { setOther(true); setDate(null); }}>Other<small>Choose</small></button>
      </div>
      {other && <label className="field">Date<input type="date" min={invoice.today} max={invoice.latestDate} value={date ?? ""} onChange={(e) => setDate(e.target.value || null)} /></label>}
      <label className="field">Add a note (optional)<textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <button className="btn primary lg" disabled={busy || !date} onClick={() => send({ choice: "DATE", date, ...(note.trim() ? { note: note.trim() } : {}) })}>
        {date ? `Promise to pay on ${longDate(date)}` : "Choose a date"}
      </button>
    </>
  );
}

function PartialStep({ invoice, busy, back, send }: { invoice: PublicInvoice; busy: boolean; back: React.ReactNode; send: (b: Record<string, unknown>) => void }) {
  const half = Math.ceil(invoice.balance / 2) / 100;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const date = String(data.get("date"));
    const note = String(data.get("note")).trim();
    send({ choice: "PARTIAL", amount: Number(data.get("amount")), ...(date ? { date } : {}), ...(note ? { note } : {}) });
  }
  return (
    <form onSubmit={submit} style={{ display: "contents" }}>
      {back}
      <h2>How much can you pay first?</h2>
      <label className="field">First payment ($)<input name="amount" type="number" min="1" max={invoice.balance / 100} step="0.01" required defaultValue={half} /></label>
      <label className="field">When? (optional)<input name="date" type="date" min={invoice.today} max={invoice.latestDate} /></label>
      <label className="field">Add a note (optional)<textarea name="note" rows={3} maxLength={500} /></label>
      <button className="btn primary lg" disabled={busy}>Ask to pay in parts</button>
    </form>
  );
}

function DisputeStep({ busy, back, send }: { busy: boolean; back: React.ReactNode; send: (b: Record<string, unknown>) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const corrected = Number(data.get("corrected"));
    send({ choice: "DISPUTE", note: String(data.get("note")).trim(), ...(corrected > 0 ? { correctedAmount: corrected } : {}) });
  }
  return (
    <form onSubmit={submit} style={{ display: "contents" }}>
      {back}
      <h2>What looks wrong?</h2>
      <label className="field">Tell them what's wrong<textarea name="note" rows={4} maxLength={500} required /></label>
      <label className="field">What should the total be? (optional)<input name="corrected" type="number" min="0.01" step="0.01" /></label>
      <button className="btn primary lg" disabled={busy}>Send</button>
    </form>
  );
}
