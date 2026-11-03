import { randomBytes } from "node:crypto";
import type { Analyzer } from "./ai.ts";
import { type PaypalGateway, SimulatedPaypal } from "./paypal.ts";
import { Service } from "./service.ts";
import { Store } from "./store.ts";

export type WorkspaceKind = "simulated" | "sandbox";

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  service: Service;
  listeners: Set<() => void>;
  visits: number;
  lastUsed: number;
}

interface Options {
  // A public demo gives each visitor private, temporary data. Otherwise everyone shares one saved workspace.
  isolated: boolean;
  paypal: PaypalGateway;
  analyzer: Analyzer;
  databasePath?: string;
  seedShared?: boolean;
  maxWorkspaces?: number;
  clock?: () => string;
}

export class Workspaces {
  private all = new Map<string, Workspace>();
  private shared: Workspace | null = null;

  constructor(private options: Options) {}

  get isolated() {
    return this.options.isolated;
  }

  get canUseSandbox() {
    return this.options.isolated && this.options.paypal.mode === "sandbox";
  }

  async start() {
    if (this.options.isolated) return;
    const { paypal, analyzer, databasePath, seedShared, clock } = this.options;
    const store = new Store(databasePath);
    this.shared = this.wrap("shared", paypal.mode, new Service(store, paypal, analyzer, clock));
    // Demo invoices have no PayPal record, so sample data only starts an empty database.
    if (store.invoices().length === 0 && (paypal.mode === "simulated" || seedShared)) {
      await this.shared.service.seedDemo().catch((error) => console.error("Could not create sample invoices:", error));
    }
  }

  private wrap(id: string, kind: WorkspaceKind, service: Service): Workspace {
    return { id, kind, service, listeners: new Set(), visits: 0, lastUsed: Date.now() };
  }

  // Replaces nothing until the sample data exists, so a failed PayPal call leaves the visitor's demo intact.
  async create(kind: WorkspaceKind): Promise<Workspace> {
    const { paypal, analyzer, clock } = this.options;
    if (kind === "sandbox" && paypal.mode !== "sandbox") throw new Error("Real PayPal sandbox isn't configured.");
    const gateway = kind === "sandbox" ? paypal : new SimulatedPaypal();
    const service = new Service(new Store(), gateway, analyzer, clock);
    await service.seedDemo();
    const workspace = this.wrap(randomBytes(18).toString("base64url"), kind, service);
    this.all.set(workspace.id, workspace);
    this.evict();
    return workspace;
  }

  async resolve(id: string | undefined): Promise<{ workspace: Workspace; created: boolean }> {
    if (this.shared) return { workspace: this.touch(this.shared), created: false };
    const existing = id ? this.all.get(id) : undefined;
    if (existing) return { workspace: this.touch(existing), created: false };
    return { workspace: this.touch(await this.create("simulated")), created: true };
  }

  private touch(workspace: Workspace) {
    workspace.visits += 1;
    workspace.lastUsed = Date.now();
    return workspace;
  }

  // Health checks and bots arrive once and never return, so they go before anyone actually using a demo.
  private evict() {
    const max = this.options.maxWorkspaces ?? 200;
    while (this.all.size > max) {
      const oldest = (list: Workspace[]) => list.reduce((a, b) => (b.lastUsed < a.lastUsed ? b : a));
      const candidates = [...this.all.values()].filter((w) => w.listeners.size === 0);
      const pool = candidates.length > 0 ? candidates : [...this.all.values()];
      const oneVisit = pool.filter((w) => w.visits <= 1);
      this.all.delete(oldest(oneVisit.length > 0 ? oneVisit : pool).id);
    }
  }

  private list(): Workspace[] {
    return this.shared ? [this.shared] : [...this.all.values()];
  }

  findByLink(token: string): Workspace | null {
    return this.list().find((w) => w.service.store.invoiceByLink(token)) ?? null;
  }

  findByPaypalId(paypalId: string): Workspace | null {
    return this.list().find((w) => w.service.store.invoiceByPaypalId(paypalId)) ?? null;
  }

  announce(workspace: Workspace) {
    for (const listener of workspace.listeners) listener();
  }
}
