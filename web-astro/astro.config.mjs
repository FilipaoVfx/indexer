import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  site: "https://indexer-369a72.gitlab.io",
  base: "/",
  integrations: [react()],
});
