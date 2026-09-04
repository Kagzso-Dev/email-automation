import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Icon, type IconName } from "./icons";

type NavEntry = { to: string; label: string; icon: IconName; end?: boolean };

const NAV: NavEntry[] = [
  { to: "/", label: "Dashboard", icon: "dashboard", end: true },
  { to: "/insights", label: "Insights", icon: "insights" },
  { to: "/contacts", label: "Contacts", icon: "contacts" },
  { to: "/lists", label: "Lists", icon: "lists" },
  { to: "/templates", label: "Templates", icon: "templates" },
  { to: "/whatsapp-contacts", label: "WhatsApp Contacts", icon: "whatsapp" },
  { to: "/whatsapp-templates", label: "WhatsApp Templates", icon: "whatsapp" },
  { to: "/campaigns", label: "Campaigns", icon: "campaigns" },
  { to: "/send-queue", label: "Send Queue", icon: "activity" },
  { to: "/triggers", label: "Triggers", icon: "triggers" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

const COLLAPSE_KEY = "dispatch:sidebar-collapsed";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  // Desktop icon-rail state — persisted across reloads.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Mobile off-canvas drawer — always starts closed.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [collapsed]);

  // Route change closes the mobile drawer.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // While the drawer is open: Escape closes it and body scroll is locked.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  return (
    <div className="md:flex">
      {/* Mobile top bar (hidden on desktop) */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur md:hidden">
        <button
          type="button"
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-surface-muted hover:text-ink"
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          onClick={() => setMobileOpen(true)}
        >
          <Icon name="menu" size={20} />
        </button>
        <span className="flex items-center gap-2 font-mono text-sm font-semibold">
          <span aria-hidden="true">📮</span> Dispatch
        </span>
      </header>

      {/* Backdrop for the mobile drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 md:hidden"
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — off-canvas drawer on mobile, width-animated rail on desktop */}
      <aside
        id="app-sidebar"
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-surface",
          "transition-[transform,width] duration-300 ease-in-out-soft motion-reduce:transition-none",
          "md:sticky md:top-0 md:z-auto md:h-screen",
          mobileOpen ? "translate-x-0 shadow-rail" : "-translate-x-full",
          "md:translate-x-0",
          collapsed ? "md:w-16" : "md:w-64",
        )}
      >
        {/* Brand + collapse / close toggles */}
        <div
          className={cx(
            "flex h-14 shrink-0 items-center gap-2 px-3",
            collapsed && "md:justify-center md:px-2",
          )}
        >
          <span
            className={cx(
              "flex min-w-0 items-center gap-2 font-mono text-sm font-semibold",
              collapsed && "md:hidden",
            )}
          >
            <span aria-hidden="true">📮</span>
            <span className="truncate">Dispatch</span>
          </span>

          {/* Desktop collapse toggle */}
          <button
            type="button"
            className={cx(
              "hidden h-9 w-9 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-surface-muted hover:text-ink md:grid",
              collapsed ? "md:ml-0" : "md:ml-auto",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name="sidebar" size={18} />
          </button>

          {/* Mobile close */}
          <button
            type="button"
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-surface-muted hover:text-ink md:hidden"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Primary navigation */}
        <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <ul className="flex flex-col gap-0.5">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  title={collapsed ? n.label : undefined}
                  className={({ isActive }) =>
                    cx(
                      "nav-link",
                      collapsed && "md:justify-center md:px-0",
                      isActive && "nav-link-active",
                    )
                  }
                >
                  <Icon name={n.icon} size={18} className="shrink-0" />
                  <span className={cx("truncate", collapsed && "md:hidden")}>{n.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* Footer — account + sign out */}
        <div className="shrink-0 border-t border-line px-3 py-3">
          {/* Expanded footer: always on mobile, on desktop only when not collapsed */}
          <div className={cx("text-xs text-slate-550", collapsed && "md:hidden")}>
            <div className="truncate text-ink">{user?.email}</div>
            <div className="mb-2 font-mono uppercase tracking-wide">{user?.role}</div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 font-medium text-accent-ink transition-colors hover:underline"
              onClick={() => logout()}
            >
              <Icon name="logout" size={14} /> Sign out
            </button>
          </div>

          {/* Collapsed rail footer: desktop only, only when collapsed */}
          {collapsed && (
            <div className="hidden flex-col items-center gap-2 md:flex">
              <span
                className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft font-mono text-xs font-semibold uppercase text-accent-ink"
                title={user?.email}
              >
                {user?.email?.[0] ?? "?"}
              </span>
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-550 transition-colors hover:bg-surface-muted hover:text-crit"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => logout()}
              >
                <Icon name="logout" size={16} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Page content */}
      <main className="min-w-0 flex-1 pb-16">
        <div className="mx-auto max-w-[1120px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
