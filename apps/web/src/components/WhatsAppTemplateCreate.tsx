import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createMetaTemplateInput,
  DISPATCH_TEMPLATE_FIELDS,
  META_TEMPLATE_LANGUAGES,
  placeholdersIn,
  toMetaTemplateName,
  type DispatchTemplateField,
  type TemplateHeaderType,
} from "@dispatch/shared";
import { formatBytes, uploadWithProgress } from "../lib/whatsappMedia";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { ErrorNote } from "./ui";
import { useBranding } from "../lib/branding";

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

export function CreateInMetaForm({ onClose }: { onClose: () => void }) {
  const { appName } = useBranding();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [language, setLanguage] = useState("en");
  const [category, setCategory] = useState<"MARKETING" | "UTILITY">("MARKETING");
  const [headerType, setHeaderType] = useState<TemplateHeaderType>("NONE");
  const [headerText, setHeaderText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [body, setBody] = useState("Hi {{1}}, ");
  const [vars, setVars] = useState<{ field: DispatchTemplateField; example: string }[]>([{ field: "first_name", example: "" }]);
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState<string[]>(["Yes, interested", "Not now"]);
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
    buttons: buttons.map((b) => b.trim()).filter(Boolean),
  };
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
          <label className="label">Quick-reply buttons (optional, up to 10)</label>
          <div className="space-y-2">
            {buttons.map((b, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="input"
                  maxLength={25}
                  value={b}
                  onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? e.target.value : x)))}
                />
                <button type="button" className="btn-ghost px-2.5 text-crit" aria-label="Remove button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            {buttons.length < 10 && (
              <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => setButtons([...buttons, ""])}>
                + Add button
              </button>
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
          {input.buttons.map((b) => (
            <div key={b} className="mt-1 rounded-lg bg-white py-1.5 text-center text-sm text-[#00a5f4] shadow-sm">
              {b}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
