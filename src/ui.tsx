import { Dialog as RadixDialog, Switch as RadixSwitch } from "radix-ui";
import type { ReactNode } from "react";

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className="dialog" aria-describedby={undefined}>
          <RadixDialog.Title asChild><h2>{title}</h2></RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <RadixSwitch.Root className="switch" checked={checked} onCheckedChange={onChange} aria-label={label}>
      <RadixSwitch.Thumb className="switch-thumb" />
    </RadixSwitch.Root>
  );
}

export function Quote({ text, evidence }: { text: string; evidence?: string | null }) {
  const at = evidence ? text.indexOf(evidence) : -1;
  if (at < 0) return <div className="quote">"{text}"</div>;
  return (
    <div className="quote">
      "{text.slice(0, at)}<mark>{evidence}</mark>{text.slice(at + evidence!.length)}"
    </div>
  );
}

export function KeptDots({ kept, broken }: { kept: number; broken: number }) {
  if (kept + broken === 0) return <span className="muted small">New customer</span>;
  return (
    <span className="rel">
      {Array.from({ length: Math.min(kept, 6) }, (_, i) => <i className="k" key={`k${i}`} />)}
      {Array.from({ length: Math.min(broken, 6) }, (_, i) => <i className="b" key={`b${i}`} />)}
      <span>{kept} of {kept + broken}</span>
    </span>
  );
}

export const STATUS: Record<string, { label: string; tone: string }> = {
  PAID: { label: "Paid", tone: "ok" },
  ON_TRACK: { label: "Not due", tone: "" },
  PROMISED: { label: "Promised", tone: "info" },
  DISPUTED: { label: "Disputed", tone: "red" },
  BROKEN: { label: "Broken promise", tone: "red" },
  OVERDUE: { label: "Overdue", tone: "warn" },
  CANCELLED: { label: "Cancelled", tone: "" },
};

export function StatusPill({ risk }: { risk: string }) {
  const status = STATUS[risk];
  return status ? <span className={`pill ${status.tone}`}>{status.label}</span> : null;
}
