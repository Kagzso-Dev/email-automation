import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, EmptyState, ErrorNote, Modal, Spinner, Table } from "../components/ui";

interface Member {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
  status: string;
  addedAt: string;
}
interface ListDetail {
  id: string;
  name: string;
  description?: string | null;
  _count: { members: number };
}
interface ContactPage {
  items: Array<{
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    status: string;
  }>;
  total: number;
}

const statusTone: Record<string, "ok" | "warn" | "crit" | "neutral"> = {
  ACTIVE: "ok",
  UNSUBSCRIBED: "warn",
  BOUNCED: "crit",
  COMPLAINED: "crit",
};

function contactName(c: { firstName?: string | null; lastName?: string | null }) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ");
}

export function ListDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["list", id] });
    qc.invalidateQueries({ queryKey: ["list-members", id] });
    qc.invalidateQueries({ queryKey: ["lists"] });
  };

  const list = useQuery({
    queryKey: ["list", id],
    queryFn: () => api<ListDetail>(`/api/lists/${id}`),
  });
  const members = useQuery({
    queryKey: ["list-members", id],
    queryFn: () => api<{ items: Member[] }>(`/api/lists/${id}/members`),
  });

  const remove = useMutation({
    mutationFn: (contactId: string) =>
      api(`/api/lists/${id}/members/${contactId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorNote error={list.error} />;
  const l = list.data!;

  return (
    <div>
      <Link to="/lists" className="text-sm text-accent-ink hover:underline">
        ← Lists
      </Link>
      <div className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{l.name}</h1>
          <p className="mt-1 text-sm text-slate-550">
            {l._count.members} {l._count.members === 1 ? "member" : "members"}
            {l.description ? ` · ${l.description}` : ""}
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => setShowAdd(true)}>
          Add members
        </button>
      </div>

      {remove.error && (
        <div className="mb-3">
          <ErrorNote error={remove.error} />
        </div>
      )}

      {members.isLoading ? (
        <Spinner />
      ) : members.error ? (
        <ErrorNote error={members.error} />
      ) : members.data!.items.length === 0 ? (
        <EmptyState>No members yet. Use “Add members” to put contacts in this list.</EmptyState>
      ) : (
        <Table head={["Email", "Name", "Business", "Status", "Added", ""]}>
          {members.data!.items.map((m) => (
            <tr key={m.id} className="border-b border-[#f0f2f6] last:border-0">
              <td className="px-4 py-2.5 font-mono text-xs">{m.email}</td>
              <td className="px-4 py-2.5">{contactName(m) || "—"}</td>
              <td className="px-4 py-2.5">{m.businessName || "—"}</td>
              <td className="px-4 py-2.5">
                <Badge tone={statusTone[m.status] ?? "neutral"}>{m.status}</Badge>
              </td>
              <td className="px-4 py-2.5 text-slate-550">
                {new Date(m.addedAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2.5 text-right">
                <button
                  className="text-xs text-crit hover:underline disabled:opacity-50"
                  disabled={remove.isPending}
                  title="Remove from this list"
                  onClick={() => remove.mutate(m.id)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <AddMembersModal
        listId={id!}
        open={showAdd}
        onClose={() => setShowAdd(false)}
        currentMemberIds={new Set(members.data?.items.map((m) => m.id))}
        onAdded={invalidate}
      />
    </div>
  );
}

function AddMembersModal({
  listId,
  open,
  onClose,
  currentMemberIds,
  onAdded,
}: {
  listId: string;
  open: boolean;
  onClose: () => void;
  currentMemberIds: Set<string>;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({}); // id -> label

  const contacts = useQuery({
    queryKey: ["contacts", "list-picker", search],
    queryFn: () => {
      const p = new URLSearchParams({ page: "1", pageSize: "25", status: "ACTIVE" });
      if (search) p.set("search", search);
      return api<ContactPage>(`/api/contacts?${p}`);
    },
    enabled: open,
  });

  const add = useMutation({
    mutationFn: (ids: string[]) =>
      api(`/api/lists/${listId}/members`, { method: "POST", json: { add: ids } }),
    onSuccess: () => {
      onAdded();
      close();
    },
  });

  function close() {
    setSearch("");
    setSelected({});
    onClose();
  }

  const selectedIds = useMemo(() => Object.keys(selected), [selected]);

  return (
    <Modal open={open} onClose={close} title="Add members">
      <p className="mb-3 text-sm text-slate-550">
        Search your contacts and pick one or more to add to this list.
      </p>
      <input
        className="input mb-3"
        placeholder="Search email or name"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />

      {selectedIds.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {selectedIds.map((sid) => (
            <span
              key={sid}
              className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-ink"
            >
              {selected[sid]}
              <button
                type="button"
                aria-label={`Remove ${selected[sid]}`}
                className="font-mono leading-none"
                onClick={() =>
                  setSelected((s) => {
                    const next = { ...s };
                    delete next[sid];
                    return next;
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {contacts.error ? (
          <div className="p-3">
            <ErrorNote error={contacts.error} />
          </div>
        ) : !contacts.data ? (
          <div className="p-4 text-sm text-slate-550">Loading…</div>
        ) : contacts.data.items.length === 0 ? (
          <div className="p-4 text-sm text-slate-550">No matching contacts.</div>
        ) : (
          contacts.data.items.map((c) => {
            const already = currentMemberIds.has(c.id);
            const label = contactName(c) || c.email;
            const checked = !!selected[c.id];
            return (
              <label
                key={c.id}
                className={`flex items-center gap-2 border-b border-line-subtle px-3 py-2 text-sm last:border-0 ${
                  already ? "opacity-50" : "cursor-pointer hover:bg-surface-muted"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={already}
                  checked={checked || already}
                  onChange={(e) =>
                    setSelected((s) => {
                      const next = { ...s };
                      if (e.target.checked) next[c.id] = label;
                      else delete next[c.id];
                      return next;
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="font-medium">{label}</span>{" "}
                  <span className="font-mono text-xs text-slate-550">{c.email}</span>
                  {already && <span className="ml-1 text-xs text-slate-550">· already a member</span>}
                </span>
              </label>
            );
          })
        )}
      </div>

      {add.error && (
        <div className="mt-3">
          <ErrorNote error={add.error} />
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={add.isPending || selectedIds.length === 0}
          onClick={() => add.mutate(selectedIds)}
        >
          {add.isPending ? "Adding…" : `Add ${selectedIds.length || ""}`.trim()}
        </button>
      </div>
    </Modal>
  );
}
