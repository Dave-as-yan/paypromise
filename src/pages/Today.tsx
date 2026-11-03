import { type ColDef, type GridApi, type ICellRendererParams, AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { AnimatePresence, animate, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { dateRange, planDate, runningCash } from "../../server/plan.ts";
import type { Workspace } from "../App.tsx";
import { certainty, daysBetween, type Decision, dueNote, impactNote, type InvoiceRow, longDate, shortDate, usd } from "../lib.ts";
import { KeptDots, Quote, StatusPill } from "../ui.tsx";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "var(--accent)",
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  borderColor: "var(--line)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--muted)",
  fontFamily: "inherit",
  fontSize: 14,
  headerFontSize: 12,
  headerFontWeight: 600,
  rowHoverColor: "var(--surface-2)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  cellHorizontalPadding: 16,
});

export function CountUp({ cents }: { cents: number }) {
  const [shown, setShown] = useState(cents);
  const previous = useRef(cents);
  useEffect(() => {
    const controls = animate(previous.current, cents, { duration: 0.6, ease: "easeOut", onUpdate: (v) => setShown(Math.round(v / 100) * 100) });
    previous.current = cents;
    return () => controls.stop();
  }, [cents]);
  return <>{usd(shown)}</>;
}

export function Today(props: Workspace & { onEditPayroll: () => void }) {
  return (
    <div className="today">
      <Hero {...props} />
      <Inbox {...props} />
      <InvoiceConsole {...props} />
    </div>
  );
}

function Hero({ state, onEditPayroll }: Workspace & { onEditPayroll: () => void }) {
  const { forecast: f, settings, today, decisions, plan } = state;
  const short = f.shortfall > 0;
  const days = daysBetween(today, f.targetDate);
  const best = decisions.find((d) => d.impact.shortfallAfter < d.impact.shortfallBefore);

  const broken = state.invoices.find((i) => i.risk === "BROKEN");
  const headline = !short
    ? "Cash and reliable promises cover this date."
    : broken
      ? `${broken.customerName}'s promise was broken, so ${usd(broken.balance)} no longer counts.`
      : best
      ? `${decisions.length} ${decisions.length === 1 ? "decision is" : "decisions are"} waiting. Approving ${best.invoice.customerName}'s promise cuts this to ${usd(best.impact.shortfallAfter)}.`
      : f.shortfallIfRiskPays === 0
        ? "You're covered only if customers without a promise pay on time."
        : `Still ${usd(f.shortfallIfRiskPays)} short even if every open invoice is paid.`;

  return (
    <section className="card hero" aria-label="Payroll forecast">
      <div className="hero-head">
        <div style={{ flex: "1 1 320px" }}>
          <div className="eyebrow">
            {settings.obligationLabel} of {usd(f.obligation)} is due {longDate(f.targetDate)}, {days <= 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}
            {" · "}<button className="muted small" style={{ background: "none", border: 0, padding: 0, textDecoration: "underline" }} onClick={onEditPayroll}>Edit</button>
          </div>
          <div className={`big ${short ? "red" : "green"}`} style={{ marginTop: 6 }}>
            {short ? <><CountUp cents={f.shortfall} /> short</> : "Covered"}
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{headline}</p>
        </div>
        <div className="facts">
          <div><span className="eyebrow">Cash</span><b>{usd(f.cashOnHand)}</b></div>
          <div><span className="eyebrow">Promised</span><b>{usd(f.promised)}</b></div>
          <div><span className="eyebrow">Not promised</span><b>{usd(f.atRisk)}</b></div>
        </div>
      </div>
      <ForecastChart today={today} target={f.targetDate} cash={f.cashOnHand} obligation={f.obligation} label={settings.obligationLabel} plan={plan} best={best} />
    </section>
  );
}

function ForecastChart({ today, target, cash, obligation, label, plan, best }: {
  today: string;
  target: string;
  cash: number;
  obligation: number;
  label: string;
  plan: Workspace["state"]["plan"];
  best: Decision | undefined;
}) {
  const data = useMemo(() => {
    const days = dateRange(today, target < today ? today : target);
    const counted = runningCash(cash, plan, (i) => i.counted, today, days);
    const all = runningCash(cash, plan, () => true, today, days);
    const gain = best ? best.impact.shortfallBefore - best.impact.shortfallAfter : 0;
    const on = best?.action.payload.dueDate;
    return days.map((day, i) => ({
      day,
      label: shortDate(day),
      counted: counted[i].cash / 100,
      range: [counted[i].cash / 100, all[i].cash / 100] as [number, number],
      projected: gain > 0 && on ? (counted[i].cash + (day >= planDate({ date: on }, today) ? gain : 0)) / 100 : null,
    }));
  }, [today, target, cash, plan, best]);

  const last = data.at(-1)!;
  const top = Math.max(obligation / 100, ...data.map((d) => d.range[1])) * 1.08;
  const gap = obligation / 100 - last.counted;

  return (
    <>
      <div className="chart" role="img" aria-label={`Cash forecast until ${shortDate(target)}. ${usd(last.counted * 100)} counted against ${usd(obligation)}.`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 18, left: 12, bottom: 0 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted)" }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis hide domain={[0, top]} />
            <Area type="stepAfter" dataKey="range" stroke="none" fill="var(--chart-band)" fillOpacity={0.85} isAnimationActive={false} />
            <ReferenceLine y={obligation / 100} stroke="var(--ink)" strokeDasharray="5 5" label={{ value: `${label} ${usd(obligation)}`, position: "insideTopLeft", fill: "var(--ink)", fontWeight: 700 }} />
            {gap > 0 && (
              <ReferenceLine
                stroke="var(--danger)"
                strokeWidth={1.5}
                segment={[{ x: last.label, y: last.counted }, { x: last.label, y: obligation / 100 }]}
                label={{ value: `${usd(gap * 100)} short`, position: "insideLeft", fill: "var(--danger)", fontWeight: 700, dx: -92, dy: -16 }}
              />
            )}
            <Line type="stepAfter" dataKey="projected" stroke="var(--accent)" strokeWidth={2.5} strokeDasharray="6 5" dot={false} connectNulls={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="counted" stroke="var(--danger)" strokeWidth={3} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="legend">
        <span><i />Cash and reliable promises: {usd(last.counted * 100)}</span>
        {last.projected != null && <span><i className="plan" />If you approve {best?.invoice.customerName}: {usd(last.projected * 100)}</span>}
        <span><i className="band" />If every open invoice is paid: {usd(last.range[1] * 100)}</span>
      </div>
    </>
  );
}

function Inbox({ state, navigate, approve, queuedId, busy }: Workspace) {
  const { decisions } = state;
  return (
    <aside className="card inbox" aria-label="Decisions">
      <div className="inbox-head">
        <h2>Needs your decision{decisions.length > 0 && <span className="count">{decisions.length}</span>}</h2>
        <span className="small muted">Nothing happens until you approve</span>
      </div>
      {decisions.length === 0 && <div className="empty"><b>You're up to date</b>New replies and broken promises will appear here.</div>}
      <AnimatePresence initial={false} mode="popLayout">
        {decisions.slice(0, 3).map((decision, index) => (
          <motion.article key={decision.action.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: queuedId === decision.action.id ? 0.5 : 1, y: 0 }} exit={{ opacity: 0, x: 24 }} className={`prop ${index === 0 ? "first" : ""}`}>
            <DecisionCard decision={decision} primary={index === 0} queued={queuedId === decision.action.id} busy={busy} navigate={navigate} approve={approve} />
          </motion.article>
        ))}
      </AnimatePresence>
      {decisions.length > 3 && <button className="btn" onClick={() => navigate(`/decisions/${decisions[3].action.id}`)}>{decisions.length - 3} more</button>}
    </aside>
  );
}

function DecisionCard({ decision, primary, queued, busy, navigate, approve }: { decision: Decision; primary: boolean; queued: boolean; busy: boolean } & Pick<Workspace, "navigate" | "approve">) {
  const { action, invoice, reply } = decision;
  const tag = certainty(decision);
  const note = impactNote(decision);
  const quote = reply?.analysis.evidence && reply.body.includes(reply.analysis.evidence) ? reply.analysis.evidence : reply?.body;

  useEffect(() => {
    if (!primary || queued || action.type === "REVIEW") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "a") return;
      if (/INPUT|TEXTAREA|BUTTON|A/.test(target.tagName) || document.querySelector(".dialog")) return;
      approve(action.id, action.title);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary, queued, action.id, action.title, action.type, approve]);

  return (
    <>
      <div className="prop-top"><span>{invoice.customerName}</span><span className={`pill ${tag.tone}`}>{tag.label}</span></div>
      {quote && <Quote text={quote} evidence={reply?.analysis.evidence} />}
      <div className="prop-what">{action.title}</div>
      <div className="prop-foot">
        <span className={`impact ${note.good ? "green" : "muted"}`}>{note.text}</span>
        <button className="btn sm" onClick={() => navigate(`/decisions/${action.id}`)}>Details</button>
        {action.type !== "REVIEW" && (
          <button className="btn sm primary" disabled={queued || busy} onClick={() => approve(action.id, action.title)}>
            Approve{primary && <kbd>A</kbd>}
          </button>
        )}
      </div>
    </>
  );
}

// The evidence row sits right after its invoice, as a full-width row.
type GridRow = (InvoiceRow & { kind?: "invoice" }) | { kind: "evidence"; id: string; customerName: string; source: InvoiceRow } | { kind: "total"; id: string; customerName: string; balance: number };

function InvoiceConsole({ state, navigate, openReply }: Workspace) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const grid = useRef<GridApi | null>(null);
  const today = state.today;
  // Pinned columns would leave no room to scroll on a phone.
  const narrow = window.innerWidth < 1000;

  const open = state.invoices.filter((i) => i.balance > 0);
  const counts = {
    decide: state.invoices.filter((i) => i.pending > 0).length,
    overdue: state.invoices.filter((i) => i.risk === "OVERDUE" || i.risk === "BROKEN").length,
    notDue: state.invoices.filter((i) => i.risk === "ON_TRACK").length,
  };
  const rows = useMemo<GridRow[]>(() => {
    const matching = state.invoices.filter((i) =>
      filter === "decide" ? i.pending > 0 : filter === "overdue" ? i.risk === "OVERDUE" || i.risk === "BROKEN" : filter === "notDue" ? i.risk === "ON_TRACK" : true,
    );
    return matching.flatMap((i): GridRow[] => (i.id === expanded ? [i, { kind: "evidence", id: `${i.id}:evidence`, customerName: i.customerName, source: i }] : [i]));
  }, [state.invoices, filter, expanded]);

  const totals = useMemo<GridRow[]>(
    () => [{
      kind: "total",
      id: "total",
      customerName: `${open.length} open invoice${open.length === 1 ? "" : "s"}`,
      balance: open.reduce((sum, i) => sum + i.balance, 0),
    }],
    [state.invoices],
  );

  const columns = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        field: "customerName",
        headerName: "Customer",
        flex: 2.2,
        minWidth: 220,
        pinned: narrow ? undefined : "left",
        cellRenderer: ({ data }: ICellRendererParams<GridRow>) =>
          data?.kind === "total" ? <div className="cell-center"><b>{data.customerName}</b></div> : data && data.kind !== "evidence" ? (
            <div className="cell-center">
              <button className="expand" aria-label={`Show latest reply from ${data.customerName}`} aria-expanded={expanded === data.id} onClick={() => setExpanded((v) => (v === data.id ? null : data.id))}>{expanded === data.id ? "▾" : "▸"}</button>
              <div className="cell-stack"><b>{data.customerName}</b><span>{data.description}</span></div>
            </div>
          ) : null,
      },
      { field: "balance", headerName: "Balance", flex: 0.9, minWidth: 110, headerClass: "ag-right-aligned-header", enableCellChangeFlash: true, valueFormatter: (p) => (p.value == null ? "" : usd(p.value)), cellClass: "cell-money" },
      {
        field: "dueDate",
        headerName: "Due",
        flex: 1,
        minWidth: 120,
        cellRenderer: ({ data }: ICellRendererParams<GridRow>) =>
          data && data.kind !== "total" && data.kind !== "evidence" ? <div className="cell-stack"><div>{shortDate(data.dueDate)}</div><span>{data.balance > 0 ? dueNote(data.dueDate, today) : "Settled"}</span></div> : null,
      },
      { field: "risk", headerName: "Status", flex: 1, minWidth: 140, enableCellChangeFlash: true, cellRenderer: ({ data }: ICellRendererParams<GridRow>) => (data && data.kind !== "total" && data.kind !== "evidence" ? <div className="cell-center"><StatusPill risk={data.risk} /></div> : null) },
      { field: "promiseDate", headerName: "Promise", flex: 0.9, minWidth: 110, enableCellChangeFlash: true, valueFormatter: (p) => (p.data?.kind === "total" ? "" : p.value ? shortDate(p.value) : "None yet") },
      {
        headerName: "Promises kept",
        flex: 1,
        minWidth: 140,
        valueGetter: (p) => (p.data && "record" in p.data ? `${p.data.record.kept} of ${p.data.record.kept + p.data.record.broken}` : ""),
        cellRenderer: ({ data }: ICellRendererParams<GridRow>) => (data && "record" in data ? <div className="cell-center"><KeptDots {...data.record} /></div> : null),
      },
      {
        headerName: "Next step",
        width: 140,
        pinned: narrow ? undefined : "right",
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<GridRow>) => {
          if (!data || data.kind === "total" || data.kind === "evidence") return null;
          if (data.pendingActionId) return <div className="cell-center"><button className="btn sm primary" onClick={() => navigate(`/decisions/${data.pendingActionId}`)}>Review</button></div>;
          if (data.balance === 0) return <div className="cell-center muted small">Nothing to do</div>;
          return <div className="cell-center"><button className="btn sm" onClick={() => openReply(data.id)}>Add reply</button></div>;
        },
      },
    ],
    [expanded, navigate, openReply, today, narrow],
  );

  return (
    <section className="card console" aria-label="Invoices">
      <div className="console-bar">
        <h2>All invoices</h2>
        <input aria-label="Search invoices" placeholder="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="chips">
          {[["all", `All ${state.invoices.length}`], ["decide", `Needs decision ${counts.decide}`], ["overdue", `Overdue ${counts.overdue}`], ["notDue", `Not due ${counts.notDue}`]].map(([key, label]) => (
            <button key={key} className={`pill ${filter === key ? "on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        <span style={{ marginLeft: "auto" }} />
        <button className="btn sm" onClick={() => grid.current?.exportDataAsCsv({ fileName: "paypromise-invoices.csv", shouldRowBeSkipped: (p) => p.node.data?.kind === "evidence" })}>Export CSV</button>
      </div>
      <div className="grid-host">
        <AgGridReact<GridRow>
          theme={theme}
          rowData={rows}
          pinnedBottomRowData={totals}
          columnDefs={columns}
          quickFilterText={search}
          getRowId={(p) => p.data.id}
          domLayout="autoHeight"
          rowHeight={56}
          headerHeight={38}
          suppressCellFocus
          onGridReady={(e) => { grid.current = e.api; }}
          isFullWidthRow={(p) => p.rowNode.data?.kind === "evidence"}
          fullWidthCellRenderer={({ data }: ICellRendererParams<GridRow>) => (data?.kind === "evidence" ? <EvidenceRow invoice={data.source} navigate={navigate} /> : null)}
          getRowHeight={(p) => (p.data?.kind === "evidence" ? 104 : p.data?.kind === "total" ? 44 : 56)}
          overlayNoRowsTemplate="No invoices match."
        />
      </div>
      <p className="muted small" style={{ padding: "10px 16px" }}>{counts.overdue} overdue · {usd(state.forecast.promised)} promised · {state.decisions.length} decision{state.decisions.length === 1 ? "" : "s"} waiting</p>
    </section>
  );
}

function EvidenceRow({ invoice, navigate }: { invoice: InvoiceRow; navigate: Workspace["navigate"] }) {
  const reply = invoice.lastReply;
  return (
    <div className="evidence-row">
      <div style={{ display: "grid", gap: 4 }}>
        <span className="eyebrow">{reply ? (reply.source === "customer" ? "Latest answer, from the customer's link" : `Latest reply, read by ${reply.source === "claude" ? "Claude" : "offline rules"}`) : "No reply yet"}</span>
        {reply ? <Quote text={reply.body} evidence={reply.analysis.evidence} /> : <span className="muted">Share the customer link, or paste their reply when it arrives.</span>}
      </div>
      <div className="evidence-links">
        <button className="btn sm" onClick={() => navigate(`/customers/${encodeURIComponent(invoice.customerEmail)}`)}>Customer</button>
        {invoice.payUrl && <a className="btn sm" href={invoice.payUrl} target="_blank" rel="noreferrer">PayPal invoice</a>}
        <a className="btn sm" href={invoice.promiseLink} target="_blank" rel="noreferrer">Customer link</a>
      </div>
    </div>
  );
}
