import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/contacts", label: "Contacts" },
  { to: "/lists", label: "Lists" },
  { to: "/templates", label: "Templates" },
  { to: "/campaigns", label: "Campaigns" },
  { to: "/triggers", label: "Triggers" },
  { to: "/settings", label: "Settings" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="mx-auto flex min-h-screen max-w-[1200px] gap-8 px-6 py-6">
      <aside className="sticky top-6 hidden h-fit w-48 shrink-0 md:block">
        <div className="mb-6 flex items-center gap-2 font-mono text-sm font-semibold">
          <span>📮</span> Dispatch
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm ${
                  isActive ? "bg-accent-soft font-medium text-accent-ink" : "text-slate-550 hover:text-ink"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-8 border-t border-[#e3e6ec] pt-4 text-xs text-slate-550">
          <div className="truncate">{user?.email}</div>
          <div className="mb-2 font-mono uppercase">{user?.role}</div>
          <button className="text-accent-ink hover:underline" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 pb-16">{children}</main>
    </div>
  );
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {action}
    </div>
  );
}
