import { Link } from "react-router-dom";
import { formatMoney } from "../../lib/costs";
import { useCallCostByFlow } from "../../lib/callCostByFlow";
import { ErrorNote, Skeleton } from "../ui";
import { EstimatedPill } from "./CostCards";

/**
 * Dashboard → AI Calls: "Cost by call flow". Per flow (and "Default agent"):
 * billed calls, billed minutes, estimated cost and cost per call — the same
 * calls and rates as the "Call bills" card, so the totals match it.
 */
const full = new Intl.NumberFormat("en");

export function CallCostByFlow({ span }: { span: number }) {
  const q = useCallCostByFlow(span);
  const d = q.data;
  // AI column only when an AI rate is saved.
  const showAi = d?.rates.aiPerMin != null;
  const money = (n: number | null) => (n === null || !d ? "—" : formatMoney(n, d.currency));

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold tracking-[-0.01em] text-ink">
          Cost by call flow {d?.ratesSet && <EstimatedPill />}
        </h3>
        {d?.ratesSet && (
          <span className="text-xs text-slate-550">
            {d.rounding === "ceil_minute" ? "Each call rounded up to whole minutes" : "Per second"} · last {d.span} days
          </span>
        )}
      </div>

      {q.error && !d ? (
        <ErrorNote error={q.error} />
      ) : q.isLoading || !d ? (
        <div role="status" aria-label="Loading" className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : !d.ratesSet ? (
        <p className="py-6 text-center text-sm text-slate-550">
          Rates not set —{" "}
          <Link to="/settings#cost-rates" className="font-medium text-accent-ink hover:underline">
            set them in Settings
          </Link>
        </p>
      ) : (
        <>
        {/* Saved rates and the telephony + AI split of the total. */}
        <div className="mb-3 space-y-0.5">
          <p className="text-sm text-ink">
            Telephony <span className="font-semibold tabular-nums">{money(d.totals.telephonyCost)}</span>
            {showAi && (
              <>
                {" "}+ AI <span className="font-semibold tabular-nums">{money(d.totals.aiCost)}</span>
              </>
            )}{" "}
            = <span className="font-semibold tabular-nums">{money(d.totals.cost)}</span>
          </p>
          <p className="text-xs text-slate-550">
            {money(d.rates.telephonyPerMin)}/min telephony
            {showAi && ` · ${money(d.rates.aiPerMin)}/min AI`}
          </p>
        </div>
        {d.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-550">No billed calls in this period.</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-slate-550">
                <th className="px-1 py-2 font-semibold">Flow</th>
                <th className="px-1 py-2 text-right font-semibold">Calls</th>
                <th className="px-1 py-2 text-right font-semibold">Billed min</th>
                <th className="px-1 py-2 text-right font-semibold">Telephony</th>
                {showAi && <th className="px-1 py-2 text-right font-semibold">AI</th>}
                <th className="px-1 py-2 text-right font-semibold">Est. cost</th>
                <th className="px-1 py-2 text-right font-semibold">Cost / call</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((f) => (
                <tr key={f.flowId ?? "default"} className="border-b border-line-subtle last:border-0">
                  <td className="max-w-[14rem] truncate px-1 py-2 font-medium text-ink" title={f.name}>
                    {f.name}
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">{full.format(f.calls)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{full.format(f.billedMinutes)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{money(f.telephonyCost)}</td>
                  {showAi && <td className="px-1 py-2 text-right tabular-nums">{money(f.aiCost)}</td>}
                  <td className="px-1 py-2 text-right tabular-nums">{f.cost === null ? "—" : formatMoney(f.cost, d.currency)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{f.costPerCall === null ? "—" : formatMoney(f.costPerCall, d.currency)}</td>
                </tr>
              ))}
            </tbody>
            {d.totals.cost !== null && (
              <tfoot>
                <tr className="border-t border-line font-semibold">
                  <td className="px-1 py-2">Total</td>
                  <td className="px-1 py-2 text-right tabular-nums">{full.format(d.totals.calls)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{full.format(d.totals.billedMinutes)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{money(d.totals.telephonyCost)}</td>
                  {showAi && <td className="px-1 py-2 text-right tabular-nums">{money(d.totals.aiCost)}</td>}
                  <td className="px-1 py-2 text-right tabular-nums">{formatMoney(d.totals.cost, d.currency)}</td>
                  <td className="px-1 py-2 text-right tabular-nums">{d.totals.costPerCall === null ? "—" : formatMoney(d.totals.costPerCall, d.currency)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        )}
        </>
      )}
    </div>
  );
}
