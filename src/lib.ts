import { useCallback, useEffect, useState } from "react";
import type { Service } from "../server/service.ts";

export type AppState = ReturnType<Service["state"]> & {
  workspace: { isolated: boolean; kind: "simulated" | "sandbox"; canUseSandbox: boolean };
};
export type Decision = AppState["decisions"][number];
export type InvoiceRow = AppState["invoices"][number];
export type CustomerDetail = ReturnType<Service["customerDetail"]>;
export type PublicInvoice = ReturnType<Service["publicInvoice"]>;

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data as T;
}

export const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });

const asDate = (date: string) => new Date(`${date}T00:00:00Z`);
export const shortDate = (date: string) => asDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const longDate = (date: string) => asDate(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export const weekday = (date: string) => asDate(date).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
export const daysBetween = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);

export function dueNote(due: string, today: string) {
  const days = daysBetween(today, due);
  if (days === 0) return "Due today";
  return days < 0 ? `${-days} day${days === -1 ? "" : "s"} late` : `In ${days} day${days === 1 ? "" : "s"}`;
}

export function certainty({ action, reply }: Pick<Decision, "action" | "reply">): { label: string; tone: string } {
  if (action.type === "REVIEW") return { label: "Needs you", tone: "warn" };
  if (reply?.source === "customer") return { label: "Customer chose", tone: "ok" };
  if (action.type === "CORRECT_INVOICE" || action.warnings.length > 0) return { label: "Check this", tone: "warn" };
  if (action.type === "SEND_REMINDER" && !reply) return { label: "Follow-up", tone: "info" };
  return { label: "Clear reply", tone: "ok" };
}

export function impactNote({ action, impact }: Decision): { text: string; good: boolean } {
  if (impact.shortfallAfter < impact.shortfallBefore) {
    return { text: `Short ${usd(impact.shortfallBefore)} → ${usd(impact.shortfallAfter)}`, good: true };
  }
  switch (action.type) {
    case "CORRECT_INVOICE":
      return { text: "Only the customer claims this", good: false };
    case "ALLOW_PARTIAL":
      return { text: action.payload.dueDate ? "Counts only if the date holds" : "No date given yet", good: false };
    case "VERIFY_PAYMENT":
      return { text: "Checks PayPal's record", good: false };
    case "SEND_REMINDER":
      return { text: "Sends through PayPal", good: false };
    case "TRACK_PROMISE":
      return { text: "No change to payroll", good: false };
    default:
      return { text: "Nothing changes on PayPal", good: false };
  }
}

export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return { path, navigate };
}

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("paypromise-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("paypromise-theme", theme);
    } catch {
      // A blocked store only means the choice isn't remembered.
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}
