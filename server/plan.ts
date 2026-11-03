// Cash plan arithmetic. Imported by the browser too, so it stays free of server dependencies.

export type PlanKind = "PROMISED" | "OVERDUE" | "NOT_DUE" | "DISPUTED" | "BROKEN";

export interface PlanItem {
  id: string;
  invoiceId: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  date: string;
  kind: PlanKind;
  counted: boolean;
  afterTarget: boolean;
}

export function dateRange(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && days.length < 60) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// A late invoice can't arrive in the past, so it sits on today until someone gives it a date.
export const planDate = (item: Pick<PlanItem, "date">, today: string) => (item.date < today ? today : item.date);

export function runningCash<T extends PlanItem>(cash: number, items: T[], enabled: (item: T) => boolean, today: string, days: string[]) {
  return days.map((day) => ({
    day,
    cash: items
      .filter((item) => !item.afterTarget && enabled(item) && planDate(item, today) <= day)
      .reduce((sum, item) => sum + item.amount, cash),
  }));
}

export function planShortfall<T extends PlanItem>(cash: number, obligation: number, items: T[], enabled: (item: T) => boolean) {
  const expected = items.filter((item) => !item.afterTarget && enabled(item)).reduce((sum, item) => sum + item.amount, 0);
  return obligation - cash - expected;
}
