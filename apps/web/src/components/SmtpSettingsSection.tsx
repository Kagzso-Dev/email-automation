import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/schedule";
import { useConfirm } from "./confirm";
import { Icon } from "./icons";
import { PasswordInput } from "./PasswordInput";
import { ErrorNote, Spinner } from "./ui";

/** GET /api/settings/smtp — never includes the password, only whether one is set. */
export interface SmtpSettingsView {
  provider: "smtp" | "mock";
  envProvider: "smtp" | "mock";
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
  hasPassword: boolean;
  passwordSource: "database" | "environment" | null;
  passwordUnreadable: boolean;
  saved: string[];
  source: "database" | "environment";
  updatedBy: string | null;
  updatedAt: string | null;
}

type TestResult =
  | { ok: true; provider: string; providerMessageId: string }
  | { ok: false; provider: string; error: string };

export const SMTP_SETTINGS_QUERY = ["smtp-settings"] as const;

interface Fields {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  from: string;
}

const fieldsOf = (v: SmtpSettingsView): Fields => ({
  host: v.host ?? "",
  port: String(v.port),
  secure: v.secure,
  user: v.user ?? "",
  from: v.from,
});

/**
 * Settings → Email (SMTP): the server, login, password and From address email is sent with. Admins edit it here
 * instead of .env (saved values win over .env, field by field); editors only see that it's admin-only. Renders
 * nothing when ENABLE_SMTP_SETTINGS=false.
 */
export function SmtpSettingsSection({ isAdmin }: { isAdmin: boolean }) {
  const config = useQuery({
    queryKey: ["send-config"],
    queryFn: () => api<{ smtpSettings?: boolean }>("/api/settings/config"),
  });
  if (!config.data?.smtpSettings) return null;

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Email (SMTP)</h2>
      {isAdmin ? (
        <SmtpSettingsForm />
      ) : (
        <div className="settings-card text-slate-550">Only admins can see and change the email (SMTP) account.</div>
      )}
    </section>
  );
}

function SmtpSettingsForm() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: SMTP_SETTINGS_QUERY,
    queryFn: () => api<SmtpSettingsView>("/api/settings/smtp"),
  });

  const [form, setForm] = useState<Fields>({ host: "", port: "587", secure: false, user: "", from: "" });
  const [password, setPassword] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testTo, setTestTo] = useState(user?.email ?? "");

  // Seed the form from the server — but never over edits the admin hasn't saved yet.
  useEffect(() => {
    if (data && !dirty) {
      setForm(fieldsOf(data));
      setPassword("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const edit = (patch: Partial<Fields>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  const test = useMutation({
    mutationFn: () =>
      api<TestResult>("/api/settings/smtp/test", { method: "POST", json: { to: testTo.trim() }, notify: false }),
  });

  const onSaved = (v: SmtpSettingsView) => {
    qc.setQueryData(SMTP_SETTINGS_QUERY, v);
    setForm(fieldsOf(v));
    setPassword("");
    setDirty(false);
    test.reset();
  };

  const save = useMutation({
    mutationFn: () =>
      api<SmtpSettingsView>("/api/settings/smtp", {
        method: "PUT",
        json: {
          host: form.host.trim(),
          port: form.port.trim() ? Number(form.port) : null,
          secure: form.secure,
          user: form.user.trim(),
          from: form.from.trim(),
          // Only a newly typed password is sent — a blank field keeps the saved one.
          ...(password ? { password } : {}),
        },
        notify: "Email (SMTP) settings saved",
      }),
    onSuccess: onSaved,
  });

  const reset = useMutation({
    mutationFn: () =>
      api<SmtpSettingsView>("/api/settings/smtp", { method: "DELETE", notify: "Email (SMTP) settings reset to .env" }),
    onSuccess: onSaved,
  });

  if (error) return <div className="settings-card"><ErrorNote error={error} /></div>;
  if (isLoading || !data) return <div className="settings-card"><Spinner /></div>;
  const busy = save.isPending || reset.isPending;

  return (
    <form
      className="settings-card space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {data.provider === "mock" ? (
        <div className="settings-banner-warn">
          <Icon name="info" size={18} className="mt-0.5 shrink-0" />
          <p>
            Emails are not being sent: <code className="code-chip">EMAIL_PROVIDER=mock</code> in .env saves them to the
            local .mail-outbox folder. Save an SMTP server below to start sending real email.
          </p>
        </div>
      ) : !data.host ? (
        <div className="settings-banner-warn">
          <Icon name="info" size={18} className="mt-0.5 shrink-0" />
          <p>SMTP sending is on but no server is set — every email will fail until you save one below.</p>
        </div>
      ) : (
        <div className="settings-banner-ok">
          <Icon name="check" size={18} className="mt-0.5 shrink-0" />
          <p>
            Sending through <code className="code-chip">{data.host}:{data.port}</code> (
            {data.secure ? "SSL/TLS" : "STARTTLS"}) as <code className="code-chip">{data.from}</code>.
          </p>
        </div>
      )}

      {data.passwordUnreadable && (
        <p role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
          The password saved here can't be read any more (the encryption key changed), so SMTP_PASS from .env is
          being used. Type the password again and save.
        </p>
      )}

      <p className="text-sm text-slate-550">
        {data.source === "database"
          ? "Using the settings saved here — they take priority over .env. "
          : "Using the SMTP settings from .env — save below to change them without a restart. "}
        A change reaches new emails within about 10 seconds, including campaigns and sends already queued.
        {data.updatedBy && data.updatedAt
          ? ` Last changed by ${data.updatedBy}, ${formatDateTime(data.updatedAt)}.`
          : ""}
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_12rem]">
        <div>
          <label className="label" htmlFor="smtp-host">SMTP server</label>
          <input
            id="smtp-host"
            className="input font-mono text-xs"
            value={form.host}
            placeholder="e.g. smtp.gmail.com"
            autoComplete="off"
            disabled={busy}
            onChange={(e) => edit({ host: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="smtp-port">Port</label>
          <input
            id="smtp-port"
            className="input font-mono text-xs"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            disabled={busy}
            onChange={(e) => edit({ port: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="smtp-security">Encryption</label>
          <select
            id="smtp-security"
            className="input"
            value={form.secure ? "ssl" : "starttls"}
            disabled={busy}
            onChange={(e) => {
              const secure = e.target.value === "ssl";
              // Move the port along with it when it is still the usual one for the other mode.
              const port = secure && form.port === "587" ? "465" : !secure && form.port === "465" ? "587" : form.port;
              edit({ secure, port });
            }}
          >
            <option value="starttls">STARTTLS (587)</option>
            <option value="ssl">SSL/TLS (465)</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="smtp-user">Username</label>
          <input
            id="smtp-user"
            className="input font-mono text-xs"
            value={form.user}
            placeholder="e.g. you@gmail.com"
            autoComplete="off"
            disabled={busy}
            onChange={(e) => edit({ user: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="smtp-password">Password</label>
          <PasswordInput
            id="smtp-password"
            className="input font-mono text-xs"
            value={password}
            autoComplete="new-password"
            placeholder={
              data.hasPassword
                ? data.passwordSource === "database"
                  ? "Saved — type to replace"
                  : "Set in .env — type to replace"
                : "Not set"
            }
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
              setDirty(true);
            }}
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="smtp-from">From address</label>
        <input
          id="smtp-from"
          className="input"
          value={form.from}
          placeholder="Your Name <you@example.com>"
          disabled={busy}
          onChange={(e) => edit({ from: e.target.value })}
        />
        <p className="mt-1 text-xs text-slate-550">
          Use the same mailbox as the username — most providers reject or rewrite any other From. For Gmail, turn on
          2-Step Verification and use an App Password (myaccount.google.com/apppasswords), not your normal password.
        </p>
      </div>

      {save.error && <ErrorNote error={save.error} />}
      {reset.error && <ErrorNote error={reset.error} />}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary settings-btn" disabled={!dirty || busy}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn-ghost settings-btn"
            disabled={busy}
            onClick={() => {
              setForm(fieldsOf(data));
              setPassword("");
              setDirty(false);
            }}
          >
            Discard changes
          </button>
        )}
        {data.source === "database" && !dirty && (
          <button
            type="button"
            className="btn-ghost settings-btn"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: "Reset to .env values?",
                body: "This removes the SMTP settings saved here, including the password. Email is then sent with SMTP_* and EMAIL_FROM from .env.",
                confirmText: "Reset",
                tone: "danger",
              });
              if (ok) reset.mutate();
            }}
          >
            {reset.isPending ? "Resetting…" : "Reset to .env values"}
          </button>
        )}
        {save.isSuccess && !dirty && <span className="text-ok">Saved.</span>}
      </div>

      <div className="border-t border-line-subtle pt-4">
        <label className="label" htmlFor="smtp-test-to">Send a test email to</label>
        <div className="settings-row">
          <input
            id="smtp-test-to"
            className="input"
            type="email"
            value={testTo}
            placeholder="you@example.com"
            disabled={test.isPending}
            onChange={(e) => {
              setTestTo(e.target.value);
              test.reset();
            }}
          />
          <button
            type="button"
            className="btn-ghost settings-btn"
            disabled={dirty || busy || test.isPending || !testTo.trim()}
            title={dirty ? "Save first — the test uses the saved settings" : undefined}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Sending…" : "Send test email"}
          </button>
        </div>
        {dirty && <p className="mt-1 text-xs text-slate-550">Save first — the test uses the saved settings.</p>}
        {test.error && <div className="mt-2"><ErrorNote error={test.error} /></div>}
        {test.data &&
          (test.data.ok ? (
            <p className="mt-2 rounded-lg bg-ok-soft p-3 text-xs text-ok">
              {test.data.provider === "mock"
                ? "Saved to the local .mail-outbox folder (mock) — no real email was sent."
                : `Test email accepted by the SMTP server for ${testTo.trim()}. Check that inbox (and spam).`}
            </p>
          ) : (
            <p role="alert" className="mt-2 rounded-lg bg-warn-soft p-3 text-xs text-warn">
              Sending failed — {test.data.error}
            </p>
          ))}
      </div>
    </form>
  );
}
