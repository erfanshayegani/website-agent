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

## Credits

Model: LFM2.5-2.6B by Liquid AI, under the
[LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX/blob/main/LICENSE).
The weights are downloaded by the visitor's browser from Hugging Face and are not
redistributed here.
