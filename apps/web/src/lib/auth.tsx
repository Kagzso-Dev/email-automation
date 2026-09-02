import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setAccessToken } from "./api";

export interface AuthUser {
  id: string;
  email: string;
  role: "ADMIN" | "EDITOR";
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Attempt a silent refresh on load (httpOnly cookie).
    api<{ accessToken: string; user: AuthUser }>("/api/auth/refresh", { method: "POST", retry: false })
      .then((data) => {
        setAccessToken(data.accessToken);
        setUser(data.user);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      async login(email, password) {
        const data = await api<{ accessToken: string; user: AuthUser }>("/api/auth/login", {
          method: "POST",
          json: { email, password },
        });
        setAccessToken(data.accessToken);
        setUser(data.user);
      },
      async logout() {
        await api("/api/auth/logout", { method: "POST", retry: false }).catch(() => undefined);
        setAccessToken(null);
        setUser(null);
      },
    }),
    [user, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
