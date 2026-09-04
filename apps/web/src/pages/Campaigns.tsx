import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { Badge, campaignTone, EmptyState, ErrorNote, Modal, Spinner, Table } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { describeError, useToast } from "../components/toast";
import { CampaignAssistant } from "../components/CampaignAssistant";
import {
  buildCron,
  buildOnceISO,
  defaultOnceForm,
  defaultScheduleForm,
  describeCron,
  formatDateTime,
  Frequency,
  from24Hour,
  isOnceInFuture,
  Meridiem,
  OnceForm,
  parseCron,
  ScheduleForm,
  todayLocalISODate,
  WEEKDAYS,
} from "../lib/schedule";

interface Campaign {
  id: string;
  name: string;
  status: string;
  scheduleType: "ONCE" | "RECURRING";
  sendAt?: string | null;
  cronExpression?: string | null;
  templateId: string;
  listId: string;
  template: { name: string };
  list: { name: string };
}

const EDITABLE_STATUSES = ["DRAFT", "PAUSED"];
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
  const confirm = useConfirm();
  const toast = useToast();
  const { user } = useAuth();
  const [wizard, setWizard] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api<{ items: Campaign[] }>("/api/campaigns"),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api(`/api/campaigns/${id}/send-now`, { method: "POST", notify: false }),
    onSettled: () => setRunId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Campaign is being dispatched");
    },
    onError: (err) => toast.fromError(err, "Couldn't start this campaign"),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/campaigns/${id}`, { method: "DELETE", notify: false }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Campaign deleted");
    },
    onError: (err) => toast.fromError(err, "Couldn't delete this campaign"),
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
        <>
          <Table head={["Name", "Template", "List", "Schedule", "Status", ""]}>
            {data!.items.map((c) => (
              <tr key={c.id} className="border-b border-[#f0f2f6] last:border-0">
                <td className="px-4 py-2.5">
                  <Link className="font-medium text-accent-ink hover:underline" to={`/campaigns/${c.id}`}>
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-slate-550">{c.template.name}</td>
                <td className="px-4 py-2.5 text-slate-550">{c.list.name}</td>
                <td className="px-4 py-2.5 text-xs text-slate-550">
                  {c.scheduleType === "ONCE"
                    ? c.sendAt
                      ? formatDateTime(c.sendAt)
                      : "once"
                    : describeCron(c.cronExpression)}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={campaignTone[c.status] ?? "neutral"}>{c.status}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-3">
                    {user?.role === "ADMIN" && c.status !== "SENDING" ? (
                      <button
                        className="btn-primary"
                        disabled={runNow.isPending}
                        title="Dispatch this campaign to its whole list now"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Run "${c.name}" now?`,
                            body: `This sends to every contact on ${c.list.name}.`,
                            confirmText: "Run now",
                          });
                          if (ok) {
                            setRunId(c.id);
                            runNow.mutate(c.id);
                          }
                        }}
                      >
                        {runNow.isPending && runId === c.id ? "Starting…" : "Run now"}
                      </button>
                    ) : null}
                    {EDITABLE_STATUSES.includes(c.status) ? (
                      <button
                        className="text-xs text-accent-ink hover:underline"
                        title="Edit this campaign"
                        onClick={() => setEditId(c.id)}
                      >
                        Edit
                      </button>
                    ) : null}
                    {c.status !== "SENDING" ? (
                      <button
                        className="text-xs text-crit hover:underline disabled:opacity-50"
                        disabled={del.isPending}
                        title="Delete this campaign"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Delete campaign "${c.name}"?`,
                            body: "This cannot be undone.",
                            confirmText: "Delete",
                            tone: "danger",
                          });
                          if (ok) del.mutate(c.id);
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <Modal open={wizard} onClose={() => setWizard(false)} title="New campaign">
        <CampaignForm
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["campaigns"] });
            setWizard(false);
          }}
        />
      </Modal>

      <Modal open={!!editId} onClose={() => setEditId(null)} title="Edit campaign">
        {editId ? (
          <CampaignForm
            campaign={data?.items.find((c) => c.id === editId)}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["campaigns"] });
              setEditId(null);
            }}
          />
        ) : null}
      </Modal>

      <CampaignAssistant onNewCampaign={() => setWizard(true)} />
    </div>
  );
}

/** Reconstruct the one-time picker fields from a stored ISO timestamp. */
function onceFormFromISO(iso: string): OnceForm {
  const d = new Date(iso);
  const { hour12, meridiem } = from24Hour(d.getHours());
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return { date, hour12, minute: d.getMinutes(), meridiem };
}

function CampaignForm({ campaign, onDone }: { campaign?: Campaign; onDone: () => void }) {
  const editing = !!campaign;
  const toast = useToast();
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ items: Template[] }>("/api/templates"),
  });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api<{ items: List[] }>("/api/lists") });

  const [form, setForm] = useState(() => ({
    name: campaign?.name ?? "",
    templateId: campaign?.templateId ?? "",
    listId: campaign?.listId ?? "",
    scheduleType: (campaign?.scheduleType ?? "ONCE") as "ONCE" | "RECURRING",
    once: campaign?.sendAt ? onceFormFromISO(campaign.sendAt) : defaultOnceForm(),
    schedule: parseCron(campaign?.cronExpression) ?? defaultScheduleForm(),
  }));
  const setSchedule = (patch: Partial<ScheduleForm>) =>
    setForm((f) => ({ ...f, schedule: { ...f.schedule, ...patch } }));
  const setOnce = (patch: Partial<OnceForm>) =>
    setForm((f) => ({ ...f, once: { ...f.once, ...patch } }));
  const selectedList = lists.data?.items.find((l) => l.id === form.listId);
  const emptyList = !!selectedList && selectedList._count.members === 0;
  const pastSend = form.scheduleType === "ONCE" && !isOnceInFuture(form.once);

  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        templateId: form.templateId,
        listId: form.listId,
        scheduleType: form.scheduleType,
      };
      // Only send the field this schedule type actually uses; the API rejects the
      // one it doesn't expect. Editing keeps `null` to clear the other field.
      if (form.scheduleType === "ONCE") {
        body.sendAt = buildOnceISO(form.once);
        if (editing) body.cronExpression = null;
      } else {
        body.cronExpression = buildCron(form.schedule);
        if (editing) body.sendAt = null;
      }
      if (editing) {
        return api(`/api/campaigns/${campaign!.id}`, { method: "PUT", json: body, notify: false });
      }
      const c = await api<Campaign>("/api/campaigns", { method: "POST", json: body, notify: false });
      await api(`/api/campaigns/${c.id}/schedule`, { method: "POST", notify: false });
      return c;
    },
    onSuccess: () => {
      toast.success(editing ? "Campaign saved" : "Campaign created and scheduled");
      onDone();
    },
    onError: (err) =>
      toast.fromError(err, editing ? "Couldn't save the campaign" : "Couldn't create the campaign"),
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
      {selectedList && selectedList._count.members === 0 ? (
        <p className="mb-3 -mt-2 text-xs text-warn">
          “{selectedList.name}” has no members —{" "}
          <Link to={`/lists/${selectedList.id}`} className="underline hover:no-underline">
            add contacts
          </Link>{" "}
          before this campaign can send.
        </p>
      ) : null}

      <label className="label">Schedule</label>
      <div className="mb-3 flex flex-wrap gap-2">
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
        <div className="mb-3 space-y-3">
          <div>
            <label className="label">Date</label>
            <input
              className="input"
              type="date"
              min={todayLocalISODate()}
              value={form.once.date}
              onChange={(e) => setOnce({ date: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="label">Time</label>
            <TimeFields
              hour12={form.once.hour12}
              minute={form.once.minute}
              meridiem={form.once.meridiem}
              onChange={setOnce}
            />
          </div>
          {form.once.date ? (
            pastSend ? (
              <p className="text-xs text-warn">Pick a date and time in the future.</p>
            ) : (
              <p className="text-xs text-slate-550">
                Sends {formatDateTime(buildOnceISO(form.once))}.
              </p>
            )
          ) : null}
        </div>
      ) : (
        <>
          <RecurringPicker schedule={form.schedule} onChange={setSchedule} />
          <p className="mb-3 text-xs text-slate-550">
            Sends {describeCron(buildCron(form.schedule)).toLowerCase()}.
          </p>
        </>
      )}

      {create.error
        ? (() => {
            const { title, lines } = describeError(create.error);
            return (
              <div className="rounded-lg bg-[#f9ebe9] px-3 py-2 text-sm text-crit">
                <p className="font-medium">{title}</p>
                {lines.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                    {lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })()
        : null}
      <div className="mt-4 flex justify-end">
        <button
          className="btn-primary"
          disabled={create.isPending || (!editing && emptyList) || pastSend}
        >
          {editing ? "Save changes" : "Create & schedule"}
        </button>
      </div>
    </form>
  );
}

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "MONTHLY", label: "Monthly" },
];

function RecurringPicker({
  schedule,
  onChange,
}: {
  schedule: ScheduleForm;
  onChange: (patch: Partial<ScheduleForm>) => void;
}) {
  return (
    <div className="mb-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        {FREQUENCIES.map((f) => (
          <button
            key={f.value}
            type="button"
            className={schedule.frequency === f.value ? "btn-primary" : "btn-ghost"}
            onClick={() => onChange({ frequency: f.value })}
          >
            {f.label}
          </button>
        ))}
      </div>

      {schedule.frequency === "WEEKLY" ? (
        <div>
          <label className="label">Day of week</label>
          <select
            className="input"
            value={schedule.weekday}
            onChange={(e) => onChange({ weekday: Number(e.target.value) })}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {schedule.frequency === "MONTHLY" ? (
        <div>
          <label className="label">Day of month</label>
          <select
            className="input"
            value={schedule.monthday}
            onChange={(e) => onChange({ monthday: Number(e.target.value) })}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <label className="label">Time</label>
        <TimeFields
          hour12={schedule.hour12}
          minute={schedule.minute}
          meridiem={schedule.meridiem}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function TimeFields({
  hour12,
  minute,
  meridiem,
  onChange,
}: {
  hour12: number;
  minute: number;
  meridiem: Meridiem;
  onChange: (patch: { hour12?: number; minute?: number; meridiem?: Meridiem }) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        className="input w-20"
        value={hour12}
        onChange={(e) => onChange({ hour12: Number(e.target.value) })}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className="text-slate-550">:</span>
      <select
        className="input w-20"
        value={minute}
        onChange={(e) => onChange({ minute: Number(e.target.value) })}
      >
        {Array.from({ length: 60 }, (_, i) => i).map((m) => (
          <option key={m} value={m}>
            {String(m).padStart(2, "0")}
          </option>
        ))}
      </select>
      <select
        className="input w-20"
        value={meridiem}
        onChange={(e) => onChange({ meridiem: e.target.value as Meridiem })}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}
