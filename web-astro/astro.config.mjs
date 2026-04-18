import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  site: "https://filipaovfx.github.io",
  base: "/indexer",
  integrations: [react()],
});
