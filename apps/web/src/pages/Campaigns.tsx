import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, campaignTone, EmptyState, ErrorNote, Modal, Spinner, Table } from "../components/ui";

interface Campaign {
  id: string;
  name: string;
  status: string;
  scheduleType: "ONCE" | "RECURRING";
  sendAt?: string | null;
  cronExpression?: string | null;
  template: { name: string };
  list: { name: string };
}
interface Template {
  id: string;
  name: string;
}
interface List {
  id: string;
  name: string;
  _count: { members: number };
}

export function CampaignsPage() {
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api<{ items: Campaign[] }>("/api/campaigns"),
  });

  return (
    <div>
      <PageHeader
        title="Campaigns"
        action={
          <button className="btn-primary" onClick={() => setWizard(true)}>
            New campaign
          </button>
        }
      />
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorNote error={error} />
      ) : data!.items.length === 0 ? (
        <EmptyState>No campaigns yet.</EmptyState>
      ) : (
        <Table head={["Name", "Template", "List", "Schedule", "Status"]}>
          {data!.items.map((c) => (
            <tr key={c.id} className="border-b border-[#f0f2f6] last:border-0">
              <td className="px-4 py-2.5">
                <Link className="font-medium text-accent-ink hover:underline" to={`/campaigns/${c.id}`}>
                  {c.name}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-slate-550">{c.template.name}</td>
              <td className="px-4 py-2.5 text-slate-550">{c.list.name}</td>
              <td className="px-4 py-2.5 font-mono text-xs">
                {c.scheduleType === "ONCE"
                  ? c.sendAt
                    ? new Date(c.sendAt).toLocaleString()
                    : "once"
                  : c.cronExpression}
              </td>
              <td className="px-4 py-2.5">
                <Badge tone={campaignTone[c.status] ?? "neutral"}>{c.status}</Badge>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={wizard} onClose={() => setWizard(false)} title="New campaign">
        <Wizard
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["campaigns"] });
            setWizard(false);
          }}
        />
      </Modal>
    </div>
  );
}

function Wizard({ onDone }: { onDone: () => void }) {
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ items: Template[] }>("/api/templates"),
  });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api<{ items: List[] }>("/api/lists") });

  const [form, setForm] = useState({
    name: "",
    templateId: "",
    listId: "",
    scheduleType: "ONCE" as "ONCE" | "RECURRING",
    sendAt: "",
    cronExpression: "0 9 * * 1",
  });

  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: form.name,
        templateId: form.templateId,
        listId: form.listId,
        scheduleType: form.scheduleType,
      };
      if (form.scheduleType === "ONCE") body.sendAt = new Date(form.sendAt).toISOString();
      else body.cronExpression = form.cronExpression;
      const c = await api<Campaign>("/api/campaigns", { method: "POST", json: body });
      await api(`/api/campaigns/${c.id}/schedule`, { method: "POST" });
      return c;
    },
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

      <label className="label">List</label>
      <select
        className="input mb-3"
        value={form.listId}
        onChange={(e) => setForm({ ...form, listId: e.target.value })}
        required
      >
        <option value="">Select…</option>
        {lists.data?.items.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} ({l._count.members})
          </option>
        ))}
      </select>

      <label className="label">Schedule</label>
      <div className="mb-3 flex gap-2">
        {(["ONCE", "RECURRING"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={form.scheduleType === s ? "btn-primary" : "btn-ghost"}
            onClick={() => setForm({ ...form, scheduleType: s })}
          >
            {s === "ONCE" ? "One-time" : "Recurring"}
          </button>
        ))}
      </div>

      {form.scheduleType === "ONCE" ? (
        <input
          className="input mb-3"
          type="datetime-local"
          value={form.sendAt}
          onChange={(e) => setForm({ ...form, sendAt: e.target.value })}
          required
        />
      ) : (
        <input
          className="input mb-3 font-mono text-xs"
          value={form.cronExpression}
          onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
          placeholder="0 9 * * 1  (Mondays 09:00)"
          required
        />
      )}

      {create.error ? <ErrorNote error={create.error} /> : null}
      <div className="mt-4 flex justify-end">
        <button className="btn-primary" disabled={create.isPending}>
          Create &amp; schedule
        </button>
      </div>
    </form>
  );
}
