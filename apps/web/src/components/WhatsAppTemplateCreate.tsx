import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createMetaTemplateInput,
  DISPATCH_TEMPLATE_FIELDS,
  META_TEMPLATE_LANGUAGES,
  orderTemplateButtons,
  placeholdersIn,
  TEMPLATE_BUTTON_LIMITS,
  TEMPLATE_HEADER_TYPES,
  toMetaTemplateName,
  type DispatchTemplateField,
  type TemplateButtonType,
  type TemplateHeaderType,
} from "@dispatch/shared";
import { formatBytes, uploadWithProgress } from "../lib/whatsappMedia";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { ErrorNote } from "./ui";
import { useBranding } from "../lib/branding";
import { IDLE_DRAFT_STATUS, useDraftAutosave, useTemplateDraftsEnabled, type DraftStatus } from "../lib/templateDrafts";

/**
 * Dispatch → Meta: build a template and submit it for Meta's review. It is
 * registered here at once; its badge shows the review status (Pending →
 * Verified, or Failed if Meta rejects it).
 */

const FIELD_LABEL: Record<DispatchTemplateField, string> = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  business_name: "Business name",
  phone: "Phone",
};
const HEADER_ACCEPT: Record<string, string> = {
  IMAGE: ".jpg,.jpeg,.png,image/jpeg,image/png",
  VIDEO: ".mp4,video/mp4",
  DOCUMENT: ".pdf,application/pdf",
};
const HEADER_HINT: Record<string, string> = {
  IMAGE: "JPG or PNG, up to 5 MB",
  VIDEO: "MP4, up to 16 MB",
  DOCUMENT: "PDF, up to 100 MB",
};

/** A button row in the form; only the fields its type uses are submitted. */
interface ButtonDraft {
  type: TemplateButtonType;
  text: string;
  url: string;
  phone_number: string;
}
const BUTTON_TYPE_LABEL: Record<TemplateButtonType, string> = {
  QUICK_REPLY: "Custom",
  URL: "Visit website",
  VOICE_CALL: "Call on WhatsApp",
  PHONE_NUMBER: "Call phone number",
};
const BUTTON_DEFAULT_TEXT: Record<TemplateButtonType, string> = {
  QUICK_REPLY: "",
  URL: "Visit website",
  VOICE_CALL: "Call on WhatsApp",
  PHONE_NUMBER: "Call us",
};
/** Meta's "Add button" menu, in Meta's order. Entries without a type need a value on every send. */
const BUTTON_MENU: { group: string; items: { label: string; type?: TemplateButtonType; hint: string }[] }[] = [
  { group: "Quick reply buttons", items: [{ label: "Custom", type: "QUICK_REPLY", hint: "Customer taps it to reply with this text" }] },
  {
    group: "Call-to-action buttons",
    items: [
      { label: "Visit website", type: "URL", hint: "Opens a web address (up to 2)" },
      { label: "Call on WhatsApp", type: "VOICE_CALL", hint: "Starts a WhatsApp call to your business number" },
      { label: "Call phone number", type: "PHONE_NUMBER", hint: "Dials a phone number" },
      { label: "Complete flow", hint: "Not supported yet" },
      { label: "Copy offer code", hint: "Not supported yet" },
      { label: "Share contact info", hint: "Not supported yet" },
    ],
  },
];
const quickReply = (text: string): ButtonDraft => ({ type: "QUICK_REPLY", text, url: "", phone_number: "" });

function toButtonInput(b: ButtonDraft) {
  const text = b.text.trim();
  if (b.type === "URL") return { type: b.type, text, url: b.url.trim() };
  if (b.type === "PHONE_NUMBER") return { type: b.type, text, phone_number: b.phone_number.trim() };
  return { type: b.type, text };
}

/** "+ Add button" with Meta's menu; types at their Meta limit are disabled. */
function AddButtonMenu({ buttons, onAdd }: { buttons: ButtonDraft[]; onAdd: (type: TemplateButtonType) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const full = (t: TemplateButtonType) => buttons.filter((b) => b.type === t).length >= TEMPLATE_BUTTON_LIMITS[t];
  return (
    <div ref={wrap} className="relative inline-block">
      <button type="button" className="text-xs text-accent-ink hover:underline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        + Add button
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-72 rounded-xl border border-line/70 bg-surface p-1.5 shadow-pop animate-dialog-in">
          {BUTTON_MENU.map((g) => (
            <div key={g.group} className="py-1">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-550">{g.group}</div>
              {g.items.map((it) => {
                const disabled = !it.type || full(it.type);
                return (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    disabled={disabled}
                    className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    onClick={() => {
                      onAdd(it.type!);
                      setOpen(false);
                    }}
                  >
                    <span>{it.label}</span>
                    <span className="text-xs text-slate-550">{it.type && full(it.type) ? "Meta's limit reached" : it.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A saved "Create in Meta" draft (ENABLE_TEMPLATE_DRAFTS): the form's own fields. The header file itself isn't kept. */
export interface MetaDraftState {
  displayName: string;
  name: string;
  nameTouched: boolean;
  language: string;
  category: "MARKETING" | "UTILITY";
  headerType: TemplateHeaderType;
  headerText: string;
  /** The attached header file's name, to ask for the file again on resume. */
  headerFileName: string | null;
  body: string;
  vars: { field: DispatchTemplateField; example: string }[];
  footer: string;
  buttons: ButtonDraft[];
}

/** A draft's fields that have the right type; anything missing or wrong falls back to the form's own default. */
function draftSeed(raw: unknown): Partial<MetaDraftState> {
  if (!raw || typeof raw !== "object") return {};
  const s = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const out: Partial<MetaDraftState> = {};
  for (const k of ["displayName", "name", "language", "headerText", "body", "footer"] as const) {
    if (typeof s[k] === "string") out[k] = s[k] as string;
  }
  if (typeof s.nameTouched === "boolean") out.nameTouched = s.nameTouched;
  if (s.category === "MARKETING" || s.category === "UTILITY") out.category = s.category;
  if ((TEMPLATE_HEADER_TYPES as readonly unknown[]).includes(s.headerType)) out.headerType = s.headerType as TemplateHeaderType;
  if (typeof s.headerFileName === "string") out.headerFileName = s.headerFileName;
  if (Array.isArray(s.vars)) {
    out.vars = s.vars
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      .map((v) => ({
        field: (DISPATCH_TEMPLATE_FIELDS as readonly unknown[]).includes(v.field) ? (v.field as DispatchTemplateField) : "first_name",
        example: str(v.example),
      }));
  }
  if (Array.isArray(s.buttons)) {
    out.buttons = s.buttons
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && typeof b.type === "string" && b.type in BUTTON_TYPE_LABEL)
      .map((b) => ({ type: b.type as TemplateButtonType, text: str(b.text), url: str(b.url), phone_number: str(b.phone_number) }));
  }
  return out;
}

export function CreateInMetaForm({
  onClose,
  draft,
  onDraftStatus,
}: {
  onClose: () => void;
  /** Template drafts (ENABLE_TEMPLATE_DRAFTS): the draft this form was resumed from. */
  draft?: { id: string; state: unknown } | null;
  /** Template drafts: the "Draft saved 10:42" note, for the dialog header. */
  onDraftStatus?: (status: DraftStatus) => void;
}) {
  const { appName } = useBranding();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [seed] = useState(() => draftSeed(draft?.state)); // {} without a draft: every field starts as before
  const [displayName, setDisplayName] = useState(seed.displayName ?? "");
  const [name, setName] = useState(seed.name ?? "");
  const [nameTouched, setNameTouched] = useState(seed.nameTouched ?? false);
  const [language, setLanguage] = useState(seed.language ?? "en");
  const [category, setCategory] = useState<"MARKETING" | "UTILITY">(seed.category ?? "MARKETING");
  const [headerType, setHeaderType] = useState<TemplateHeaderType>(seed.headerType ?? "NONE");
  const [headerText, setHeaderText] = useState(seed.headerText ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [body, setBody] = useState(seed.body ?? "Hi {{1}}, ");
  const [vars, setVars] = useState<{ field: DispatchTemplateField; example: string }[]>(seed.vars ?? [{ field: "first_name", example: "" }]);
  const [footer, setFooter] = useState(seed.footer ?? "");
  const [buttons, setButtons] = useState<ButtonDraft[]>(seed.buttons ?? [quickReply("Yes, interested"), quickReply("Not now")]);
  const [progress, setProgress] = useState<number | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  // Keep one variable row per {{n}} in the body.
  const count = useMemo(() => new Set(placeholdersIn(body).filter((p) => /^\d+$/.test(p))).size, [body]);
  const rows: { field: DispatchTemplateField; example: string }[] = Array.from(
    { length: count },
    (_, i) => vars[i] ?? { field: i === 1 ? "business_name" : "first_name", example: "" },
  );

  const input = {
    displayName,
    name: nameTouched ? name : toMetaTemplateName(displayName),
    language,
    category,
    headerType,
    headerText: headerType === "TEXT" ? headerText : null,
    body,
    variables: rows,
    footer: footer || null,
    buttons: buttons.map(toButtonInput),
  };
  // Template drafts (ENABLE_TEMPLATE_DRAFTS). Off: nothing is saved and the form works exactly as before.
  const draftsOn = useTemplateDraftsEnabled();
  const autosave = useDraftAutosave<MetaDraftState>({
    enabled: draftsOn,
    channel: "whatsapp",
    draftId: draft?.id,
    state: {
      displayName,
      name,
      nameTouched,
      language,
      category,
      headerType,
      headerText,
      // A file can't be kept in a draft; its name is, so resuming asks for it again.
      headerFileName: file?.name ?? (headerType === seed.headerType ? (seed.headerFileName ?? null) : null),
      body,
      vars,
      footer,
      buttons,
    },
    name: displayName.trim() || input.name,
  });
  useEffect(() => {
    onDraftStatus?.(autosave.status);
    return () => onDraftStatus?.(IDLE_DRAFT_STATUS); // closed: no note on the next "New template"
  }, [autosave.status, onDraftStatus]);
  const setButton = (i: number, patch: Partial<ButtonDraft>) => setButtons(buttons.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const check = createMetaTemplateInput.safeParse(input);
  const mediaHeader = headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT";
  const problems = [
    ...(check.success ? [] : check.error.issues.map((i) => i.message)),
    ...(mediaHeader && !file ? [`Attach the header ${headerType.toLowerCase()} (Meta reviews it as the example)`] : []),
  ];

  function addVariable() {
    const el = bodyRef.current;
    const token = `{{${count + 1}}}`;
    if (!el) return setBody((b) => b + token);
    const s = el.selectionStart ?? body.length;
    const e = el.selectionEnd ?? body.length;
    setBody(body.slice(0, s) + token + body.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  }

  const submit = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("template", JSON.stringify(check.success ? check.data : input));
      if (mediaHeader && file) form.append("file", file);
      setProgress(0);
      return uploadWithProgress<{ meta: { id: string; status: string } }>("POST", "/api/whatsapp/templates/meta-create", form, setProgress);
    },
    onSettled: () => setProgress(null),
    onSuccess: (r) => {
      void autosave.finish(); // the real template exists now: delete its draft (no-op with drafts off)
      toast.success(`Submitted to Meta — status ${r.meta.status.toLowerCase()}`, [
        "It is registered here already; the badge turns Verified once Meta approves it.",
      ]);
      void qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-template-verify"] });
      onClose();
    },
  });

  async function onSubmit() {
    setShowErrors(true);
    if (problems.length) return;
    const ok = await confirm({
      title: "Submit this template to Meta for review?",
      body: `Meta reviews “${input.name}” (${language}). Approval usually takes minutes, sometimes up to 24 hours. Nothing is sent to customers.`,
      confirmText: "Submit to Meta",
    });
    if (ok) submit.mutate();
  }

  const preview = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => rows[Number(n) - 1]?.example || `{{${n}}}`);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name in {appName}</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Company Intro" required />
          </div>
          <div>
            <label className="label">Meta template name</label>
            <input
              className="input font-mono text-xs"
              value={input.name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value.toLowerCase());
              }}
              placeholder="company_intro"
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Category</label>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value as "MARKETING" | "UTILITY")}>
              <option value="MARKETING">Marketing — offers, intros, follow-ups</option>
              <option value="UTILITY">Utility — updates about an existing request</option>
            </select>
          </div>
          <div>
            <label className="label">Language</label>
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {META_TEMPLATE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} ({l.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Header (optional)</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              className="input sm:w-40"
              value={headerType}
              onChange={(e) => {
                setHeaderType(e.target.value as TemplateHeaderType);
                setFile(null);
              }}
            >
              <option value="NONE">None</option>
              <option value="TEXT">Text</option>
              <option value="IMAGE">Image</option>
              <option value="VIDEO">Video</option>
              <option value="DOCUMENT">Document</option>
            </select>
            {headerType === "TEXT" && (
              <input className="input flex-1" maxLength={60} value={headerText} onChange={(e) => setHeaderText(e.target.value)} placeholder="Kagzso" />
            )}
            {mediaHeader && (
              <div className="flex-1">
                <input type="file" accept={HEADER_ACCEPT[headerType]} className="block text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <p className="mt-1 text-xs text-slate-550">
                  {file ? `${file.name} · ${formatBytes(file.size)}` : HEADER_HINT[headerType]} — also used as the header when sending.
                </p>
                {!file && seed.headerFileName && headerType === seed.headerType && (
                  <p className="mt-1 text-xs text-warn">Attach the file again: drafts don't keep files (it was {seed.headerFileName}).</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-end justify-between">
            <label className="label">Body</label>
            <button type="button" className="mb-1 text-xs text-accent-ink hover:underline" disabled={count >= 10} onClick={addVariable}>
              + Add variable
            </button>
          </div>
          <textarea ref={bodyRef} className="input min-h-[7rem]" maxLength={1024} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="text-xs text-slate-550">{body.length}/1024 · Variables are numbered {"{{1}}"}, {"{{2}}"} … and can't be the very first or last thing.</p>
        </div>

        {rows.length > 0 && (
          <div className="space-y-2 rounded-lg bg-surface-muted px-3 py-2.5">
            {rows.map((v, i) => (
              <div key={i} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2 text-sm">
                <code className="text-xs">{`{{${i + 1}}}`}</code>
                <select
                  className="input py-1.5"
                  aria-label={`Variable ${i + 1} filled from`}
                  value={v.field}
                  onChange={(e) => setVars(rows.map((r, j) => (j === i ? { ...r, field: e.target.value as DispatchTemplateField } : r)))}
                >
                  {DISPATCH_TEMPLATE_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABEL[f]}
                    </option>
                  ))}
                </select>
                <input
                  className="input py-1.5"
                  placeholder="Example for Meta, e.g. Karthick"
                  value={v.example}
                  onChange={(e) => setVars(rows.map((r, j) => (j === i ? { ...r, example: e.target.value } : r)))}
                />
              </div>
            ))}
          </div>
        )}

        <div>
          <label className="label">Footer (optional)</label>
          <input className="input" maxLength={60} value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="AI | Automation | App Development" />
        </div>

        <div>
          <label className="label">Buttons (optional, up to 10)</label>
          <div className="space-y-2">
            {buttons.map((b, i) => (
              <div key={i} className="flex gap-2">
                <div className="grid flex-1 gap-2 sm:grid-cols-[8.5rem_1fr]">
                  <span className="self-center text-xs font-medium text-slate-550">{BUTTON_TYPE_LABEL[b.type]}</span>
                  <input
                    className="input"
                    maxLength={25}
                    aria-label={`${BUTTON_TYPE_LABEL[b.type]} button text`}
                    placeholder="Button text"
                    value={b.text}
                    onChange={(e) => setButton(i, { text: e.target.value })}
                  />
                  {b.type === "URL" && (
                    <input
                      className="input sm:col-start-2"
                      type="url"
                      aria-label="Website address"
                      placeholder="https://kagzso.com"
                      value={b.url}
                      onChange={(e) => setButton(i, { url: e.target.value })}
                    />
                  )}
                  {b.type === "PHONE_NUMBER" && (
                    <input
                      className="input sm:col-start-2"
                      type="tel"
                      aria-label="Phone number"
                      placeholder="+919876543210"
                      value={b.phone_number}
                      onChange={(e) => setButton(i, { phone_number: e.target.value })}
                    />
                  )}
                </div>
                <button type="button" className="btn-ghost self-start px-2.5 text-crit" aria-label="Remove button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            {buttons.length < 10 && (
              <AddButtonMenu
                buttons={buttons}
                onAdd={(type) => setButtons([...buttons, { ...quickReply(BUTTON_DEFAULT_TEXT[type]), type }])}
              />
            )}
            {buttons.some((b) => b.type === "QUICK_REPLY") && buttons.some((b) => b.type !== "QUICK_REPLY") && (
              <p className="text-xs text-slate-550">Meta shows custom buttons first, then website and call buttons.</p>
            )}
          </div>
        </div>

        {showErrors && problems.length > 0 && (
          <ul className="list-disc rounded-lg bg-crit-soft py-2 pl-6 pr-3 text-xs text-crit">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {progress !== null && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-gradient-accent transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
        {submit.error && <ErrorNote error={submit.error} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={submit.isPending}>
            {submit.isPending ? "Submitting…" : "Submit to Meta"}
          </button>
        </div>
      </form>

      <div className="hidden lg:block">
        <div className="label">Preview</div>
        <div className="rounded-xl bg-[#e5ddd5] p-3">
          <div className="rounded-lg bg-white p-2.5 text-sm shadow-sm">
            {headerType === "TEXT" && headerText && <div className="mb-1 font-semibold">{headerText}</div>}
            {mediaHeader && (
              <div className="mb-2 grid h-24 place-items-center rounded bg-surface-muted text-xs text-slate-550">
                {headerType.toLowerCase()}
                {file ? ` · ${file.name}` : ""}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words">{preview}</div>
            {footer && <div className="mt-1 text-xs text-slate-400">{footer}</div>}
          </div>
          {orderTemplateButtons(buttons)
            .filter((b) => b.text.trim())
            .map((b, i) => (
              <div key={i} className="mt-1 rounded-lg bg-white py-1.5 text-center text-sm text-[#00a5f4] shadow-sm">
                {b.type === "URL" ? "↗ " : b.type === "QUICK_REPLY" ? "" : "✆ "}
                {b.text}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
