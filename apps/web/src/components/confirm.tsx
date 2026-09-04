import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icons";

export interface ConfirmOptions {
  /** Headline — a short question, e.g. `Delete ragul.naa@gmail.com?` */
  title: string;
  /** Supporting line under the title explaining the consequence. */
  body?: ReactNode;
  /** Label for the affirmative button. Defaults to `Confirm`. */
  confirmText?: string;
  /** Label for the dismissive button. Defaults to `Cancel`. */
  cancelText?: string;
  /** `danger` paints the confirm button red — use for destructive actions. */
  tone?: "danger" | "default";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/** Wrap the app once so any component can `await useConfirm()(…)`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending((prev) => {
        // A second prompt supersedes an unanswered one.
        prev?.resolve(false);
        return { ...options, resolve };
      });
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setPending((prev) => {
      prev?.resolve(value);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          key={pending.title}
          options={pending}
          onResolve={settle}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a <ConfirmProvider>");
  return ctx;
}

function ConfirmDialog({
  options,
  onResolve,
}: {
  options: ConfirmOptions;
  onResolve: (value: boolean) => void;
}) {
  const { title, body, confirmText = "Confirm", cancelText = "Cancel", tone = "default" } = options;
  const [closing, setClosing] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Animate out, then hand the answer back once the exit transition is done.
  const close = useCallback(
    (value: boolean) => {
      setClosing(true);
      window.setTimeout(() => onResolve(value), 140);
    },
    [onResolve],
  );

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      className={`fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4 ${
        closing ? "animate-overlay-out" : "animate-overlay-in"
      }`}
      onClick={() => close(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className={`w-full max-w-sm rounded-2xl bg-white p-6 shadow-pop ${
          closing ? "animate-dialog-out" : "animate-dialog-in"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3.5">
          <span
            className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${
              tone === "danger" ? "bg-[#f9ebe9] text-crit" : "bg-accent-soft text-accent-ink"
            }`}
          >
            <Icon name={tone === "danger" ? "trash" : "info"} size={18} />
          </span>
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-base font-semibold text-ink">
              {title}
            </h2>
            {body ? <p className="mt-1 text-sm text-slate-550">{body}</p> : null}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => close(false)}>
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === "danger" ? "btn-danger" : "btn-primary"}
            onClick={() => close(true)}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
