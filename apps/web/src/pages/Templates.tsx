import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner } from "../components/ui";

interface Template {
  id: string;
  name: string;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  variables: string[];
  _count?: { campaigns: number; triggers: number };
}

const BLANK = {
  name: "",
  subject: "",
  htmlBody: "<h1>Hello {{first_name}}</h1>\n<p>Your message here. {{unsubscribe_url}}</p>",
  textBody: "",
  variables: [] as string[],
};

export function TemplatesPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ items: Template[] }>("/api/templates"),
  });
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);

  const selected =
    selectedId === "new"
      ? { ...BLANK }
      : data?.items.find((t) => t.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        title="Templates"
        action={
          <button className="btn-primary" onClick={() => setSelectedId("new")}>
            New template
          </button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div>
          {isLoading ? (
            <Spinner />
          ) : error ? (
            <ErrorNote error={error} />
          ) : data!.items.length === 0 ? (
            <EmptyState>No templates.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-1">
              {data!.items.map((t) => (
                <li key={t.id}>
                  <button
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                      selectedId === t.id ? "bg-accent-soft text-accent-ink" : "hover:bg-[#f0f2f6]"
                    }`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <div className="font-medium">{t.name}</div>
                    <div className="truncate text-xs text-slate-550">{t.subject}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected ? (
          <TemplateEditor
            key={selectedId}
            initial={selected}
            isNew={selectedId === "new"}
            onSaved={(id) => {
              qc.invalidateQueries({ queryKey: ["templates"] });
              setSelectedId(id);
            }}
            onDeleted={() => {
              qc.invalidateQueries({ queryKey: ["templates"] });
              setSelectedId(null);
            }}
          />
        ) : (
          <EmptyState>Select a template or create a new one.</EmptyState>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({
  initial,
  isNew,
  onSaved,
  onDeleted,
}: {
  initial: Partial<Template>;
  isNew: boolean;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState({
    name: initial.name ?? "",
    subject: initial.subject ?? "",
    htmlBody: initial.htmlBody ?? "",
    textBody: initial.textBody ?? "",
    variables: (initial.variables ?? []).join(", "),
  });
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [testTo, setTestTo] = useState("");

  const variables = form.variables
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sampleVars = Object.fromEntries(variables.map((v) => [v, `«${v}»`]));

  const save = useMutation({
    mutationFn: async () => {
      const body = { ...form, variables };
      if (isNew) return api<Template>("/api/templates", { method: "POST", json: body });
      return api<Template>(`/api/templates/${initial.id}`, { method: "PUT", json: body });
    },
    onSuccess: (t) => onSaved(t.id),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/templates/${initial.id}`, { method: "DELETE" }),
    onSuccess: onDeleted,
  });

  const doPreview = useMutation({
    mutationFn: () =>
      api<{ subject: string; html: string }>(`/api/templates/${initial.id}/preview`, {
        method: "POST",
        json: { variables: sampleVars },
      }),
    onSuccess: setPreview,
  });

  const sendTest = useMutation({
    mutationFn: () =>
      api(`/api/templates/${initial.id}/send-test`, {
        method: "POST",
        json: { to: testTo, variables: sampleVars },
      }),
  });

  useEffect(() => setPreview(null), [initial.id]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="card">
        <label className="label">Name</label>
        <input
          className="input mb-3"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <label className="label">Subject</label>
        <input
          className="input mb-3"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <label className="label">Declared variables (comma separated)</label>
        <input
          className="input mb-3 font-mono text-xs"
          value={form.variables}
          onChange={(e) => setForm({ ...form, variables: e.target.value })}
          placeholder="first_name, order_id"
        />
        <div className="mb-3 flex flex-wrap gap-1">
          {["first_name", "last_name", "email", "unsubscribe_url", ...variables].map((v) => (
            <button
              key={v}
              type="button"
              className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent-ink"
              onClick={() => setForm((f) => ({ ...f, htmlBody: f.htmlBody + `{{${v}}}` }))}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <label className="label">HTML body</label>
        <textarea
          className="input mb-3 h-56 font-mono text-xs"
          value={form.htmlBody}
          onChange={(e) => setForm({ ...form, htmlBody: e.target.value })}
        />
        <label className="label">Plain-text body (optional)</label>
        <textarea
          className="input mb-3 h-24 font-mono text-xs"
          value={form.textBody}
          onChange={(e) => setForm({ ...form, textBody: e.target.value })}
        />
        {save.error ? <ErrorNote error={save.error} /> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {isNew ? "Create" : "Save"}
          </button>
          {!isNew && (
            <>
              <button className="btn-ghost" onClick={() => doPreview.mutate()}>
                Preview
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  if (confirm("Delete this template?")) del.mutate();
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
        {del.error ? <div className="mt-2"><ErrorNote error={del.error} /></div> : null}

        {!isNew && (
          <div className="mt-4 border-t border-[#e3e6ec] pt-3">
            <label className="label">Send test to</label>
            <div className="flex gap-2">
              <input
                className="input"
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
              />
              <button
                className="btn-ghost whitespace-nowrap"
                disabled={!testTo || sendTest.isPending}
                onClick={() => sendTest.mutate()}
              >
                Send test
              </button>
            </div>
            {sendTest.isSuccess && <div className="mt-1 text-xs text-ok">Test sent.</div>}
            {sendTest.error ? <div className="mt-1"><ErrorNote error={sendTest.error} /></div> : null}
          </div>
        )}
      </div>

      <div className="card">
        <div className="label">Preview</div>
        {doPreview.error ? (
          <ErrorNote error={doPreview.error} />
        ) : preview ? (
          <>
            <div className="mb-2 border-b border-[#e3e6ec] pb-2 text-sm font-medium">
              {preview.subject}
            </div>
            <iframe
              title="preview"
              className="h-[28rem] w-full rounded border border-[#e3e6ec] bg-white"
              srcDoc={preview.html}
            />
          </>
        ) : (
          <div className="text-sm text-slate-550">
            Save the template, then click Preview to render it with sample values.
          </div>
        )}
      </div>
    </div>
  );
}
