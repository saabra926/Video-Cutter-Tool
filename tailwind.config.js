/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Orbitron'", "sans-serif"],
        body: ["'Syne'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      colors: {
        void: "#030507",
        surface: "#0a0e14",
        panel: "#0f1520",
        border: "#1a2535",
        accent: "#00d4ff",
        accentDim: "#0099bb",
        neon: "#39ff14",
        amber: "#ffb700",
        danger: "#ff3c5a",
        muted: "#3a4a5c",
        text: "#c8d8e8",
        textDim: "#6a7f95",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "scan": "scan 2s linear infinite",
        "glow": "glow 2s ease-in-out infinite alternate",
        "flicker": "flicker 0.15s infinite",
        "slide-up": "slideUp 0.4s ease-out",
        "fade-in": "fadeIn 0.5s ease-out",
      },
      keyframes: {
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        glow: {
          "from": { textShadow: "0 0 10px #00d4ff, 0 0 20px #00d4ff" },
          "to": { textShadow: "0 0 20px #00d4ff, 0 0 40px #00d4ff, 0 0 60px #00d4ff" },
        },
        slideUp: {
          "from": { opacity: "0", transform: "translateY(20px)" },
          "to": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "from": { opacity: "0" },
          "to": { opacity: "1" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.8" },
        },
      },
      boxShadow: {
        "neon-accent": "0 0 20px rgba(0, 212, 255, 0.3), 0 0 60px rgba(0, 212, 255, 0.1)",
        "neon-green": "0 0 20px rgba(57, 255, 20, 0.3)",
        "neon-amber": "0 0 20px rgba(255, 183, 0, 0.3)",
        "panel": "0 4px 24px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255,255,255,0.05)",
        "inner-glow": "inset 0 0 30px rgba(0, 212, 255, 0.05)",
      },
      backgroundImage: {
        "grid-pattern": "linear-gradient(rgba(0,212,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.03) 1px, transparent 1px)",
        "radial-glow": "radial-gradient(ellipse at 50% 0%, rgba(0,212,255,0.15) 0%, transparent 60%)",
        "panel-gradient": "linear-gradient(135deg, rgba(15,21,32,0.9) 0%, rgba(10,14,20,0.95) 100%)",
      },
    },
  },
  plugins: [],
};
