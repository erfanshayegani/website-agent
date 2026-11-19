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
| `src/exaReader.ts` | Public-site page download for `read_webpage` via Exa's `web_fetch_exa`. |
| `proxy/` | Optional Cloudflare Worker page reader (same contract as the local `/__webpage`); not deployed. |
| `webpageServer.ts` | Local `/__webpage` page reader for `npm run dev` / `npm run preview`. |
| `docs/SPEC.md` | Behavioral specification the agent implements. |

## Develop

```bash
npm install --ignore-scripts
npm run dev        # http://localhost:5173/website-agent/
npm test           # agent loop (mock model), proxy, Python, webpage and MCP tests
npm run build
```

`read_webpage` downloads pages with the local `/__webpage` middleware in dev. The
public build downloads them through Exa's hosted `web_fetch_exa` (see
`src/exaReader.ts`), or through `VITE_WEBPAGE_PROXY_URL` if a proxy is deployed.
Exa's MCP server is connected on page load with `web_search_exa` enabled
(`web_fetch_exa` is available but off by default).

## Deploy

Every push to `main` tests, builds and deploys to GitHub Pages
(Settings → Pages → Source: **GitHub Actions**).

Optional: to download pages through your own proxy instead of Exa, deploy the
Worker in `proxy/` (`npx wrangler deploy`) and set an Actions variable
`WEBPAGE_PROXY_URL` to its URL.

## Credits

Model: LFM2.5-2.6B by Liquid AI, under the
[LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX/blob/main/LICENSE).
The weights are downloaded by the visitor's browser from Hugging Face and are not
redistributed here.
