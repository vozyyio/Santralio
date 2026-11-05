// Santralio sitesi: Tailwind yapılandırması (önceden sayfadaki tailwind.config).
module.exports = {
  content: ["./src/**/*.html"],
  theme: {
    extend: {
      fontFamily: { sans: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"] },
      keyframes: { soundwave: { "0%": { height: "6px" }, "100%": { height: "28px" } } },
    },
  },
};
