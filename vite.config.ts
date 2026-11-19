import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { webpageServerPlugin } from "./webpageServer";

// The app is published at https://erfanshayegani.github.io/website-agent/.
// Override with BASE_PATH=/ for other hosts.
const base = process.env.BASE_PATH ?? "/website-agent/";

export default defineConfig({
  base,
  plugins: [
    react(),
    // Dev/preview only: serves /__webpage locally so read_webpage works without
    // the deployed proxy. Production builds use VITE_WEBPAGE_PROXY_URL instead.
    webpageServerPlugin(),
  ],
  build: {
    target: "es2022",
    // Two pages: the agent (index.html) and the "Keep the Secret" game.
    rolldownOptions: {
      input: {
        main: "index.html",
        game: "game/index.html",
      },
    },
  },
  worker: { format: "es" },
});
