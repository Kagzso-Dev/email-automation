import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { ErrorNote, Spinner, Table } from "../components/ui";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsed?: string | null;
  createdAt: string;
}

export function SettingsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const isAdmin = user?.role === "ADMIN";

  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<{ items: ApiKey[] }>("/api/api-keys"),
    enabled: isAdmin,
  });
  const create = useMutation({
    mutationFn: () => api<ApiKey & { key: string }>("/api/api-keys", { method: "POST", json: { name } }),
    onSuccess: (k) => {
      setFreshKey(k.key);
      setName("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  return (
    <div>
      <PageHeader title="Settings" />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">API keys</h2>
        {!isAdmin ? (
          <div className="card text-sm text-slate-550">Only admins can manage API keys.</div>
        ) : (
          <>
            <div className="card mb-4">
              <label className="label">New key name</label>
              <div className="flex gap-2">
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Production webhook"
                />
                <button
                  className="btn-primary whitespace-nowrap"
                  disabled={!name || create.isPending}
                  onClick={() => create.mutate()}
                >
                  Create key
                </button>
              </div>
              {create.error ? <div className="mt-2"><ErrorNote error={create.error} /></div> : null}
              {freshKey && (
                <div className="mt-3 rounded-lg bg-[#f8f0e1] p-3 text-sm">
                  <div className="mb-1 font-medium text-warn">Copy this now — it is shown only once.</div>
                  <code className="block break-all">{freshKey}</code>
                </div>
              )}
            </div>

            {keys.isLoading ? (
              <Spinner />
            ) : keys.data && keys.data.items.length > 0 ? (
              <Table head={["Name", "Prefix", "Last used", "Created", ""]}>
                {keys.data.items.map((k) => (
                  <tr key={k.id} className="border-b border-[#f0f2f6] last:border-0">
                    <td className="px-4 py-2.5">{k.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{k.prefix}…</td>
                    <td className="px-4 py-2.5 text-slate-550">
                      {k.lastUsed ? new Date(k.lastUsed).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-550">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        className="text-xs text-crit hover:underline"
                        onClick={() => {
                          if (confirm(`Revoke key "${k.name}"?`)) del.mutate(k.id);
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            ) : (
              <div className="card text-sm text-slate-550">No API keys yet.</div>
            )}
          </>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">
          Sender &amp; deliverability
        </h2>
        <div className="card space-y-2 text-sm">
          <p className="text-slate-550">
            Sender identity and SES mode are configured through environment variables
            (<code className="rounded bg-accent-soft px-1 text-accent-ink">EMAIL_FROM</code>,{" "}
            <code className="rounded bg-accent-soft px-1 text-accent-ink">EMAIL_PROVIDER</code>).
          </p>
          <p className="font-medium">DNS records to add for the sending domain:</p>
          <ul className="list-disc pl-5 text-slate-550">
            <li>SPF: <code>v=spf1 include:amazonses.com ~all</code></li>
            <li>DKIM: the 3 CNAME records SES generates for the domain identity</li>
            <li>DMARC: <code>v=DMARC1; p=none; rua=mailto:dmarc@yourdomain</code></li>
          </ul>
          <p className="text-slate-550">
            While SES is in sandbox: 200 emails/24h, 1/sec, and every recipient address must be
            verified in the SES console.
          </p>
        </div>
      </section>

      {isAdmin && <JobsSection />}
    </div>
  );
}

interface Job {
  id: string;
  queue: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError?: string | null;
  updatedAt: string;
}

function JobsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ items: Job[]; counts: { queue: string; status: string; _count: { _all: number } }[] }>("/api/jobs?limit=25"),
    refetchInterval: 5000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/api/jobs/${id}/retry`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">
        Job queue
      </h2>
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-slate-550">
            {data.counts.map((c) => (
              <span key={c.queue + c.status}>
                {c.queue}/{c.status} <b className="text-ink">{c._count._all}</b>
              </span>
            ))}
          </div>
          <Table head={["Queue", "Status", "Attempts", "Run at", "Error", ""]}>
            {data.items.map((j) => (
              <tr key={j.id} className="border-b border-[#f0f2f6] last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{j.queue}</td>
                <td className="px-4 py-2">{j.status}</td>
                <td className="px-4 py-2 font-mono tabular-nums">
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="px-4 py-2 text-slate-550">{new Date(j.runAt).toLocaleString()}</td>
                <td className="max-w-[16rem] truncate px-4 py-2 text-xs text-crit">
                  {j.lastError ?? ""}
                </td>
                <td className="px-4 py-2 text-right">
                  {(j.status === "DEAD" || j.status === "FAILED") && (
                    <button
                      className="text-xs text-accent-ink hover:underline"
                      onClick={() => retry.mutate(j.id)}
                    >
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </section>
  );
}
