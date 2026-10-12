import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { normalizeCostRates, type CostRates } from "@dispatch/shared";
import { api } from "../lib/api";
import { COST_RATES_QUERY, useCostRates } from "../lib/costs";
import { ErrorNote, Spinner } from "./ui";

/**
 * Settings → Cost rates (admins only): the rate card the Dashboard cost cards
 * use. Everything starts empty — no prices are built in, because Meta's and
 * the telephony provider's rates change and differ by country.
 */

type Draft = Record<string, string>;
const FIELDS: { key: string; label: string; get: (r: CostRates) => number | null }[] = [
  { key: "marketing", label: "Marketing", get: (r) => r.whatsapp.marketing },
  { key: "utility", label: "Utility", get: (r) => r.whatsapp.utility },
  { key: "authentication", label: "Authentication", get: (r) => r.whatsapp.authentication },
  { key: "service", label: "Service", get: (r) => r.whatsapp.service },
  { key: "usdToInr", label: "USD → INR rate (optional)", get: (r) => r.usdToInr },
  { key: "callTelephonyPerMin", label: "Telephony, per minute", get: (r) => r.callTelephonyPerMin },
  { key: "callAiPerMin", label: "AI voice / LLM, per minute (optional)", get: (r) => r.callAiPerMin },
];

const toDraft = (r: CostRates): Draft =>
  Object.fromEntries([
    ...FIELDS.map((f) => [f.key, f.get(r) === null ? "" : String(f.get(r))]),
    ["currency", r.currency],
    ["callRounding", r.callRounding],
  ]);

const num = (s: string | undefined) => (s && s.trim() !== "" ? Number(s) : null);
function fromDraft(d: Draft): CostRates {
  return normalizeCostRates({
    currency: d.currency,
    whatsapp: { marketing: num(d.marketing), utility: num(d.utility), authentication: num(d.authentication), service: num(d.service) },
    usdToInr: num(d.usdToInr),
    callTelephonyPerMin: num(d.callTelephonyPerMin),
    callAiPerMin: num(d.callAiPerMin),
    callRounding: d.callRounding,
  });
}
const invalid = (d: Draft) => FIELDS.some((f) => d[f.key]?.trim() && !(Number(d[f.key]) >= 0));

export function CostRatesSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const rates = useCostRates(isAdmin);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (rates.data) setDraft(toDraft(rates.data));
  }, [rates.data]);
  // "Set rates in Settings" on the Dashboard links here.
  useEffect(() => {
    if (window.location.hash === "#cost-rates" && draft) ref.current?.scrollIntoView({ block: "start" });
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (r: CostRates) => api<CostRates>("/api/settings/cost-rates", { method: "PUT", json: r, notify: false }),
    onMutate: () => setMessage(null),
    onSuccess: (res) => {
      qc.setQueryData(COST_RATES_QUERY, res);
      void qc.invalidateQueries({ queryKey: ["dashboard-costs"] });
      setMessage("Saved — the Dashboard cost cards use these rates now.");
    },
  });

  if (!isAdmin) return null;
  const dirty = !!draft && !!rates.data && JSON.stringify(fromDraft(draft)) !== JSON.stringify(rates.data);
  const set = (k: string, v: string) => {
    setMessage(null);
    setDraft((d) => ({ ...(d ?? {}), [k]: v }));
  };
  const cur = draft?.currency ?? "INR";
  const input = (key: string, label: string) => (
    <label key={key} className="block">
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-550">{cur === "INR" ? "₹" : "$"}</span>
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder="Not set"
          value={draft?.[key] ?? ""}
          disabled={save.isPending}
          onChange={(e) => set(key, e.target.value)}
        />
      </div>
    </label>
  );

  return (
    <section className="settings-section" id="cost-rates" ref={ref}>
      <h2 className="settings-heading">Cost rates</h2>
      <div className="settings-card space-y-5">
        <p className="text-slate-550">
          Used only for the <b>estimated</b> cost cards on the Dashboard. No provider prices are stored, so every amount
          shown there is an estimate — your Meta and telephony invoices are the source of truth. Leave a rate empty to
          show "Set rates in Settings" instead of a number.
        </p>
        {rates.isLoading || !draft ? (
          rates.error ? <ErrorNote error={rates.error} /> : <Spinner />
        ) : (
          <>
            <div className="max-w-xs">
              <label className="block">
                <span className="label">Currency</span>
                <select className="input" value={draft.currency} disabled={save.isPending} onChange={(e) => set("currency", e.target.value)}>
                  <option value="INR">INR — Indian rupee</option>
                  <option value="USD">USD — US dollar</option>
                </select>
              </label>
            </div>

            <div>
              <div className="font-semibold text-ink">WhatsApp — price per message (India)</div>
              <p className="mb-3 text-xs text-slate-550">
                Enter the current rates from Meta's official WhatsApp pricing page for your country. Rates change.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {FIELDS.slice(0, 4).map((f) => input(f.key, f.label))}
              </div>
            </div>

            <div>
              <div className="font-semibold text-ink">Calls</div>
              <p className="mb-3 text-xs text-slate-550">
                Telephony price per minute from your provider (Plivo / Twilio). Provider prices aren't stored, so this rate is
                always used. Add an AI cost per minute if you track it.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {FIELDS.slice(5, 7).map((f) => input(f.key, f.label))}
                {input("usdToInr", FIELDS[4]!.label)}
              </div>
              <fieldset className="mt-3">
                <legend className="label">Call minutes</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="call-rounding" checked={draft.callRounding === "ceil_minute"} onChange={() => set("callRounding", "ceil_minute")} />
                    Round up to whole minutes (per call)
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="call-rounding" checked={draft.callRounding === "per_second"} onChange={() => set("callRounding", "per_second")} />
                    Per second
                  </label>
                </div>
              </fieldset>
            </div>

            {save.error && <ErrorNote error={save.error} />}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-primary"
                disabled={!dirty || invalid(draft) || save.isPending}
                onClick={() => save.mutate(fromDraft(draft))}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              {invalid(draft) && <span className="text-xs text-crit">Rates must be 0 or more.</span>}
              {message && !dirty && <span className="text-ok">{message}</span>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
