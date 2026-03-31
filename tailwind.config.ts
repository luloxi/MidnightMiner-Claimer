import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        night: {
          50: "#f0f0ff",
          100: "#e0e0ff",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          900: "#1e1b4b",
          950: "#0f0e2a",
        },
      },
    },
  },
  plugins: [],
};

export default config;
