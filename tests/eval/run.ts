// Scores the reply reader against tests/eval/replies.ts. Each run spends API credit.
// Run with: npx tsx tests/eval/run.ts
import "dotenv/config";
import { ClaudeAnalyzer } from "../../server/ai.ts";
import type { Invoice } from "../../server/domain.ts";
import { type LabelledReply, REPLIES } from "./replies.ts";

const invoice: Invoice = {
  id: "eval",
  paypalId: "eval",
  number: "EVAL-1",
  customerName: "Harbor Street Cafe",
  customerEmail: "a@example.com",
  description: "Kitchen rewiring",
  amount: 240000,
  paid: 0,
  dueDate: "2026-10-22",
  status: "SENT",
  payUrl: null,
  createdAt: "",
};

const analyzer = new ClaudeAnalyzer();

async function score(label: LabelledReply) {
  const { analysis, source, notice } = await analyzer.analyze(label.text, invoice, "2026-11-03");
  const checks: Record<string, boolean> = { intent: analysis.intent === label.intent };
  if (label.date !== undefined) checks.date = analysis.promisedDate === label.date;
  if (label.amount !== undefined) checks.amount = analysis.promisedAmount === label.amount;
  if (label.corrected !== undefined) checks.corrected = analysis.correctedAmount === label.corrected;
  return { label, analysis, source, notice, checks };
}

const results: Awaited<ReturnType<typeof score>>[] = [];
for (let i = 0; i < REPLIES.length; i += 5) {
  results.push(...(await Promise.all(REPLIES.slice(i, i + 5).map(score))));
}

const fields = ["intent", "date", "amount", "corrected"];
for (const field of fields) {
  const scored = results.filter((r) => field in r.checks);
  const right = scored.filter((r) => r.checks[field]).length;
  console.log(`${field.padEnd(10)} ${right}/${scored.length}`);
}
console.log(`fell back ${results.filter((r) => r.source !== "claude").length}/${results.length}`);

const hostile = results.slice(-5);
console.log(`hostile   ${hostile.filter((r) => Object.values(r.checks).every(Boolean)).length}/${hostile.length}`);

for (const r of results.filter((r) => !Object.values(r.checks).every(Boolean))) {
  console.log(`MISS ${JSON.stringify(r.label.text)}`);
  console.log(`  expected ${JSON.stringify(r.label)}`);
  console.log(`  got ${JSON.stringify({ intent: r.analysis.intent, date: r.analysis.promisedDate, amount: r.analysis.promisedAmount, corrected: r.analysis.correctedAmount, source: r.source })}`);
}
