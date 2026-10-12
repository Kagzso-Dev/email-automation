import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Icon } from "../components/icons";
import { Logo } from "../components/Logo";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Purely visual: shows / hides the password text. Doesn't touch the form state or submit.
  const [showPassword, setShowPassword] = useState(false);

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
    <div className="login-page">
      <form onSubmit={onSubmit} className="login-card">
        <div className="login-brand">
          <Logo size={40} />
          Dispatch
        </div>
        <h1 className="login-title">
          Welcome <span className="text-gradient">back</span>
        </h1>
        <p className="login-subtitle">Sign in to manage your email, WhatsApp and call campaigns.</p>

        <div className="mt-7 space-y-4">
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <div className="login-field">
              <Icon name="mail" size={18} className="login-field-icon" />
              <input
                id="email"
                className="login-input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <div className="login-field">
              <Icon name="lock" size={18} className="login-field-icon" />
              <input
                id="password"
                className="login-input login-input-with-toggle"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="login-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                aria-controls="password"
              >
                <Icon name={showPassword ? "eye-off" : "eye"} size={18} />
              </button>
            </div>
          </div>

          {error && (
            // Keyed on the message so each new error fades / shakes in once.
            <div key={error} className="login-alert" role="alert">
              <Icon name="info" size={16} className="login-alert-icon" />
              <span>{error}</span>
            </div>
          )}

          <button className="login-submit" disabled={busy}>
            {busy && <span className="login-spinner" aria-hidden="true" />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
      <p className="login-footer">© Dispatch · Kagzso</p>
    </div>
  );
}
