# AgentScrape

> **Pay-per-call web scraping for AI agents — no signup, no API keys, just USDC.**

[![x402](https://img.shields.io/badge/x402-monetized-blue)](https://x402.org)
[![MCP](https://img.shields.io/badge/MCP-native-purple)](https://modelcontextprotocol.io)
[![Base](https://img.shields.io/badge/Network-Base%20mainnet-0052FF)](https://base.org)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Live:** `https://agent-scrape.healingsunhaven.workers.dev`

AgentScrape is an autonomous web scraping toolkit built for the AI agent economy. AI agents discover it, pay per call in USDC on Base, and get clean structured data back — no accounts, no API keys, no human in the loop.

Two protocols, one service:

- **HTTP API** with x402 payment gate — for agents using raw HTTP
- **MCP server** (Streamable HTTP transport) — for agents using Claude Desktop, Cursor, Continue.dev, or any MCP-compatible framework

---

## Why AgentScrape

Traditional scraping APIs assume a human:
- Sign up with email
- Add a payment method
- Manage an API key
- Commit to a monthly subscription

**AI agents can't do any of that.** They have wallets. They have stablecoins. They need infrastructure that speaks their language.

AgentScrape is built on **[x402](https://x402.org)** — an open HTTP-native payment protocol — and **[MCP](https://modelcontextprotocol.io)** — the standard agent tool interface. When an agent calls a tool, the server returns HTTP 402 with payment requirements; the agent signs a USDC transfer authorization; the server settles via the x402 facilitator; the data flows back. End-to-end in under 2 seconds.

No signup. No API keys. No subscription. Just USDC.

---

## Tools

All tools are priced at **$0.001 USDC** during the 48-hour mainnet validation window. Pricing tiers ramp after stability is proven.

| Tool | Description | Use case |
|---|---|---|
| `scrape_webpage` | Scrape any URL to markdown, HTML, text, or JSON | General-purpose data fetch |
| `extract_structured_data` | AI-powered structured extraction with natural-language prompts and JSON schemas | Pull JSON matching a natural-language prompt or JSON schema |
| `screenshot_webpage` | PNG screenshot with viewport control (desktop/mobile/tablet, optional full-page) | Visual verification, OG image capture |
| `extract_metadata` | Title, description, Open Graph, Twitter cards, JSON-LD, canonical URL, all meta tags | SEO research, link unfurling |
| `create_browser_session` | Stateful browser session with cookie + localStorage persistence | Multi-step authenticated flows |
| `run_workflow` | Multi-step atomic execution: navigate, click, type, wait, scroll, screenshot, extract, evaluate | Form submissions, search-and-extract, interactive scraping |

---

## Quick start — HTTP API

```bash
# Free service discovery — no payment needed
curl https://agent-scrape.healingsunhaven.workers.dev/

# Paid call — without payment header, returns HTTP 402
curl -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "format": "markdown"}'

# Free tier — first 10 calls per wallet, send your wallet in the x402-payer header
curl -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -H "x402-payer: 0xYourBaseWalletAddress" \
  -d '{"url": "https://example.com", "format": "markdown"}'
```

---

## Quick start — MCP

Add AgentScrape to any MCP-compatible client using Streamable HTTP transport:

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

Then in your agent, call any of the 6 tools. The x402 payment metadata is broadcast inside the MCP tool listing — your client handles the payment handshake automatically when configured with an x402-compatible wallet.

---

## Architecture
                ┌──────────────────────────────────┐
                │      Cloudflare Workers          │
                │      (global edge, 330+ POPs)    │
                │                                  │
AI Agent ────────┼─▶  GET  /         (free)         │
(HTTP)           ├─▶  POST /scrape   ($0.001)       │
├─▶  POST /extract  ($0.001)       │
├─▶  POST /screenshot ($0.001)     │
├─▶  POST /metadata ($0.001)       │
├─▶  POST /workflow ($0.001)       │
├─▶  POST /session  ($0.001)       │
│                                  │
AI Agent ────────┼─▶  POST /mcp                     │
(MCP)            │     • initialize                 │
│     • tools/list                 │
│     • tools/call (paid)          │
│                                  │
└──────────────┬───────────────────┘
│
┌──────────────┴────────────────────┐
│                                   │
x402 facilitator               Browser Rendering API
(settles USDC                  Groq API (Llama 4 Scout)
on Base mainnet)              KV (sessions, cache, free tier)
│
▼
payTo wallet
0x3F33...9E9a

**Stack:**
- **Runtime:** Cloudflare Workers (V8 isolates, global edge)
- **Framework:** [Hono](https://hono.dev) (HTTP) + [@x402/hono](https://github.com/x402-foundation/x402) v2 (payment middleware) + [agents/mcp](https://github.com/cloudflare/agents) + [agents/x402](https://github.com/cloudflare/agents) (MCP-native payment)
- **Browser:** Cloudflare Browser Rendering API + [@cloudflare/puppeteer](https://developers.cloudflare.com/browser-rendering/)
- **AI extraction:** [Groq](https://groq.com) + Llama 4 Scout (17B, 16E)
- **Storage:** Cloudflare KV (5-minute response cache, browser sessions, free-tier counters)
- **Network:** Base mainnet (`eip155:8453`)
- **Asset:** Native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Facilitator:** xpay.sh (zero-auth, gas-sponsored)

---

## Free tier

To make integration friction-free, every wallet address gets **10 free calls per 30 days** on the HTTP API. Pass your Base wallet address in the `x402-payer` header. After 10 calls, payment via x402 is required.

The free tier is HTTP-only. MCP calls go through the standard x402 payment flow with optional client-side preview before signing.

---

## Pricing

Launch (first 48h on mainnet): **$0.001 flat per tool call.**

After validation, pricing ramps to:

| Tool | Production price |
|---|---|
| `scrape_webpage` | $0.003 |
| `extract_structured_data` | $0.005 |
| `screenshot_webpage` | $0.003 |
| `extract_metadata` | $0.002 |
| `run_workflow` | $0.008 |
| `create_browser_session` | $0.001 |

These prices reflect compute cost (browser rendering, AI inference, gas amortization) plus a thin margin. Bulk discounts (20% at 1K calls/month, 40% at 10K) are planned.

---

## Why x402 + MCP

| Old way | x402 + MCP way |
|---|---|
| Sign up at scraperapi.com | Discover via MCP `initialize` |
| Add credit card | Wallet holds USDC |
| Get API key | No keys |
| $49/month minimum | $0.001 per call |
| Manage rate limits | Pay-per-use, no limits |
| Human in the loop | Agent fully autonomous |

The agent economy in 2026 is moving billions of USDC daily through x402 settlements. Services that speak the protocol natively are the only ones that get used.

---

## Roadmap

**Q3 2026:**
- **AgentParse** — document/PDF/OCR-to-markdown service (same x402 + MCP pattern)
- **AgentSearch** — multi-backend web search aggregation
- LangChain integration package (`langchain-agent-scrape`)
- CDP facilitator support (unlocks Bazaar auto-indexing)

**Q4 2026:**
- Subscription bundles (e.g. 1000 scrapes for $2.50)
- Multi-asset support (USDT on Base, USDC on Arbitrum)
- Webhook + async response option for long-running workflows

---

## Run locally

Requires Node 22+, Cloudflare account with Workers + Browser Rendering enabled, and a Groq API key.

```bash
git clone https://github.com/hshintelligence/agent-scrape.git
cd agent-scrape
npm install

# Set secrets
npx wrangler secret put GROQ_API_KEY

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

Built by [HSH Intelligence](https://hshintelligence.com), a portfolio of B2B data and agent-economy services operated by Healing Sun Haven LLC (Wyoming, USA).

- **Service:** https://agent-scrape.healingsunhaven.workers.dev
- **Repo:** https://github.com/hshintelligence/agent-scrape
- **General inquiries:** sales@healingsunhaven.com

---

**Pay-per-call web scraping for AI agents — no signup, no API keys, just USDC.**
