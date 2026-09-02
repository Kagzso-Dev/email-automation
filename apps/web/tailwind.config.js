/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1b1f2a",
        slate: { 550: "#565f6e" },
        accent: { DEFAULT: "#3a4fb8", ink: "#2c3c96", soft: "#eef0fb" },
        ok: "#2f7d5d",
        warn: "#9c6412",
        crit: "#bd4238",
      },
      fontFamily: {
        sans: ["'IBM Plex Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
