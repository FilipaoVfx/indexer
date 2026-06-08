import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  site: "https://utp-group6573524.gitlab.io",
  base: "/indexer",
  integrations: [react()],
});
