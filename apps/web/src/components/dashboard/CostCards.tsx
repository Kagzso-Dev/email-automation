import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatMoney, type DashboardCosts } from "../../lib/costs";
import { Modal, Skeleton } from "../ui";
import { fullNumber as full } from "../../lib/numberFormat";

/**
 * Dashboard cost cards. Nothing here is an invoice: Dispatch stores no
 * provider prices, so every amount is an estimate (stored counts / minutes ×
 * the rate card in Settings → Cost rates) and is labelled "Estimated". Missing
 * rates show "Set rates in Settings" instead of a number.
 */

const CATEGORY_LABEL: Record<string, string> = {
  marketing: "Marketing",
  utility: "Utility",
  authentication: "Authentication",
  service: "Service",
};
const plural = (n: number, one: string, many = `${one}s`) => `${full.format(n)} ${n === 1 ? one : many}`;

export function EstimatedPill() {
  return (
    <span className="rounded-full bg-[#fbf6ec] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn" title="Estimated from your rate card — not a provider invoice">
      Estimated
    </span>
  );
}

/** Card shell matching StatTile; clickable when it has a breakdown. */
function CostShell({ label, children, onOpen, title }: { label: string; children: ReactNode; onOpen?: () => void; title?: string }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="label">{label}</div>
      </div>
      {children}
    </>
  );
  return onOpen ? (
    <button type="button" className="card card-hover fade-rise block w-full text-left" onClick={onOpen} title={title}>
      {body}
    </button>
  ) : (
    <div className="card fade-rise" title={title}>
      {body}
    </div>
  );
}

function SetRates({ isAdmin, what }: { isAdmin: boolean; what: string }) {
  return (
    <>
      <div className="metric-value mt-2">—</div>
      <div className="mt-1 text-xs leading-[1.5] text-slate-550">
        {isAdmin ? (
          <Link to="/settings#cost-rates" className="font-medium text-accent-ink hover:underline" onClick={(e) => e.stopPropagation()}>
            Set rates in Settings
          </Link>
        ) : (
          "Rates not set"
        )}{" "}
        {what}
      </div>
    </>
  );
}

function Loading() {
  return (
    <>
      <Skeleton className="mt-3 h-7 w-20" />
      <Skeleton className="mt-2 h-3 w-28" />
    </>
  );
}

/* ------------------------------------------------------------------ WhatsApp */

export function WhatsAppCostTile({
  costs,
  isLoading,
  error,
  isAdmin,
}: {
  costs: DashboardCosts | undefined;
  isLoading: boolean;
  error: unknown;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const w = costs?.whatsapp;
  const tooltip =
    "Estimated: messages accepted by Meta (failed ones excluded) × your rate for each category. Meta's invoice is the source of truth.";

  if (error && !costs) {
    return (
      <CostShell label="Cost">
        <p className="mt-2 text-sm text-crit">Couldn't load the cost estimate.</p>
      </CostShell>
    );
  }
  if (isLoading || !costs || !w) {
    return (
      <CostShell label="Cost">
        <Loading />
      </CostShell>
    );
  }
  if (!w.ratesSet) {
    return (
      <CostShell label="Cost" title={tooltip}>
        <SetRates isAdmin={isAdmin} what="for WhatsApp messages" />
      </CostShell>
    );
  }
  return (
    <>
      <CostShell label="Cost" onOpen={() => setOpen(true)} title={`${tooltip} Click for the breakdown.`}>
        {w.total === null ? (
          <>
            <div className="metric-value mt-2">—</div>
            <div className="mt-1 text-xs leading-[1.5] text-warn">
              No rate for {w.missingRates.map((c) => CATEGORY_LABEL[c] ?? c).join(", ")} — set it in Settings
            </div>
          </>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="metric-value">{formatMoney(w.total, costs.currency)}</span>
              <EstimatedPill />
            </div>
            <div className="mt-1 text-xs leading-[1.5] text-slate-550">
              {plural(w.billableCount, "message")} · last {costs.span} days
              {w.uncategorized.count > 0 && <span className="text-warn"> · {full.format(w.uncategorized.count)} uncategorized</span>}
            </div>
          </>
        )}
      </CostShell>
      <Modal open={open} onClose={() => setOpen(false)} title={`WhatsApp cost · last ${costs.span} days`}>
        <WhatsAppBreakdown costs={costs} />
      </Modal>
    </>
  );
}

function WhatsAppBreakdown({ costs }: { costs: DashboardCosts }) {
  const w = costs.whatsapp;
  return (
    <div className="space-y-3 text-sm">
      <p className="flex items-center gap-2 text-slate-550">
        <EstimatedPill /> Messages × your category rate. Meta's invoice is the source of truth.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-slate-550">
            <th className="py-2">Category</th>
            <th className="py-2 text-right">Messages</th>
            <th className="py-2 text-right">Rate</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {w.byCategory.map((b) => (
            <tr key={b.category} className="border-b border-line-subtle last:border-0">
              <td className="py-2">
                {CATEGORY_LABEL[b.category] ?? b.category}
                {b.fromMeta > 0 && <span className="ml-1 text-xs text-slate-550">({full.format(b.fromMeta)} from Meta data)</span>}
              </td>
              <td className="py-2 text-right tabular-nums">{full.format(b.count)}</td>
              <td className="py-2 text-right tabular-nums">{b.rate === null ? <span className="text-warn">not set</span> : formatMoney(b.rate, costs.currency)}</td>
              <td className="py-2 text-right tabular-nums">{b.amount === null ? "—" : formatMoney(b.amount, costs.currency)}</td>
            </tr>
          ))}
          {w.byCategory.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-center text-slate-550">
                No billable messages in this period.
              </td>
            </tr>
          )}
        </tbody>
        {w.total !== null && (
          <tfoot>
            <tr className="border-t border-line font-semibold">
              <td className="py-2">Total (estimated)</td>
              <td className="py-2 text-right tabular-nums">{full.format(w.billableCount)}</td>
              <td />
              <td className="py-2 text-right tabular-nums">{formatMoney(w.total, costs.currency)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <ul className="space-y-1 text-xs text-slate-550">
        {w.uncategorized.count > 0 && (
          <li className="text-warn">
            {plural(w.uncategorized.count, "message")} Uncategorized ({w.uncategorized.labels.join(", ")}) — no price is guessed for these.
            {w.categoriesError && ` Meta's template list couldn't be read: ${w.categoriesError}`}
          </li>
        )}
        {w.notBillable > 0 && <li>{plural(w.notBillable, "message")} Meta marked as not billable (free).</li>}
        {w.failedExcluded > 0 && <li>{plural(w.failedExcluded, "failed message")} — not billed.</li>}
        {w.twilioCount > 0 && <li>{plural(w.twilioCount, "message")} sent via Twilio, billed by Twilio.</li>}
        <li>
          Category: Meta's own pricing data when stored ({full.format(w.fromMetaData)} message{w.fromMetaData === 1 ? "" : "s"}), Inbox replies as
          Service, otherwise the template's current category in Meta.
        </li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ calls */

export function CallBillsTile({
  costs,
  isLoading,
  error,
}: {
  costs: DashboardCosts | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  const [open, setOpen] = useState(false);
  const c = costs?.calls;
  const tooltip = "Estimated: billed minutes × your per-minute rates (no provider prices are stored).";
  if (error && !costs) {
    return (
      <CostShell label="Call bills">
        <p className="mt-2 text-sm text-crit">Couldn't load the cost estimate.</p>
      </CostShell>
    );
  }
  if (isLoading || !costs || !c) {
    return (
      <CostShell label="Call bills">
        <Loading />
      </CostShell>
    );
  }
  if (!c.ratesSet || c.total === null) {
    return (
      <CostShell label="Call bills" title={tooltip}>
        <SetRates isAdmin what="for calls" />
      </CostShell>
    );
  }
  return (
    <>
      <CostShell label="Call bills" onOpen={() => setOpen(true)} title={`${tooltip} Click for the breakdown.`}>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="metric-value">{formatMoney(c.total, costs.currency)}</span>
          <EstimatedPill />
        </div>
        <div className="mt-1 text-xs leading-[1.5] text-slate-550">
          {full.format(c.minutes)} min billed · {c.avgPerCall === null ? "no billed calls" : `avg ${formatMoney(c.avgPerCall, costs.currency)} per call`}
        </div>
      </CostShell>
      <Modal open={open} onClose={() => setOpen(false)} title={`Call bills · last ${costs.span} days`}>
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2 text-slate-550">
            <EstimatedPill /> Billed minutes × your per-minute rates.
          </p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            <dt>Telephony</dt>
            <dd className="text-right tabular-nums">{c.telephony === null ? "—" : formatMoney(c.telephony, costs.currency)}</dd>
            {c.ai !== null && (
              <>
                <dt>AI voice / LLM</dt>
                <dd className="text-right tabular-nums">{formatMoney(c.ai, costs.currency)}</dd>
              </>
            )}
            <dt className="border-t border-line pt-2 font-semibold">Total (estimated)</dt>
            <dd className="border-t border-line pt-2 text-right font-semibold tabular-nums">{formatMoney(c.total, costs.currency)}</dd>
          </dl>
          <ul className="space-y-1 text-xs text-slate-550">
            <li>
              {plural(c.billedCalls, "answered call")} · {full.format(c.minutes)} billed minutes (
              {c.rounding === "ceil_minute" ? "each call rounded up to whole minutes" : "per second"}).
            </li>
            <li>Unanswered, busy and failed calls have no duration and aren't billed.</li>
            <li>Estimated from your rates in Settings. Your Plivo / Twilio and AI provider invoices are the source of truth.</li>
          </ul>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ "All" row */

export function TotalCostLine({ costs }: { costs: DashboardCosts | undefined }) {
  if (!costs || costs.total === null) return null;
  return (
    <div className="-mt-4 flex flex-wrap items-center justify-end gap-2 text-sm text-slate-550">
      <span>Total cost (WhatsApp + calls, last {costs.span} days):</span>
      <span className="font-semibold text-ink tabular-nums">{formatMoney(costs.total, costs.currency)}</span>
      <EstimatedPill />
    </div>
  );
}
