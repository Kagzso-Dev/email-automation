/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Every color resolves to a CSS variable defined once in src/index.css (:root), stored as
      // RGB channels so Tailwind opacity modifiers (bg-ink/40, bg-wa/60) keep working.
      colors: {
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        // Neutral text ramp — `slate-550` kept for back-compat with existing markup.
        slate: {
          400: "rgb(var(--c-text-faint) / <alpha-value>)",
          500: "rgb(var(--c-text-muted) / <alpha-value>)",
          550: "rgb(var(--c-text-body) / <alpha-value>)",
          600: "rgb(var(--c-text-strong) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--c-accent) / <alpha-value>)",
          ink: "rgb(var(--c-accent-ink) / <alpha-value>)",
          soft: "rgb(var(--c-accent-soft) / <alpha-value>)",
          teal: "rgb(var(--c-accent-teal) / <alpha-value>)",
        },
        tint: "var(--hover-tint)",
        ok: {
          DEFAULT: "rgb(var(--c-ok) / <alpha-value>)",
          soft: "rgb(var(--c-ok-soft) / <alpha-value>)",
          bright: "rgb(var(--c-ok-bright) / <alpha-value>)",
        },
        warn: {
          DEFAULT: "rgb(var(--c-warn) / <alpha-value>)",
          soft: "rgb(var(--c-warn-soft) / <alpha-value>)",
          bright: "rgb(var(--c-warn-bright) / <alpha-value>)",
        },
        crit: {
          DEFAULT: "rgb(var(--c-crit) / <alpha-value>)",
          soft: "rgb(var(--c-crit-soft) / <alpha-value>)",
          line: "rgb(var(--c-crit-line) / <alpha-value>)",
          bright: "rgb(var(--c-crit-bright) / <alpha-value>)",
        },
        // WhatsApp brand green — kept recognizable on the WhatsApp send actions.
        wa: {
          DEFAULT: "rgb(var(--c-wa) / <alpha-value>)",
          ink: "rgb(var(--c-wa-ink) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--c-surface) / <alpha-value>)",
          sunken: "rgb(var(--c-surface-sunken) / <alpha-value>)",
          muted: "rgb(var(--c-surface-muted) / <alpha-value>)",
        },
        line: {
          DEFAULT: "rgb(var(--c-line) / <alpha-value>)",
          strong: "rgb(var(--c-line-strong) / <alpha-value>)",
          subtle: "rgb(var(--c-line-subtle) / <alpha-value>)",
        },
      },
      backgroundImage: {
        "gradient-accent": "var(--gradient-accent)",
      },
      fontFamily: {
        sans: ["'IBM Plex Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "0.75rem", // 12px — default control radius
        xl: "1rem", // 16px — cards, tables
        "2xl": "1.25rem", // 20px — modals / large panels
      },
      boxShadow: {
        sm: "0 1px 2px rgba(17,24,39,0.05)",
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
        rail: "0 0 0 1px rgba(17,24,39,0.04), 4px 0 30px rgba(17,24,39,0.08)",
        glow: "var(--shadow-glow)",
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
        "page-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
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
        "page-in": "page-in 260ms cubic-bezier(0.4, 0, 0.2, 1) backwards",
        "mail-pop": "mail-pop 440ms cubic-bezier(0.16, 1, 0.3, 1) 90ms both",
      },
    },
  },
  plugins: [],
};
