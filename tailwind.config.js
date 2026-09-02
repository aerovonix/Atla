/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        sidebar: "var(--sidebar)",
        input: "var(--input)",
        text: "var(--text)",
        secondary: "var(--secondary)",
        muted: "var(--muted)",
        border: "var(--border)",
        borderLight: "var(--border-light)",
        userBubble: "var(--user-bubble)",
        hover: "var(--hover)",
        codeBg: "var(--code-bg)",
        codeBorder: "var(--code-border)",
        accent: "var(--accent)"
      }
    }
  },
  plugins: []
};
