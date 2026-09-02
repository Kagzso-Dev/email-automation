import { useState } from "react";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={onSubmit} className="card w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 font-mono text-sm font-semibold">
          <span>📮</span> Dispatch
        </div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input mb-3"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input mb-4"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className="field-error mb-3">{error}</div>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
