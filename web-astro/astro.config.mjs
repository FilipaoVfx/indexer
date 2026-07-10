import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  site: process.env.PUBLIC_SITE_URL || "https://filipaovfx.github.io",
  base: process.env.PUBLIC_BASE_PATH || "/",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
