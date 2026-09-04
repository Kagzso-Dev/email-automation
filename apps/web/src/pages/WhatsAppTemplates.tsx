import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Modal, Spinner, Table } from "../components/ui";
import { useConfirm } from "../components/confirm";

interface WTemplate {
  id: string;
  name: string;
  contentSid: string;
  body: string;
  variables: string[];
  buttonLabels: string[];
  updatedAt: string;
  _count?: { batches: number };
}

export function WhatsAppTemplatesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<WTemplate | null>(null);
  const [showNew, setShowNew] = useState(false);

  const query = useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api<{ items: WTemplate[] }>("/api/whatsapp/templates"),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/whatsapp/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-templates"] }),
  });

  const items = query.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="WhatsApp Templates"
        subtitle="Twilio Content templates with quick-reply buttons. Create the template in the Twilio console, then register its Content SID here."
        action={
          <button className="btn-primary" onClick={() => setShowNew(true)}>
            New template
          </button>
        }
      />

      {del.error && (
        <div className="mb-3">
          <ErrorNote error={del.error} />
        </div>
      )}

      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : items.length === 0 ? (
        <EmptyState icon="templates" title="No WhatsApp templates yet">
          Register your first approved Twilio Content template to start sending.
        </EmptyState>
      ) : (
        <Table head={["Name", "Content SID", "Variables", "Buttons", "Updated", ""]}>
          {items.map((t) => (
            <tr key={t.id} className="border-b border-[#f0f2f6] last:border-0">
              <td className="px-4 py-2.5 font-medium">{t.name}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-slate-550">{t.contentSid}</td>
              <td className="px-4 py-2.5 text-xs">
                {t.variables.length ? t.variables.join(", ") : "—"}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {t.buttonLabels.length ? (
                    t.buttonLabels.map((b) => (
                      <Badge key={b} tone="neutral">
                        {b}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-slate-550">—</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2.5 text-slate-550">
                {new Date(t.updatedAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center justify-end gap-3">
                  <button
                    className="text-xs text-accent-ink hover:underline"
                    onClick={() => setEditing(t)}
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-crit hover:underline disabled:opacity-50"
                    disabled={del.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete "${t.name}"?`,
                        body: "This removes the template registration.",
                        confirmText: "Delete",
                        tone: "danger",
                      });
                      if (ok) del.mutate(t.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <TemplateModal open={showNew} onClose={() => setShowNew(false)} />
      <TemplateModal
        open={!!editing}
        template={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function TemplateModal({
  open,
  template,
  onClose,
}: {
  open: boolean;
  template?: WTemplate;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={template ? "Edit template" : "New WhatsApp template"}>
      {open ? (
        <TemplateForm key={template?.id ?? "new"} template={template} onClose={onClose} />
      ) : null}
    </Modal>
  );
}

function TemplateForm({ template, onClose }: { template?: WTemplate; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: template?.name ?? "",
    contentSid: template?.contentSid ?? "",
    body: template?.body ?? "",
    variables: (template?.variables ?? []).join(", "),
    buttonLabels: (template?.buttonLabels ?? ["Interested", "Not Interested"]).join(", "),
  });

  const toList = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const mut = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        contentSid: form.contentSid.trim(),
        body: form.body,
        variables: toList(form.variables),
        buttonLabels: toList(form.buttonLabels),
      };
      return template
        ? api(`/api/whatsapp/templates/${template.id}`, { method: "PUT", json: payload })
        : api("/api/whatsapp/templates", { method: "POST", json: payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      onClose();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
    >
      <label className="label">Name</label>
      <input
        className="input mb-3"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        required
      />

      <label className="label">Twilio Content SID</label>
      <input
        className="input mb-3 font-mono text-xs"
        value={form.contentSid}
        onChange={(e) => setForm({ ...form, contentSid: e.target.value })}
        placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        required
      />

      <label className="label">Body preview</label>
      <textarea
        className="input mb-1 min-h-[96px]"
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        placeholder="Hi {{first_name}}, we work with businesses like {{business_name}}…"
        required
      />
      <p className="mb-3 text-xs text-slate-550">
        Must match the approved Twilio template text. Use <code>{"{{first_name}}"}</code>,{" "}
        <code>{"{{last_name}}"}</code>, <code>{"{{business_name}}"}</code>, <code>{"{{phone}}"}</code>.
      </p>

      <label className="label">Variables (in order, comma-separated)</label>
      <input
        className="input mb-1"
        value={form.variables}
        onChange={(e) => setForm({ ...form, variables: e.target.value })}
        placeholder="first_name, business_name"
      />
      <p className="mb-3 text-xs text-slate-550">
        Maps to Twilio's positional content variables ({"{{1}}"}, {"{{2}}"}, …) in this order.
      </p>

      <label className="label">Quick-reply button labels (comma-separated, max 3)</label>
      <input
        className="input mb-3"
        value={form.buttonLabels}
        onChange={(e) => setForm({ ...form, buttonLabels: e.target.value })}
        placeholder="Interested, Not Interested"
      />

      {mut.error && <ErrorNote error={mut.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={mut.isPending}>
          {mut.isPending ? "Saving…" : template ? "Save changes" : "Create"}
        </button>
      </div>
    </form>
  );
}
