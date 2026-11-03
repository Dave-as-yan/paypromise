import { useEffect, useState } from "react";
import type { Workspace } from "../App.tsx";
import { type Decision, longDate, shortDate, usd } from "../lib.ts";
import { certainty } from "../lib.ts";
import { Quote } from "../ui.tsx";

const HEADINGS: Record<string, string> = {
  TRACK_PROMISE: "The customer made a promise",
  ALLOW_PARTIAL: "The customer wants to pay in parts",
  CORRECT_INVOICE: "The customer says the invoice is wrong",
  VERIFY_PAYMENT: "The customer says it's already paid",
  SEND_REMINDER: "This customer needs a message",
  REVIEW: "This reply needs your eye",
};

const INTENTS: Record<string, string> = {
  PROMISE_TO_PAY: "Promises to pay",
  PARTIAL_PAYMENT_REQUEST: "Asks to pay in parts",
  AMOUNT_DISPUTE: "Disputes the amount",
  ALREADY_PAID: "Says it's already paid",
  NEEDS_INFO: "Needs information",
  REFUSAL: "Refuses to pay",
  OTHER: "Unclear",
};

export function Review({ id, state, navigate, approve, reject, queuedId, busy }: Workspace & { id: string }) {
  const { decisions } = state;
  const index = decisions.findIndex((d) => d.action.id === id);
  const decision = decisions[index];
  const [note, setNote] = useState(decision?.action.payload.note ?? "");
  useEffect(() => setNote(decision?.action.payload.note ?? ""), [id]);

  useEffect(() => {
    if (!decision) navigate(decisions[0] ? `/decisions/${decisions[0].action.id}` : "/");
  }, [decision, decisions, navigate]);

  useEffect(() => {
    if (!decision || queuedId === id) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || /INPUT|TEXTAREA|BUTTON|A/.test(target.tagName)) return;
      if (decision.action.type === "REVIEW") return;
      if (event.key.toLowerCase() === "a") approve(decision.action.id, decision.action.title, note || undefined);
      if (event.key.toLowerCase() === "r") reject(decision.action.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decision, queuedId, id, approve, reject, note]);

  if (!decision) return null;
  const { action, invoice, reply, impact } = decision;
  const queued = queuedId === id;
  const tag = certainty(decision);
  const reminder = action.type === "SEND_REMINDER";
  const previous = decisions[index - 1];
  const next = decisions[index + 1];

  return (
    <>
      <div className="actions" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <button className="btn sm" onClick={() => navigate("/")}>Back to Today</button>
        <div className="actions" style={{ alignItems: "center" }}>
          <span className="muted small">Decision {index + 1} of {decisions.length}</span>
          <button className="btn sm" disabled={!previous} onClick={() => navigate(`/decisions/${previous.action.id}`)}>Previous</button>
          <button className="btn sm" disabled={!next} onClick={() => navigate(`/decisions/${next.action.id}`)}>Next</button>
        </div>
      </div>
      <div className="review">
        <section className="card sec">
          <div>
            <div className="eyebrow">{invoice.customerName} · {invoice.description} · {invoice.number}</div>
            <h1 style={{ marginTop: 4 }}>{HEADINGS[action.type]}</h1>
          </div>
          {reply ? (
            <>
              <h2>{reply.source === "customer" ? "What the customer chose" : "What the customer wrote"}</h2>
              <Quote text={reply.body} evidence={reply.analysis.evidence} />
              <h2>{reply.source === "customer" ? "How it was recorded" : "How it was read"}</h2>
              <dl className="read">
                <dt>Meaning</dt><dd>{INTENTS[reply.analysis.intent]}</dd>
                {reply.analysis.promisedDate && <><dt>Date</dt><dd>{longDate(reply.analysis.promisedDate)}</dd></>}
                {reply.analysis.correctedAmount != null && <><dt>Their figure</dt><dd>${reply.analysis.correctedAmount.toLocaleString("en-US")}</dd></>}
                <dt>Certainty</dt><dd><span className={`pill ${tag.tone}`}>{tag.label}</span></dd>
                <dt>Read by</dt><dd>{reply.source === "claude" ? "Claude. Treated as untrusted text" : reply.source === "customer" ? "The customer's form. No AI used" : "Offline rules. Treated as untrusted text"}</dd>
              </dl>
              {reply.notice && <div className="notice warn">{reply.notice}</div>}
              {!reminder && reply.analysis.draftReply && (
                <>
                  <h2>Suggested reply to the customer</h2>
                  <div className="draft">{reply.analysis.draftReply}</div>
                  <div><button className="btn sm" onClick={() => void navigator.clipboard?.writeText(reply.analysis.draftReply)}>Copy reply</button></div>
                </>
              )}
            </>
          ) : (
            <>
              <h2>Why this is here</h2>
              <p>{action.rationale}</p>
            </>
          )}
        </section>

        <section className="card sec">
          <h2>{action.type === "TRACK_PROMISE" || action.type === "REVIEW" ? "What changes" : "What changes on PayPal if you approve"}</h2>
          <Change decision={decision} note={note} onNote={setNote} />
          {action.warnings.map((w) => <div className="notice warn" key={w}>{w}</div>)}
          {action.type === "CORRECT_INVOICE" && <div className="notice warn">Only the customer claims this figure. Check your quote first.</div>}
          {action.type !== "REVIEW" && (
            <>
              <h2>What happens next</h2>
              <div className="steps">
                <div className="step"><i>1</i><span>You get 10 seconds to undo.</span></div>
                <div className="step"><i>2</i><span>{action.type === "TRACK_PROMISE" ? `PayPromise starts tracking this and checks PayPal after ${action.payload.dueDate ? shortDate(action.payload.dueDate) : "the date"}.` : `PayPromise updates ${invoice.number} through PayPal.`}</span></div>
                <div className="step"><i>3</i><span>This shows as done only after it succeeds.</span></div>
              </div>
            </>
          )}
          <h2>Effect on {state.settings.obligationLabel.toLowerCase()}</h2>
          <Effect decision={decision} />
          <div className="actions">
            {action.type === "REVIEW" ? (
              <button className="btn primary tall" disabled={busy || queued} onClick={() => approve(action.id, "Marking as reviewed")}>Mark as reviewed</button>
            ) : (
              <>
                <button className="btn tall" disabled={busy || queued} onClick={() => reject(action.id)}>Reject <kbd>R</kbd></button>
                <button className="btn primary tall" disabled={busy || queued || (reminder && !note.trim())} onClick={() => approve(action.id, action.title, note || undefined)}>{queued ? "Waiting..." : action.title} <kbd>A</kbd></button>
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Change({ decision, note, onNote }: { decision: Decision; note: string; onNote: (next: string) => void }) {
  const { action, invoice } = decision;
  const { payload } = action;
  switch (action.type) {
    case "CORRECT_INVOICE":
      return (
        <div className="diff">
          <div className="old"><span className="eyebrow">Now</span><b>{usd(invoice.amount)}</b></div>
          <span className="muted" aria-hidden>→</span>
          <div><span className="eyebrow">After</span><b>{usd(payload.newAmount!)}</b></div>
        </div>
      );
    case "ALLOW_PARTIAL":
      return (
        <div className="diff">
          <div className="old"><span className="eyebrow">Now</span><b>Full only</b></div>
          <span className="muted" aria-hidden>→</span>
          <div><span className="eyebrow">Minimum after</span><b>{usd(payload.minimumDue!)}</b></div>
        </div>
      );
    case "TRACK_PROMISE":
      return (
        <div className="diff">
          <div><span className="eyebrow">Expected</span><b>{usd(payload.amount!)}</b></div>
          <span className="muted" aria-hidden>·</span>
          <div><span className="eyebrow">By</span><b>{longDate(payload.dueDate!)}</b></div>
        </div>
      );
    case "SEND_REMINDER":
      return <label className="field">Message to send through PayPal<textarea rows={5} maxLength={1000} value={note} onChange={(e) => onNote(e.target.value)} /></label>;
    case "VERIFY_PAYMENT":
      return <p>PayPromise reads PayPal's record for {invoice.number}. Nothing is changed, and the customer's message isn't treated as proof.</p>;
    default:
      return <p>{action.rationale} Nothing changes on PayPal.</p>;
  }
}

function Effect({ decision }: { decision: Decision }) {
  const { impact } = decision;
  if (impact.shortfallAfter < impact.shortfallBefore) {
    return <p><b className="red">{usd(impact.shortfallBefore)} short</b> becomes <b className="green">{impact.shortfallAfter === 0 ? "covered" : `${usd(impact.shortfallAfter)} short`}</b>.</p>;
  }
  return (
    <p>
      {impact.shortfallBefore > 0 ? <>Still <b className="red">{usd(impact.shortfallBefore)} short</b>.</> : "Still covered."}
      {impact.bestCaseChange < 0 && ` If every open invoice is paid, you would collect ${usd(-impact.bestCaseChange)} less.`}
    </p>
  );
}
