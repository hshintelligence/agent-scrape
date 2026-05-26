# AgentScrape

> **Pay-per-call web scraping for AI agents — no signup, no API keys, just USDC.**

[![x402](https://img.shields.io/badge/x402-v2-blue)](https://x402.org)
[![MCP](https://img.shields.io/badge/MCP-native-purple)](https://modelcontextprotocol.io)
[![Base](https://img.shields.io/badge/Network-Base%20mainnet-0052FF)](https://base.org)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![hshintelligence/agent-scrape MCP server](https://glama.ai/mcp/servers/hshintelligence/agent-scrape/badges/score.svg)](https://glama.ai/mcp/servers/hshintelligence/agent-scrape)

**Live:** [`agent-scrape.healingsunhaven.workers.dev`](https://agent-scrape.healingsunhaven.workers.dev)

AI agents discover AgentScrape, pay per call in USDC on Base, and get clean structured data back — no accounts, no API keys, no human in the loop.

Two protocols, one service:

- **HTTP API** with x402 v2 payment gate — for agents using raw HTTP
- **MCP server** (Streamable HTTP transport) — for Claude Desktop, Cursor, Continue.dev, and any MCP-compatible framework

---

## Why this exists

Traditional scraping APIs assume a human:

- Sign up with email
- Add a payment method
- Manage an API key
- Commit to a monthly subscription

**AI agents can't do any of that.** They have wallets. They have stablecoins. They need infrastructure built for them.

AgentScrape speaks two open standards:

- **[x402](https://x402.org)** — HTTP-native payment protocol. The server returns 402 with payment requirements; the agent signs a USDC transfer; the facilitator settles on-chain; the data flows back. End-to-end in under 2 seconds.
- **[MCP](https://modelcontextprotocol.io)** — the standard agent tool interface. Agents browse, discover, and invoke tools without per-vendor SDKs.

No signup. No API keys. No subscription. Just USDC.

---

## Tools

All tools cost **$0.001 USDC** during the mainnet validation window. Pricing ramps after stability is proven (see [Pricing](#pricing)).

| Tool | Description |
|---|---|
| `scrape_webpage` | Scrape any URL to markdown, HTML, text, or JSON |
| `extract_structured_data` | AI-powered structured extraction with natural-language prompts and JSON schemas (Groq + Llama 4 Scout) |
| `screenshot_webpage` | PNG screenshot with viewport control (desktop/mobile/tablet, optional full-page) |
| `extract_metadata` | Title, description, Open Graph, Twitter cards, JSON-LD, canonical URL |
| `create_browser_session` | Stateful browser session with cookie + localStorage persistence |
| `run_workflow` | Multi-step atomic execution: navigate, click, type, wait, scroll, screenshot, extract, evaluate |

---

## Quick start — HTTP API

```bash
# Free service discovery (no payment)
curl https://agent-scrape.healingsunhaven.workers.dev/

# Paid call — without payment, returns 402 with payment requirements
curl -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "format": "markdown"}'

# Free tier — first 10 calls per wallet, send your wallet in the X-402-Payer header
curl -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -H "X-402-Payer: 0xYourBaseWalletAddress" \
  -d '{"url": "https://example.com", "format": "markdown"}'
```

---

## Quick start — MCP

Add to any MCP-compatible client via Streamable HTTP:

```json
{
  "mcpServers": {
    "agent-scrape": {
      "url": "https://agent-scrape.healingsunhaven.workers.dev/mcp",
      "transport": "streamable-http"
    }
  }
}
```

The x402 payment metadata is broadcast inside the MCP `tools/list` response. Your client handles the payment handshake automatically when configured with an x402-compatible wallet.

---

## Discovery

For machine-driven discovery, four standard endpoints are exposed (free, no auth):

| Endpoint | Purpose |
|---|---|
| `/` | Service profile JSON (tools, prices, network, payTo) |
| `/.well-known/x402` (and `.json` alias) | x402 manifest — payTo, network, facilitator, all paid routes |
| `/openapi.json` | OpenAPI 3.1 spec for traditional tooling |
| `/llms.txt` | Agent-friendly plaintext description |

The 402 response itself carries the canonical payment requirements in the base64-encoded `Payment-Required` header, and the body includes a human-readable error with discovery links.

---

## Architecture

```
                ┌──────────────────────────────────┐
                │      Cloudflare Workers          │
                │      (global edge, 330+ POPs)    │
                │                                  │
AI Agent ───────┼─▶  GET  /                  (free)│
(HTTP)          ├─▶  GET  /.well-known/x402  (free)│
                ├─▶  GET  /openapi.json      (free)│
                ├─▶  GET  /llms.txt          (free)│
                ├─▶  POST /scrape         ($0.001) │
                ├─▶  POST /extract        ($0.001) │
                ├─▶  POST /screenshot     ($0.001) │
                ├─▶  POST /metadata       ($0.001) │
                ├─▶  POST /workflow       ($0.001) │
                ├─▶  POST /session        ($0.001) │
                │                                  │
AI Agent ───────┼─▶  POST /mcp                     │
(MCP)           │      • initialize                │
                │      • tools/list                │
                │      • tools/call (paid)         │
                │                                  │
                └──────────────┬───────────────────┘
                               │
              ┌────────────────┴─────────────────┐
              │                                  │
   Coinbase CDP facilitator       Browser Rendering API
   (api.cdp.coinbase.com/         Groq API (Llama 4 Scout)
    platform/v2/x402)             KV (sessions, free tier)
   Ed25519 JWT auth
   Settles USDC on Base
              │
              ▼
   payTo wallet 0x3F33...9E9a
```

**Stack:**

- **Runtime:** Cloudflare Workers (V8 isolates, global edge)
- **HTTP framework:** [Hono](https://hono.dev) + [@x402/hono](https://github.com/coinbase/x402) v2 payment middleware
- **MCP framework:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) + [agents/mcp](https://github.com/cloudflare/agents) with `withX402` payment binding
- **Bazaar discovery:** [@x402/extensions](https://github.com/coinbase/x402) — every paid route declares input schema + output example
- **Browser:** Cloudflare Browser Rendering API + [@cloudflare/puppeteer](https://developers.cloudflare.com/browser-rendering/)
- **AI extraction:** [Groq](https://groq.com) + Llama 4 Scout (17B, 16E)
- **Storage:** Cloudflare KV (5-min response cache, browser sessions, free-tier counters)
- **Network:** Base mainnet (`eip155:8453`)
- **Asset:** Native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Facilitator:** Coinbase CDP (`api.cdp.coinbase.com/platform/v2/x402`) with Ed25519 JWT auth

---

## Free tier

Every wallet address gets **10 free calls per 30 days** on the HTTP API. Pass your Base wallet in the `X-402-Payer` header. After 10 calls, payment via x402 is required.

Free tier is HTTP-only. MCP calls go through the standard x402 payment flow.

---

## Pricing

Launch window (first 48h on mainnet): **$0.001 flat per tool call.**

After validation, pricing ramps to:

| Tool | Production price |
|---|---|
| `scrape_webpage` | $0.003 |
| `extract_structured_data` | $0.005 |
| `screenshot_webpage` | $0.003 |
| `extract_metadata` | $0.002 |
| `run_workflow` | $0.008 |
| `create_browser_session` | $0.001 |

Bulk discounts (20% at 1K calls/month, 40% at 10K) are planned.

---

## Why x402 + MCP

| Traditional API | x402 + MCP |
|---|---|
| Sign up at scraperapi.com | Discover via MCP `initialize` |
| Add credit card | Wallet holds USDC |
| Get API key | No keys |
| $49/month minimum | $0.001 per call |
| Manage rate limits | Pay-per-use, no limits |
| Human in the loop | Agent fully autonomous |

---

## Verifying the deployment

```bash
# Service identity
curl https://agent-scrape.healingsunhaven.workers.dev/ | jq .

# x402 manifest
curl https://agent-scrape.healingsunhaven.workers.dev/.well-known/x402 | jq .

# 402 challenge with x402 v2 headers
curl -i -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
# → HTTP 402, Payment-Required header (base64 JSON), Cache-Control: private, no-store

# CORS preflight (browser-based agents)
curl -i -X OPTIONS https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type,X-Payment"
# → HTTP 204, allow-headers includes X-Payment and Payment-Signature
```

---

## Roadmap

**Q3 2026:**

- **AgentParse** — document/PDF/OCR-to-markdown service (same x402 + MCP pattern)
- **AgentSearch** — multi-backend web search aggregation
- LangChain integration package (`langchain-agent-scrape`)

**Q4 2026:**

- Subscription bundles (1000 scrapes for $2.50)
- Multi-asset support (USDT on Base, USDC on Arbitrum)
- Webhook + async response option for long-running workflows

---

## Run locally

Requires Node 22+, a Cloudflare account with Workers + Browser Rendering enabled, a Groq API key, and a Coinbase CDP API key.

```bash
git clone https://github.com/hshintelligence/agent-scrape.git
cd agent-scrape
npm install

# Set secrets
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET

# Local dev
npx wrangler dev

# Deploy
npx wrangler deploy
```

To use your own wallet as `payTo`, edit the `PAY_TO` constant in `src/index.ts`.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contact

Built by [HSH Intelligence](https://hshintelligence.com), operated by Healing Sun Haven LLC (Wyoming, USA).

- **Service:** https://agent-scrape.healingsunhaven.workers.dev
- **Repo:** https://github.com/hshintelligence/agent-scrape
- **General inquiries:** sales@healingsunhaven.com

---

**Pay-per-call web scraping for AI agents — no signup, no API keys, just USDC.**
