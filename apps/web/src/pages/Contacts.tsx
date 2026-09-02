import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, ErrorNote, Modal, Spinner, Table } from "../components/ui";

interface Contact {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  status: string;
  createdAt: string;
}
interface Page {
  items: Contact[];
  total: number;
  page: number;
  pageSize: number;
}

const statusTone: Record<string, "ok" | "warn" | "crit" | "neutral"> = {
  ACTIVE: "ok",
  UNSUBSCRIBED: "warn",
  BOUNCED: "crit",
  COMPLAINED: "crit",
};

export function ContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ["contacts", search, status, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (search) p.set("search", search);
      if (status) p.set("status", status);
      return api<Page>(`/api/contacts?${p}`);
    },
  });

  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<{ jobId: string }>("/api/contacts/import", { method: "POST", body: fd });
    },
    onSuccess: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ["contacts"] }), 1500);
    },
  });

  return (
    <div>
      <PageHeader
        title="Contacts"
        action={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              Import CSV
            </button>
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              Add contact
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importMut.mutate(f);
                e.target.value = "";
              }}
            />
          </div>
        }
      />

      {importMut.isPending && <div className="mb-3 text-sm text-slate-550">Uploading CSV…</div>}
      {importMut.isSuccess && (
        <div className="mb-3 text-sm text-ok">Import queued — refreshing shortly.</div>
      )}

      <div className="mb-4 flex gap-2">
        <input
          className="input max-w-xs"
          placeholder="Search email or name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="input max-w-[12rem]"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {["ACTIVE", "UNSUBSCRIBED", "BOUNCED", "COMPLAINED"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : (
        <>
          <Table head={["Email", "Name", "Status", "Added"]}>
            {query.data!.items.map((c) => (
              <tr key={c.id} className="border-b border-[#f0f2f6] last:border-0">
                <td className="px-4 py-2.5 font-mono text-xs">{c.email}</td>
                <td className="px-4 py-2.5">
                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone[c.status] ?? "neutral"}>{c.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-slate-550">
                  {new Date(c.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </Table>
          <Pagination
            page={query.data!.page}
            pageSize={query.data!.pageSize}
            total={query.data!.total}
            onChange={setPage}
          />
        </>
      )}

      <AddContactModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-550">
      <span>{total} contacts</span>
      <div className="flex gap-2">
        <button className="btn-ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Prev
        </button>
        <span className="px-2 py-2">
          {page} / {pages}
        </span>
        <button className="btn-ghost" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

function AddContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      api("/api/contacts", {
        method: "POST",
        json: { email, firstName: firstName || undefined, lastName: lastName || undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      setEmail("");
      setFirst("");
      setLast("");
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <label className="label">Email</label>
        <input className="input mb-3" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="label">First name</label>
            <input className="input" value={firstName} onChange={(e) => setFirst(e.target.value)} />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={lastName} onChange={(e) => setLast(e.target.value)} />
          </div>
        </div>
        {mut.error && <ErrorNote error={mut.error} />}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={mut.isPending}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}
