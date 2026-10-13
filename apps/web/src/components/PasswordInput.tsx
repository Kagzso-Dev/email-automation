import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { Icon } from "./icons";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  id: string;
  value: string;
  /** Bump to reveal the value once (e.g. right after generating a password). */
  revealSignal?: number;
};

/**
 * A password field with a show / hide eye button — same look as the login
 * page's toggle. Purely visual: it only flips the input's `type`; value,
 * handlers and attributes pass straight through. Visibility lives only in
 * this component, so it resets on unmount / reload, and it re-hides when the
 * surrounding form is submitted or the field is cleared.
 */
export function PasswordInput({ revealSignal, className = "", ...inputProps }: Props) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selection = useRef<[number | null, number | null] | null>(null);

  // Re-hide on submit of the enclosing form.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const hide = () => setVisible(false);
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);

  // Re-hide when the field is cleared (e.g. after a successful save).
  useEffect(() => {
    if (!inputProps.value) setVisible(false);
  }, [inputProps.value]);

  useEffect(() => {
    if (revealSignal) setVisible(true);
  }, [revealSignal]);

  // Some browsers reset the caret when `type` changes — put it back.
  useLayoutEffect(() => {
    const el = inputRef.current;
    const sel = selection.current;
    selection.current = null;
    if (el && sel && document.activeElement === el) el.setSelectionRange(sel[0], sel[1]);
  }, [visible]);

  const toggle = () => {
    const el = inputRef.current;
    if (el) selection.current = [el.selectionStart, el.selectionEnd];
    setVisible((v) => !v);
  };

  return (
    <div className="password-field">
      <input
        {...inputProps}
        ref={inputRef}
        type={visible ? "text" : "password"}
        className={`input password-field-input ${className}`}
      />
      <button
        type="button"
        className="password-toggle"
        // Keep focus (and the caret) in the input when clicking the eye.
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={inputProps.id}
      >
        <Icon name="eye" size={18} className="password-toggle-icon" data-on={!visible} />
        <Icon name="eye-off" size={18} className="password-toggle-icon" data-on={visible} />
      </button>
    </div>
  );
}
