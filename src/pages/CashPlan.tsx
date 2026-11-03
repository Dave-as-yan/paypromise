import { useMemo, useState } from "react";
import { dateRange, planDate, planShortfall, runningCash } from "../../server/plan.ts";
import type { Workspace } from "../App.tsx";
import { shortDate, usd, weekday } from "../lib.ts";
import { Switch } from "../ui.tsx";

type Item = Workspace["state"]["plan"][number];

const KIND_LABEL: Record<Item["kind"], string> = {
  PROMISED: "promised",
  OVERDUE: "overdue, no promise",
  NOT_DUE: "due, no promise",
  DISPUTED: "disputed",
  BROKEN: "broken promise",
};

export function CashPlan({ state, onEditPayroll }: Workspace & { onEditPayroll: () => void }) {
  const { forecast: f, plan, settings, today } = state;
  // Switches hold only differences from the real plan, so fresh PayPal data still flows in.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const enabled = (item: Item) => overrides[item.id] ?? item.counted;

  const items = plan.filter((i) => !i.afterTarget);
  const later = plan.filter((i) => i.afterTarget);
  const days = useMemo(() => dateRange(today, f.targetDate < today ? today : f.targetDate), [today, f.targetDate]);
  const running = runningCash(f.cashOnHand, items, enabled, today, days);
  const gap = planShortfall(f.cashOnHand, f.obligation, items, enabled);
  const baseGap = planShortfall(f.cashOnHand, f.obligation, items, (i) => i.counted);
  const changed = items.filter((i) => enabled(i) !== i.counted);

  const question =
    changed.length === 0
      ? `Today's plan for ${settings.obligationLabel.toLowerCase()} on ${shortDate(f.targetDate)}`
      : changed.length === 1
        ? `What if ${changed[0].customerName} ${enabled(changed[0]) ? "pays" : "doesn't pay"}?`
        : `What if these ${changed.length} changes happen?`;
  const describe = (value: number) => (value > 0 ? `${usd(value)} short` : `covered, with ${usd(-value)} left`);
  const counted = items.filter(enabled).reduce((sum, i) => sum + i.amount, 0);

  return (
    <>
      <section className="card sum" aria-label="Cash plan result">
        <div style={{ flex: "1 1 320px" }}>
          <div className="eyebrow">{question}</div>
          <div className={`big ${gap > 0 ? "red" : "green"}`} style={{ marginTop: 6 }}>{gap > 0 ? `${usd(gap)} short` : "Covered"}</div>
          <p className="muted" style={{ marginTop: 6 }}>
            {changed.length > 0 ? `Today's plan has you ${describe(baseGap)}.` : "Only reliable promises count. Switch customers below to test other outcomes."}
          </p>
        </div>
        <div className="eq">
          <div><span className="eyebrow">Cash</span><b>{usd(f.cashOnHand)}</b></div><span className="muted">+</span>
          <div><span className="eyebrow">Counted</span><b>{usd(counted)}</b></div><span className="muted">−</span>
          <div><span className="eyebrow">{settings.obligationLabel}</span><b>{usd(f.obligation)}</b></div>
        </div>
        <div className="actions">
          {changed.length > 0 && <button className="btn sm" onClick={() => setOverrides({})}>Reset what-if</button>}
          <button className="btn sm" onClick={onEditPayroll}>Edit {settings.obligationLabel.toLowerCase()}</button>
        </div>
      </section>

      <section className="card week" aria-label="Cash by day" tabIndex={0}>
        {days.map((day, index) => {
          const last = index === days.length - 1;
          const onDay = items.filter((i) => planDate(i, today) === day);
          const after = running[index].cash - f.obligation;
          return (
            <div className={`dayc ${gap <= 0 ? "fine" : ""}`} key={day}>
              <div className="dn">{weekday(day)} <small>{shortDate(day)}</small></div>
              {onDay.map((item) => (
                <div className={`ev ${enabled(item) ? "on" : item.counted ? "off" : ""}`} key={item.id}>
                  {item.customerName}
                  <span>{usd(item.amount)} {KIND_LABEL[item.kind]}</span>
                </div>
              ))}
              {last && <div className={`ev pay ${gap <= 0 ? "fine" : ""}`}>{settings.obligationLabel}<span>−{usd(f.obligation)}</span></div>}
              <div className={`run ${last && after < 0 ? "red" : ""}`}>
                {last ? `${after < 0 ? "−" : ""}${usd(Math.abs(after))}` : usd(running[index].cash)}
                <small>{last ? `after ${settings.obligationLabel.toLowerCase()}` : "running cash"}</small>
              </div>
            </div>
          );
        })}
      </section>

      <section className="card scen">
        <h2>Try it: switch customers on and off</h2>
        <p className="muted">Only what's switched on counts toward {settings.obligationLabel.toLowerCase()}. What-if never changes anything on PayPal.</p>
        {items.length === 0 && <div className="empty">No open invoices are due by this date.</div>}
        {items.map((item) => (
          <div className="s" key={item.id}>
            <Switch checked={enabled(item)} onChange={(next) => setOverrides((v) => ({ ...v, [item.id]: next }))} label={`Count ${item.customerName}`} />
            <b>{item.customerName}</b>
            <span>{usd(item.amount)} {item.kind === "PROMISED" ? `by ${shortDate(item.date)}` : KIND_LABEL[item.kind]}</span>
            <span className="muted">{item.record.kept + item.record.broken === 0 ? "New customer" : `Kept ${item.record.kept} of ${item.record.kept + item.record.broken}`}</span>
            <span className="muted">{enabled(item) ? "Counted" : `+${usd(item.amount)} if paid`}</span>
          </div>
        ))}
        {later.length > 0 && <p className="muted small" style={{ padding: "10px 18px 14px" }}>Due after this date: {later.map((i) => `${i.customerName} ${usd(i.amount)}`).join(", ")}.</p>}
      </section>
    </>
  );
}
