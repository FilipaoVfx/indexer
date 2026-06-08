import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  site: process.env.PUBLIC_SITE_URL || "https://indexer-369a72.gitlab.io",
  base: process.env.PUBLIC_BASE_PATH || "/",
  integrations: [react()],
});
