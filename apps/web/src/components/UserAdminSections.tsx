import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USER_ROLES, type UserRole, type UserSummary } from "@dispatch/shared";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useConfirm } from "./confirm";
import { Badge, ErrorNote, Spinner } from "./ui";
import { PasswordInput } from "./PasswordInput";
import { generatePassword } from "../lib/password";

const ROLE_LABELS: Record<UserRole, string> = { ADMIN: "Admin", EDITOR: "Editor" };

/** Client-side mirror of the server's password rule, for an immediate hint. */
function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (new TextEncoder().encode(pw).length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} bytes`;
  return null;
}

/** Surfaces the first field message of a validation error instead of "Validation failed". */
function readableError(err: unknown): Error {
  if (err instanceof ApiError) {
    const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
    const first = fields && Object.values(fields).flat()[0];
    if (first) return new Error(first);
  }
  return err instanceof Error ? err : new Error("Something went wrong");
}

/* ------------------------------------------------------------------ change password */

export function ChangePasswordSection({ isAdmin }: { isAdmin: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api("/api/users/me/password", {
        method: "POST",
        json: { currentPassword: current, newPassword: next },
        notify: "Password changed",
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirmNext("");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(next) ?? (next !== confirmNext ? "New passwords don't match" : null);
    setLocalError(problem);
    if (!problem) change.mutate();
  };

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Change password</h2>
      {!isAdmin ? (
        <div className="settings-card text-slate-550">Only admins can change passwords here.</div>
      ) : (
        <form className="settings-card space-y-3" onSubmit={submit}>
          <div>
            <label className="label" htmlFor="pw-current">Current password</label>
            <PasswordInput id="pw-current" autoComplete="current-password"
              value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="pw-new">New password</label>
            <PasswordInput id="pw-new" autoComplete="new-password"
              value={next} onChange={(e) => setNext(e.target.value)} />
            <p className="mt-1 text-xs text-slate-550">At least {PASSWORD_MIN_LENGTH} characters.</p>
          </div>
          <div>
            <label className="label" htmlFor="pw-confirm">Confirm new password</label>
            <PasswordInput id="pw-confirm" autoComplete="new-password"
              value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
          </div>
          {localError ? <ErrorNote error={new Error(localError)} /> : null}
          {change.error ? <ErrorNote error={readableError(change.error)} /> : null}
          <button className="btn-primary settings-btn" disabled={!current || !next || !confirmNext || change.isPending}>
            Change password
          </button>
        </form>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ users */

export function UsersSection({ isAdmin }: { isAdmin: boolean }) {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("EDITOR");
  const [revealSignal, setRevealSignal] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ items: UserSummary[] }>("/api/users"),
    enabled: isAdmin,
  });
  const add = useMutation({
    mutationFn: () => api<UserSummary>("/api/users", { method: "POST", json: { email, password, role }, notify: "User added" }),
    onSuccess: () => {
      setEmail("");
      setPassword("");
      setRole("EDITOR");
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; disabled: boolean }) =>
      api<UserSummary>(`/api/users/${v.id}`, {
        method: "PATCH",
        json: { disabled: v.disabled },
        notify: v.disabled ? "User disabled" : "User enabled",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/users/${id}`, { method: "DELETE", notify: "User deleted" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password);
    setLocalError(problem);
    if (!problem) add.mutate();
  };

  const items = users.data?.items ?? [];

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Users</h2>
      {!isAdmin ? (
        <div className="settings-card text-slate-550">Only admins can manage users.</div>
      ) : (
        <div className="settings-card space-y-4">
          <p className="text-slate-550">
            Admins can manage everything in Settings; editors can use the app but not admin-only features.
            Disabled users can't sign in. Deleting a user removes their account but keeps everything they created.
          </p>

          <form className="space-y-3" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <div>
                <label className="label" htmlFor="new-user-email">Email</label>
                <input id="new-user-email" className="input" type="email" autoComplete="off"
                  value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
              </div>
              <div>
                <label className="label" htmlFor="new-user-password">Initial password</label>
                <PasswordInput id="new-user-password" autoComplete="new-password" revealSignal={revealSignal}
                  value={password} onChange={(e) => setPassword(e.target.value)} />
                <button
                  type="button"
                  className="mt-1 text-xs text-accent-ink hover:underline"
                  onClick={() => {
                    setPassword(generatePassword());
                    setRevealSignal((n) => n + 1);
                  }}
                >
                  Generate strong password
                </button>
              </div>
              <div>
                <label className="label" htmlFor="new-user-role">Role</label>
                <select id="new-user-role" className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                  {USER_ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>
            </div>
            {localError ? <ErrorNote error={new Error(localError)} /> : null}
            {add.error ? <ErrorNote error={readableError(add.error)} /> : null}
            <button className="btn-primary settings-btn" disabled={!email.trim() || !password || add.isPending}>
              Add user
            </button>
          </form>

          {toggle.error ? <ErrorNote error={readableError(toggle.error)} /> : null}
          {remove.error ? <ErrorNote error={readableError(remove.error)} /> : null}
          {users.isLoading ? (
            <Spinner />
          ) : users.error ? (
            <ErrorNote error={users.error} />
          ) : (
            <ul className="divide-y divide-line-subtle">
              {items.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`truncate ${u.disabled ? "text-slate-550 line-through" : ""}`}>{u.email}</span>
                      <Badge tone={u.role === "ADMIN" ? "accent" : "neutral"}>{ROLE_LABELS[u.role]}</Badge>
                      {u.disabled ? <Badge tone="warn">Disabled</Badge> : null}
                      {isMe ? <Badge tone="ok">You</Badge> : null}
                    </span>
                    {!isMe && (
                      <span className="flex items-center gap-4">
                        <button
                          className={u.disabled ? "text-accent-ink" : "text-action-danger"}
                          disabled={toggle.isPending || remove.isPending}
                          onClick={async () => {
                            if (!u.disabled) {
                              const ok = await confirm({
                                title: `Disable ${u.email}?`,
                                body: "They won't be able to sign in until re-enabled. Their password is kept.",
                                confirmText: "Disable",
                                tone: "danger",
                              });
                              if (!ok) return;
                            }
                            toggle.mutate({ id: u.id, disabled: !u.disabled });
                          }}
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </button>
                        <button
                          className="text-action-danger"
                          disabled={toggle.isPending || remove.isPending}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete ${u.email}? This can't be undone.`,
                              body: "They can no longer sign in, and their account and password are removed. Campaigns, call flows, AI calls and WhatsApp messages they created are kept.",
                              confirmText: "Delete",
                              tone: "danger",
                            });
                            if (ok) remove.mutate(u.id);
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
