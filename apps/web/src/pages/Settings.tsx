import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { ErrorNote, Spinner, Table } from "../components/ui";
import { useConfirm } from "../components/confirm";

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
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
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
      setCopied(false);
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
              <div className="flex flex-col gap-2 sm:flex-row">
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
                  <div className="mb-1 font-medium text-warn">
                    Your new API key — copy it now. You can also reveal it later from the table below.
                  </div>
                  <code className="block break-all">{freshKey}</code>
                  <button
                    className="mt-2 text-xs text-accent-ink hover:underline"
                    onClick={async () => {
                      await navigator.clipboard?.writeText(freshKey);
                      setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy key"}
                  </button>
                </div>
              )}
            </div>

            {keys.isLoading ? (
              <Spinner />
            ) : keys.data && keys.data.items.length > 0 ? (
              <Table head={["Name", "Prefix", "Last used", "Created", ""]}>
                {keys.data.items.map((k) => {
                  const full = revealed[k.id];
                  return (
                  <tr key={k.id} className="border-b border-[#f0f2f6] last:border-0">
                    <td className="px-4 py-2.5">{k.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <span className="break-all">{full ?? `${k.prefix}…`}</span>
                      {full ? (
                        <button
                          className="ml-2 font-sans text-accent-ink hover:underline"
                          onClick={async () => {
                            await navigator.clipboard?.writeText(full);
                            setCopiedId(k.id);
                          }}
                        >
                          {copiedId === k.id ? "Copied" : "Copy"}
                        </button>
                      ) : (
                        <button
                          className="ml-2 font-sans text-accent-ink hover:underline"
                          onClick={async () => {
                            const { key } = await api<{ key: string }>(`/api/api-keys/${k.id}/reveal`);
                            setRevealed((r) => ({ ...r, [k.id]: key }));
                            setCopiedId(null);
                          }}
                        >
                          Reveal
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-550">
                      {k.lastUsed ? new Date(k.lastUsed).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-550">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        className="text-xs text-crit hover:underline"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Revoke key "${k.name}"?`,
                            body: "Requests using this key will start failing immediately.",
                            confirmText: "Revoke",
                            tone: "danger",
                          });
                          if (ok) del.mutate(k.id);
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </Table>
            ) : (
              <div className="card text-sm text-slate-550">No API keys yet.</div>
            )}
          </>
        )}
      </section>

      <SenderSection />

      <WhatsAppSection />

      <BulkSendPacingSection isAdmin={isAdmin} />

      <AllowedDomainsSection isAdmin={isAdmin} />

      {isAdmin && <JobsSection />}
    </div>
  );
}

interface SendConfig {
  emailProvider: "mock" | "smtp";
  emailFrom: string;
  senderAddress: string;
  smtpHost: string | null;
  dailyCap: number;
  ratePerSec: number;
  deliveryFeedback: boolean;
  bulkSend: { minDelaySec: number; maxDelaySec: number };
}

const code = "rounded bg-accent-soft px-1 font-mono text-xs text-accent-ink";

function SenderSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["send-config"],
    queryFn: () => api<SendConfig>("/api/settings/config"),
  });

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">
        Sender &amp; deliverability
      </h2>
      <div className="card space-y-3 text-sm">
        {isLoading || !data ? (
          <Spinner />
        ) : (
          <>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[7rem_1fr]">
              <dt className="text-slate-550">Provider</dt>
              <dd className="font-mono text-xs">
                {data.emailProvider}
                {data.smtpHost ? ` · ${data.smtpHost}` : ""}
              </dd>
              <dt className="text-slate-550">From</dt>
              <dd className="break-all font-mono text-xs">{data.emailFrom}</dd>
              <dt className="text-slate-550">Send limit</dt>
              <dd className="font-mono text-xs">
                {data.dailyCap.toLocaleString()} / 24h · {data.ratePerSec}/sec
              </dd>
            </dl>
            <p className="text-slate-550">
              Sender identity and limits are set through environment variables (
              <code className={code}>EMAIL_FROM</code>, <code className={code}>EMAIL_PROVIDER</code>,{" "}
              <code className={code}>SEND_DAILY_CAP</code>).
            </p>

            {data.emailProvider === "mock" ? (
              <p className="rounded-lg bg-[#f8f0e1] p-3 text-warn">
                Running in <b>mock</b> mode — messages are written to{" "}
                <code className={code}>./.mail-outbox</code> and never actually sent. Set{" "}
                <code className={code}>EMAIL_PROVIDER=smtp</code> to send for real.
              </p>
            ) : (
              <>
                <p className="font-medium">
                  DNS records for your sending domain — use the values your SMTP provider gives you:
                </p>
                <ul className="list-disc pl-5 text-slate-550">
                  <li>
                    SPF: authorise the provider's servers, e.g.{" "}
                    <code>v=spf1 include:_spf.google.com ~all</code>
                  </li>
                  <li>DKIM: publish the signing key the provider generates for the domain</li>
                  <li>
                    DMARC: <code>v=DMARC1; p=none; rua=mailto:dmarc@yourdomain</code>
                  </li>
                </ul>
                <p className="text-slate-550">
                  SMTP has no delivery callbacks, so <b>bounce and complaint rates stay at 0</b> and
                  addresses are not auto-suppressed on a hard bounce — mark bad addresses{" "}
                  <code className={code}>BOUNCED</code> / <code className={code}>UNSUBSCRIBED</code> in
                  Contacts. Open and click tracking are unaffected.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function WhatsAppSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-config"],
    queryFn: () => api<{ configured: boolean; from: string | null }>("/api/whatsapp/config"),
  });

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">WhatsApp</h2>
      <div className="card space-y-3 text-sm">
        {isLoading || !data ? (
          <Spinner />
        ) : data.configured ? (
          <p className="rounded-lg bg-[#e7f1ec] p-3 text-ok">
            Connected — sending WhatsApp messages from{" "}
            <code className={code}>{data.from}</code> via Twilio.
          </p>
        ) : (
          <p className="rounded-lg bg-[#f8f0e1] p-3 text-warn">
            Not configured — set <code className={code}>WHATSAPP_ACCOUNT_SID</code>,{" "}
            <code className={code}>WHATSAPP_AUTH_TOKEN</code> and{" "}
            <code className={code}>WHATSAPP_FROM</code> in the environment to enable the “Send
            WhatsApp message” buttons. This is fully separate from email — leaving it blank has no
            effect on email sending.
          </p>
        )}
        <p className="text-slate-550">
          WhatsApp contacts, templates and sends are stored separately from email and never touch
          Contacts, Templates or Campaigns.
        </p>
      </div>
    </section>
  );
}

function BulkSendPacingSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["send-config"],
    queryFn: () => api<SendConfig>("/api/settings/config"),
  });

  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [dirty, setDirty] = useState(false);

  // Seed the inputs from the server value once it arrives / changes.
  const serverMin = data?.bulkSend.minDelaySec;
  const serverMax = data?.bulkSend.maxDelaySec;
  useEffect(() => {
    if (serverMin !== undefined && serverMax !== undefined) {
      setMin(String(serverMin));
      setMax(String(serverMax));
      setDirty(false);
    }
  }, [serverMin, serverMax]);

  const save = useMutation({
    mutationFn: () =>
      api<{ minDelaySec: number; maxDelaySec: number }>("/api/settings/bulk-send", {
        method: "PUT",
        json: { minDelaySec: Number(min), maxDelaySec: Number(max) },
      }),
    onSuccess: (v) => {
      qc.setQueryData<SendConfig>(["send-config"], (c) => (c ? { ...c, bulkSend: v } : c));
      qc.invalidateQueries({ queryKey: ["send-config"] });
      setDirty(false);
    },
  });

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">
        Bulk send pacing
      </h2>
      <div className="card space-y-3 text-sm">
        <p className="text-slate-550">
          When you send a template to several contacts at once from the Contacts page, they go out one
          at a time with a random gap in this range between each — never all at once — to avoid
          provider spam blocks. A change here applies to the next batch; batches already running keep
          the delay they started with.
        </p>

        {isLoading || !data ? (
          <Spinner />
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (isAdmin) save.mutate();
            }}
          >
            <div>
              <label className="label">Min gap (seconds)</label>
              <input
                className="input w-28"
                type="number"
                min={1}
                max={3600}
                value={min}
                disabled={!isAdmin || save.isPending}
                onChange={(e) => {
                  setMin(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div>
              <label className="label">Max gap (seconds)</label>
              <input
                className="input w-28"
                type="number"
                min={1}
                max={3600}
                value={max}
                disabled={!isAdmin || save.isPending}
                onChange={(e) => {
                  setMax(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            {isAdmin && (
              <button className="btn-primary whitespace-nowrap" disabled={!dirty || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
            )}
            {save.isSuccess && !dirty && <span className="text-ok">Saved.</span>}
          </form>
        )}

        {save.error && <ErrorNote error={save.error} />}

        {!isAdmin && (
          <p className="text-xs text-slate-550">Only admins can change the pacing.</p>
        )}
      </div>
    </section>
  );
}

interface AllowedDomain {
  id: string;
  domain: string;
  createdAt: string;
}

function AllowedDomainsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [domain, setDomain] = useState("");

  const list = useQuery({
    queryKey: ["allowed-domains"],
    queryFn: () => api<{ items: AllowedDomain[] }>("/api/settings/allowed-domains"),
  });
  const add = useMutation({
    mutationFn: () =>
      api("/api/settings/allowed-domains", { method: "POST", json: { domain } }),
    onSuccess: () => {
      setDomain("");
      qc.invalidateQueries({ queryKey: ["allowed-domains"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/settings/allowed-domains/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allowed-domains"] }),
  });

  const items = list.data?.items ?? [];

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-550">
        Approved sending domains
      </h2>
      <div className="card space-y-3 text-sm">
        <p className="text-slate-550">
          {items.length === 0
            ? "No restriction — email can be sent to any address. Add a domain to restrict sending."
            : "Contacts are only emailed when their address domain is on this list. Others are skipped at import and never sent to."}
        </p>

        {isAdmin && (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (domain.trim()) add.mutate();
            }}
          >
            <input
              className="input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="gmail.com"
            />
            <button className="btn-primary whitespace-nowrap" disabled={!domain.trim() || add.isPending}>
              Add domain
            </button>
          </form>
        )}
        {add.error ? <ErrorNote error={add.error} /> : null}

        {list.isLoading ? (
          <Spinner />
        ) : items.length > 0 ? (
          <ul className="divide-y divide-[#f0f2f6]">
            {items.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-2">
                <span className="font-mono text-xs">@{d.domain}</span>
                {isAdmin && (
                  <button
                    className="text-xs text-crit hover:underline"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove @${d.domain} from the approved list?`,
                        body: "New imports and sends to this domain will be blocked.",
                        confirmText: "Remove",
                        tone: "danger",
                      });
                      if (ok) remove.mutate(d.id);
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
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
