import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Dark-mode chart chrome from the dataviz skill's validated
        // reference palette (references/palette.md), reused here so the
        // whole UI and the charts share one consistent, validated surface.
        surface: {
          DEFAULT: "#0d0d0d", // page plane
          raised: "#1a1a19", // chart / card surface
          border: "rgba(255,255,255,0.10)",
        },
        ink: {
          primary: "#ffffff",
          secondary: "#c3c2b7",
          muted: "#898781",
        },
        viz: {
          series1: "#3987e5", // categorical slot 1 (blue), dark step -- "you" in a 2-series comparison
          series2: "#d95926", // categorical slot 2 (orange), dark step -- "top log" in a 2-series comparison
          good: "#0ca30c", // status palette, mode-invariant
          critical: "#d03b3b", // status palette, mode-invariant
          gridline: "#2c2c2a",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
