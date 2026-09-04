import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "./toast";
import { ErrorNote, Modal } from "./ui";

/** A recipient for a WhatsApp send. `id` is a whatsapp_contacts id or an email
 * contacts id depending on `source`. */
export interface WhatsAppRecipient {
  id: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
}

interface WhatsAppTemplate {
  id: string;
  name: string;
  variables: string[];
  buttonLabels: string[];
}

/**
 * "Send WhatsApp message" for one or more selected contacts. Confirming creates a
 * server-side paced drip batch (one message at a time with a random gap) and
 * hands off immediately — the modal closes and progress is tracked on the Send
 * Queue page, not here. Used by both the WhatsApp Contacts page and the email
 * Contacts page — the WhatsApp code path is identical for both.
 */
export function SendWhatsApp({
  recipients,
  source,
  onClose,
  onSelectionConsumed,
}: {
  recipients: WhatsAppRecipient[] | null;
  source: "whatsapp" | "contacts";
  onClose: () => void;
  onSelectionConsumed?: () => void;
}) {
  const open = !!recipients && recipients.length > 0;
  const count = recipients?.length ?? 0;

  return (
    <Modal open={open} onClose={onClose} title={`Send WhatsApp message to ${count} contact${count === 1 ? "" : "s"}`}>
      {open ? (
        <SendBody
          key={recipients!.map((r) => r.id).join(",")}
          recipients={recipients!}
          source={source}
          onClose={onClose}
          onSelectionConsumed={onSelectionConsumed}
        />
      ) : null}
    </Modal>
  );
}

function SendBody({
  recipients,
  source,
  onClose,
  onSelectionConsumed,
}: {
  recipients: WhatsAppRecipient[];
  source: "whatsapp" | "contacts";
  onClose: () => void;
  onSelectionConsumed?: () => void;
}) {
  const toast = useToast();
  const [templateId, setTemplateId] = useState("");
  const [purgeAfter, setPurgeAfter] = useState(true);

  const templates = useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api<{ items: WhatsAppTemplate[] }>("/api/whatsapp/templates"),
  });

  const start = useMutation({
    mutationFn: () =>
      api<{ batchId: string }>("/api/whatsapp/send", {
        method: "POST",
        json: { templateId, contactIds: recipients.map((r) => r.id), source, purgeAfter },
        notify: false,
      }),
    onSuccess: () => {
      toast.success("WhatsApp send started", [
        "Track progress on the Send Queue page (WhatsApp tab).",
        ...(purgeAfter ? ["These contacts will be deleted once the batch finishes."] : []),
      ]);
      onSelectionConsumed?.();
      onClose();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <p className="mb-3 text-sm text-slate-550">
        Sends the selected template to all <b>{recipients.length}</b> selected contacts, one at a time
        with a random gap between each. Contacts with no valid phone number{" "}
        {source === "whatsapp" ? "or that aren't active " : ""}are skipped. Once you start, this window
        closes — follow the batch on the <b>Send Queue</b> page.
      </p>

      <label className="label">Template</label>
      <select
        className="input mb-3"
        value={templateId}
        onChange={(e) => setTemplateId(e.target.value)}
        disabled={start.isPending}
        required
      >
        <option value="">Select…</option>
        {templates.data?.items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {templates.data && templates.data.items.length === 0 && (
        <p className="mb-3 text-xs text-warn">
          No WhatsApp templates yet — create one on the WhatsApp Templates page first.
        </p>
      )}

      <label className="mb-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={purgeAfter}
          disabled={start.isPending}
          onChange={(e) => setPurgeAfter(e.target.checked)}
        />
        <span>
          Remove these contacts after the batch finishes
          <span className="block text-xs text-slate-550">
            For lead-generation blasts — deletes all {recipients.length} recipient
            {recipients.length === 1 ? "" : "s"} once every message is done.
          </span>
        </span>
      </label>

      {start.error && <ErrorNote error={start.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-whatsapp" disabled={start.isPending || !templateId}>
          {start.isPending ? "Starting…" : `Start sending (${recipients.length})`}
        </button>
      </div>
    </form>
  );
}
