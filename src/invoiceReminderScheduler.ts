/**
 * Invoice due-date reminder scheduler for StellarSplit.
 *
 * Registers reminders at configurable offsets before an invoice's due date
 * and fires a typed event when each one comes due. Schedules are persisted
 * (see {@link ../snapshot.js}) so reminders survive process restarts —
 * on construction, any pending reminder whose fire time has already passed
 * is either fired immediately (when still within the configurable grace
 * period) or marked `expired` (when the process was down too long for the
 * reminder to still be meaningful).
 *
 * Follows the same persist-then-arm-timer approach as {@link ../scheduler.js}
 * (`ScheduledPaymentManager`), and the typed-event-emitter pattern used by
 * {@link ../sep/sep24Handler.js}.
 */

import { randomUUID } from "crypto";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import { loadReminderSchedules, saveReminderSchedules } from "./snapshot.js";
import type { ReminderSchedule, ReminderEvent } from "./types.js";

/** Events emitted by {@link InvoiceReminderScheduler}. */
export interface InvoiceReminderSchedulerEventMap {
  invoiceReminderDue: ReminderEvent;
  [key: string]: unknown;
}

/**
 * Resolves the Unix timestamp (milliseconds) an invoice is due.
 * May be async since the due date typically comes from a contract read or DB lookup.
 */
export type InvoiceDueAtResolver = (invoiceId: string) => Promise<number> | number;

export interface PendingReminder {
  /** Opaque identifier used for targeted cancellation. */
  reminderId: string;
  /** Invoice this reminder belongs to. */
  invoiceId: string;
  /** Unix timestamp (milliseconds) when the reminder will fire. */
  remindAt: number;
}

export interface InvoiceReminderSchedulerOptions {
  /**
   * How long (ms) after a reminder's scheduled fire time it is still
   * considered current on startup recovery. Reminders discovered further in
   * the past than this are marked `expired` instead of fired.
   * Defaults to 60 000 ms (60s).
   */
  gracePeriodMs?: number;
}

/** Default grace period for firing missed reminders after a restart. */
export const DEFAULT_GRACE_PERIOD_MS = 60_000;

/**
 * Schedules and fires due-date reminders for invoices.
 *
 * @example
 * ```typescript
 * const scheduler = new InvoiceReminderScheduler((invoiceId) => invoice.dueAt);
 * scheduler.on("invoiceReminderDue", ({ invoiceId, offsetMs }) => {
 *   notifyRecipient(invoiceId, offsetMs);
 * });
 * await scheduler.schedule("inv_123", [7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 60 * 60 * 1000]);
 * ```
 */
export class InvoiceReminderScheduler extends TypedEventEmitter<InvoiceReminderSchedulerEventMap> {
  private schedules: ReminderSchedule[];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly getDueAt: InvoiceDueAtResolver;
  private readonly gracePeriodMs: number;

  constructor(getDueAt: InvoiceDueAtResolver, options: InvoiceReminderSchedulerOptions = {}) {
    super();
    this.getDueAt = getDueAt;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.schedules = loadReminderSchedules();

    for (const entry of this.schedules) {
      if (entry.status === "pending") this._arm(entry);
    }
  }

  /**
   * Register reminders at each offset (ms before the invoice's due date).
   * Persists the schedule immediately so it survives a restart.
   */
  async schedule(invoiceId: string, offsets: number[]): Promise<ReminderSchedule[]> {
    const dueAt = await this.getDueAt(invoiceId);
    const created: ReminderSchedule[] = [];

    for (const offsetMs of offsets) {
      const entry: ReminderSchedule = {
        id: randomUUID(),
        invoiceId,
        offsetMs,
        dueAt,
        fireAt: dueAt - offsetMs,
        status: "pending",
      };
      this.schedules.push(entry);
      created.push(entry);
      this._arm(entry);
    }

    this._persist();
    return created;
  }

  /**
   * Register one reminder for an absolute fire time.
   *
   * The returned ID is intentionally opaque and remains stable across process
   * restarts because it is persisted with the underlying reminder schedule.
   */
  async scheduleReminder(invoiceId: string, remindAt: number): Promise<string> {
    const dueAt = await this.getDueAt(invoiceId);
    const entry: ReminderSchedule = {
      id: randomUUID(),
      invoiceId,
      offsetMs: dueAt - remindAt,
      dueAt,
      fireAt: remindAt,
      status: "pending",
    };

    this.schedules.push(entry);
    this._arm(entry);
    this._persist();
    return entry.id;
  }

  /**
   * Cancel one pending reminder by its opaque ID.
   *
   * Returns false for an unknown reminder or one that has already fired,
   * expired, or been cancelled.
   */
  cancelReminder(reminderId: string): boolean {
    const index = this.schedules.findIndex((s) => s.id === reminderId);
    const entry = index >= 0 ? this.schedules[index] : undefined;
    if (!entry || entry.status !== "pending") return false;

    const timer = this.timers.get(reminderId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(reminderId);

    this.schedules[index] = { ...entry, status: "cancelled" };
    this._persist();
    return true;
  }

  /** Return every reminder that has not fired, expired, or been cancelled. */
  getPendingReminders(): PendingReminder[] {
    return this.schedules
      .filter((s) => s.status === "pending")
      .map((s) => ({
        reminderId: s.id,
        invoiceId: s.invoiceId,
        remindAt: s.fireAt,
      }));
  }

  /**
   * Cancel every in-memory timer and clear persisted reminder schedules.
   * Intended for explicit reset/test teardown; unlike destroy(), this removes
   * stored state as well.
   */
  clearAllReminders(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.schedules = [];
    this._persist();
  }

  /** Remove all pending reminders for an invoice from the store. */
  cancel(invoiceId: string): void {
    const cancelled = this.schedules.filter(
      (s) => s.invoiceId === invoiceId && s.status === "pending",
    );
    for (const entry of cancelled) {
      const timer = this.timers.get(entry.id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(entry.id);
    }
    if (cancelled.length === 0) return;

    const cancelledIds = new Set(cancelled.map((c) => c.id));
    this.schedules = this.schedules.map((s) =>
      cancelledIds.has(s.id) ? { ...s, status: "cancelled" as const } : s,
    );
    this._persist();
  }

  /** Return the current set of reminder schedules (all invoices, all statuses). */
  list(): ReminderSchedule[] {
    return [...this.schedules];
  }

  /** Stop all pending timers and detach listeners. Does not clear persisted state. */
  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.removeAllListeners();
  }

  /**
   * Arm a timer for `entry`. Reminders already due (delay <= 0, e.g. loaded
   * from storage after a restart) are deferred via `setTimeout(fn, 0)` so
   * that callers get a chance to attach `on("invoiceReminderDue", ...)`
   * listeners before the event can fire.
   */
  private _arm(entry: ReminderSchedule): void {
    const delayMs = Math.max(0, entry.fireAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(entry.id);
      const overdueBy = Date.now() - entry.fireAt;
      if (overdueBy > this.gracePeriodMs) {
        this._expire(entry.id);
      } else {
        this._fire(entry.id);
      }
    }, delayMs);
    this.timers.set(entry.id, timer);
  }

  private _fire(id: string): void {
    const live = this.schedules.find((s) => s.id === id);
    if (!live || live.status !== "pending") return;
    live.status = "fired";
    this._persist();
    this.emit("invoiceReminderDue", {
      invoiceId: live.invoiceId,
      offsetMs: live.offsetMs,
      dueAt: live.dueAt,
    });
  }

  private _expire(id: string): void {
    const live = this.schedules.find((s) => s.id === id);
    if (!live || live.status !== "pending") return;
    live.status = "expired";
    this._persist();
  }

  private _persist(): void {
    saveReminderSchedules(this.schedules);
  }
}
