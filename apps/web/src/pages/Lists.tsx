import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Modal, Spinner, Table } from "../components/ui";

interface List {
  id: string;
  name: string;
  description?: string | null;
  _count: { members: number; campaigns: number };
}

export function ListsPage() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["lists"],
    queryFn: () => api<{ items: List[] }>("/api/lists"),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      api("/api/lists", { method: "POST", json: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lists"] });
      setShow(false);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/lists/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });

  return (
    <div>
      <PageHeader
        title="Lists"
        action={
          <button className="btn-primary" onClick={() => setShow(true)}>
            New list
          </button>
        }
      />
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <ErrorNote error={error} />
      ) : data!.items.length === 0 ? (
        <EmptyState>No lists yet. Create one to group contacts for a campaign.</EmptyState>
      ) : (
        <Table head={["Name", "Members", "Campaigns", ""]}>
          {data!.items.map((l) => (
            <tr key={l.id} className="border-b border-[#f0f2f6] last:border-0">
              <td className="px-4 py-2.5">
                <div className="font-medium">{l.name}</div>
                {l.description && <div className="text-xs text-slate-550">{l.description}</div>}
              </td>
              <td className="px-4 py-2.5 font-mono tabular-nums">{l._count.members}</td>
              <td className="px-4 py-2.5 font-mono tabular-nums">{l._count.campaigns}</td>
              <td className="px-4 py-2.5 text-right">
                <button
                  className="text-xs text-crit hover:underline"
                  onClick={() => {
                    if (confirm(`Delete list "${l.name}"?`)) del.mutate(l.id);
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={show} onClose={() => setShow(false)} title="New list">
        <NewListForm onSubmit={(b) => create.mutate(b)} pending={create.isPending} error={create.error} />
      </Modal>
    </div>
  );
}

function NewListForm({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (b: { name: string; description?: string }) => void;
  pending: boolean;
  error: unknown;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, description: description || undefined });
      }}
    >
      <label className="label">Name</label>
      <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} required />
      <label className="label">Description</label>
      <input
        className="input"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error ? <div className="mt-2"><ErrorNote error={error} /></div> : null}
      <div className="mt-4 flex justify-end">
        <button className="btn-primary" disabled={pending}>
          Create
        </button>
      </div>
    </form>
  );
}
