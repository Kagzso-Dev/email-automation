/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1b1f2a",
        // Neutral ramp — `slate-550` kept for back-compat with existing markup.
        slate: {
          400: "#8b93a3",
          500: "#6b7482",
          550: "#565f6e",
          600: "#454e5c",
        },
        accent: { DEFAULT: "#3a4fb8", ink: "#2c3c96", soft: "#eef0fb" },
        ok: "#2f7d5d",
        warn: "#9c6412",
        crit: "#bd4238",
        // Semantic surface + line tokens (previously scattered hex literals).
        surface: { DEFAULT: "#ffffff", sunken: "#f6f7f9", muted: "#eef0f4" },
        line: { DEFAULT: "#e3e6ec", strong: "#d5d9e2", subtle: "#f0f2f6" },
      },
      fontFamily: {
        sans: ["'IBM Plex Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "0.625rem", // 10px — default control radius
        xl: "0.875rem", // 14px — cards
        "2xl": "1.125rem", // 18px — modals / large panels
      },
      boxShadow: {
        sm: "0 1px 2px rgba(20,23,30,0.06)",
        card: "0 1px 2px rgba(20,23,30,0.04), 0 10px 30px rgba(20,23,30,0.05)",
        pop: "0 12px 32px rgba(20,23,30,0.12)",
        rail: "0 0 0 1px rgba(20,23,30,0.05), 4px 0 24px rgba(20,23,30,0.06)",
      },
      transitionTimingFunction: {
        "in-out-soft": "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "overlay-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "overlay-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        "dialog-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.96)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "dialog-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(4px) scale(0.98)" },
        },
        "toast-in": {
          "0%": { opacity: "0", transform: "translateY(-16px) scale(0.94)" },
          "65%": { opacity: "1", transform: "translateY(3px) scale(1)" },
          "100%": { transform: "translateY(0) scale(1)" },
        },
        "mail-pop": {
          "0%": { opacity: "0", transform: "translateY(-7px) rotate(-10deg)" },
          "55%": { opacity: "1", transform: "translateY(1px) rotate(4deg)" },
          "100%": { transform: "translateY(0) rotate(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.4s infinite",
        "overlay-in": "overlay-in 150ms ease-out",
        "overlay-out": "overlay-out 120ms ease-in forwards",
        "dialog-in": "dialog-in 190ms cubic-bezier(0.16, 1, 0.3, 1)",
        "dialog-out": "dialog-out 130ms ease-in forwards",
        "toast-in": "toast-in 340ms cubic-bezier(0.16, 1, 0.3, 1)",
        "mail-pop": "mail-pop 440ms cubic-bezier(0.16, 1, 0.3, 1) 90ms both",
      },
    },
  },
  plugins: [],
};
