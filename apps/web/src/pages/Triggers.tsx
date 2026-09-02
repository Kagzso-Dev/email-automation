import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Modal, Spinner } from "../components/ui";

interface Trigger {
  id: string;
  name: string;
  eventKey: string;
  active: boolean;
  templateId: string;
  conditions: { field: string; op: string; value?: unknown }[];
  template?: { name: string };
  webhookUrl: string;
  curlExample: string;
}
interface Template {
  id: string;
  name: string;
}

export function TriggersPage() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api<{ items: Trigger[] }>("/api/triggers"),
  });
  const toggle = useMutation({
    mutationFn: (t: Trigger) =>
      api(`/api/triggers/${t.id}`, { method: "PUT", json: { active: !t.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/triggers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });

  return (
    <div>
      <PageHeader
        title="Triggers"
        action={
          <button className="btn-primary" onClick={() => setShow(true)}>
            New trigger
          </button>
        }
      />
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorNote error={error} />
      ) : data!.items.length === 0 ? (
        <EmptyState>No triggers. Create one to send email when an external event fires.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {data!.items.map((t) => (
            <div key={t.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge tone={t.active ? "ok" : "neutral"}>{t.active ? "ACTIVE" : "OFF"}</Badge>
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-slate-550">
                    event: {t.eventKey} · template: {t.template?.name}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="btn-ghost" onClick={() => toggle.mutate(t)}>
                    {t.active ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="btn-danger"
                    onClick={() => {
                      if (confirm(`Delete trigger "${t.name}"?`)) del.mutate(t.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {t.conditions.length > 0 && (
                <div className="mt-2 font-mono text-xs text-slate-550">
                  when {t.conditions.map((c) => `${c.field} ${c.op} ${c.value ?? ""}`).join(" AND ")}
                </div>
              )}

              <div className="mt-3 rounded-lg bg-[#f6f7f9] p-3">
                <div className="label">Webhook URL</div>
                <code className="block break-all text-xs">{t.webhookUrl}</code>
                <button
                  className="mt-1 text-xs text-accent-ink hover:underline"
                  onClick={() => navigator.clipboard?.writeText(t.webhookUrl)}
                >
                  Copy URL
                </button>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px] leading-relaxed">
                  {t.curlExample}
                </pre>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={show} onClose={() => setShow(false)} title="New trigger">
        <NewTrigger
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["triggers"] });
            setShow(false);
          }}
        />
      </Modal>
    </div>
  );
}

function NewTrigger({ onDone }: { onDone: () => void }) {
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ items: Template[] }>("/api/templates"),
  });
  const [form, setForm] = useState({ name: "", eventKey: "", templateId: "" });
  const create = useMutation({
    mutationFn: () => api("/api/triggers", { method: "POST", json: { ...form, conditions: [], active: true } }),
    onSuccess: onDone,
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <label className="label">Name</label>
      <input className="input mb-3" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      <label className="label">Event key (used in the webhook URL)</label>
      <input
        className="input mb-3 font-mono text-xs"
        value={form.eventKey}
        onChange={(e) => setForm({ ...form, eventKey: e.target.value })}
        placeholder="user.signup"
        required
      />
      <label className="label">Template</label>
      <select
        className="input mb-3"
        value={form.templateId}
        onChange={(e) => setForm({ ...form, templateId: e.target.value })}
        required
      >
        <option value="">Select…</option>
        {templates.data?.items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {create.error ? <ErrorNote error={create.error} /> : null}
      <div className="mt-4 flex justify-end">
        <button className="btn-primary" disabled={create.isPending}>
          Create
        </button>
      </div>
    </form>
  );
}
