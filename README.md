# Website Agent

An on-device research agent: [LiquidAI LFM2.5-2.6B](https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX)
running in the browser with WebGPU via Transformers.js. It plans its work, asks
clarifying questions, searches Wikipedia, reads webpages, runs Python (Pyodide)
and can use optional MCP tools. Model inference never leaves the visitor's machine.

Live at **https://erfanshayegani.github.io/website-agent/**.

## Layout

| Path | What |
|---|---|
| `src/workers/agent.worker.ts` | The agent loop (planning gate, tool dispatch, research subagents, KV-cache reuse). |
| `src/agentConfig.ts` | Built-in tool schemas (model-visible) and their validation. |
| `src/agent/` | Prompts (verbatim), tool-call parsing, sources and the Markdown report. |
| `src/hooks/useAgentWorker.ts` | UI ↔ worker bridge; runs Python, webpage, MCP and location requests on the main thread. |
| `src/pythonRunner.ts`, `src/webpage.ts`, `src/mcpClient.ts` | Python sandbox, page extraction, MCP client. |
| `src/components/` | UI. |
| `proxy/` | Cloudflare Worker used by `read_webpage` in production (same contract as the local `/__webpage`). |
| `webpageServer.ts` | Local `/__webpage` page reader for `npm run dev` / `npm run preview`. |
| `docs/SPEC.md` | Behavioral specification the agent implements. |

## Develop

```bash
npm install --ignore-scripts
npm run dev        # http://localhost:5173/website-agent/
npm test           # agent loop (mock model), proxy, Python, webpage and MCP tests
npm run build
```

`read_webpage` uses the local `/__webpage` middleware in dev/preview. Production
builds call `VITE_WEBPAGE_PROXY_URL`.

## Deploy

1. **Proxy** (once): `cd proxy && npx wrangler login && npx wrangler deploy`. Note the
   `https://website-agent-webpage-proxy.<account>.workers.dev` URL. Allowed origins are
   set in `proxy/wrangler.toml`; requests are rate-limited per IP.
2. **Site**: in the GitHub repo settings, set Pages → Source to **GitHub Actions**
   and add an Actions variable `WEBPAGE_PROXY_URL` with the Worker URL. Every push
   to `main` tests, builds and deploys.

## Current deployment status (temporary, as of 2026-11-18)

**The live app is NOT deployed from this repo yet.** This repo's GitHub Actions
deploy fails with *"The job was not started because your account is locked due to
a billing issue"*, even though the account's billing page shows GitHub Free with
nothing due. GitHub Student benefits were approved on 2026-11-18 and activate
about 72 hours later (around 2026-11-21), which may clear the lock.

Until then, the app is served from a **built copy committed to the website repo**
([erfanshayegani.github.io](https://github.com/erfanshayegani/erfanshayegani.github.io),
folder `agent/`) at **https://erfanshayegani.github.io/agent/**, linked from the
website's `/playground/` page. That site's own Pages build is not affected by the lock.

It can't live at `/website-agent/` meanwhile: because this repo has Pages enabled,
GitHub routes `/website-agent/` to this repo's (empty) project site.

**To update the live app meanwhile** (note the `/agent/` base path):
```bash
BASE_PATH=/agent/ npm run build
rsync -a --delete --exclude _README.md dist/ ../erfanshayegani.github.io/agent/
# then commit + push the website repo
```

**To switch back to deploying from this repo (after ~2026-11-21):**
1. Re-run the latest *Deploy to GitHub Pages* workflow (or push any commit) and
   confirm it succeeds and https://erfanshayegani.github.io/website-agent/ loads.
   If it still says the account is locked, contact support.github.com
   (billing → account locked, no balance due).
2. In the website repo: point the Playground "Try it" link
   (`_pages/playground.html`) back to `/website-agent/`, delete the `agent/`
   folder, commit and push.
3. Remove this section.

Also note: `read_webpage` is hidden on the public build because no page-reader
proxy is deployed (`VITE_WEBPAGE_PROXY_URL` unset). The Cloudflare Worker in
`proxy/` is ready but intentionally not deployed for now.

## Credits

Model: LFM2.5-2.6B by Liquid AI, under the
[LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX/blob/main/LICENSE).
The weights are downloaded by the visitor's browser from Hugging Face and are not
redistributed here.
