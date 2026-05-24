# Your AI Agent Can Now Pay $0.001 Per Scrape with x402 — No API Keys Needed

When AI agents need to call an API today, they hit a wall. Sign up. Get a key. Manage rotation. Hit rate limits. Pay a subscription that doesn't match actual usage.

That model was built for humans clicking through dashboards. It doesn't fit agents.

We just shipped **AgentScrape** — a pay-per-call web scraping API for AI agents that uses the x402 payment protocol. Each call costs $0.001 USDC on Base mainnet. There is no signup. There are no API keys. The agent pays per request and gets the data.

This post is about how x402 works, what we built, and how to plug AgentScrape into your agent right now.

---

## The Problem with API Keys for AI Agents

API keys were designed for a static world: one developer, one product, one bill. Agents break all three assumptions.

A single LangChain agent might call thirty different APIs across one task. Each API wants its own key, its own auth flow, its own subscription tier. The developer has to predict which APIs the agent will need, sign up for each one, and configure rotation logic.

The result is a mountain of glue code that doesn't help the agent do useful work. Worse, the agent can never call an API the developer didn't pre-arrange.

What agents actually want is a protocol where they can discover a service, see its price, pay for the exact call they need, and move on. No accounts. No keys. No commitments.

That protocol exists. It's called **x402**.

---

## How x402 Works in 60 Seconds

x402 is a payment protocol built on the HTTP 402 status code (the "Payment Required" code that's been reserved since 1997 and barely used).

The flow is:

1. **Agent calls the API.** No auth.
2. **API responds with HTTP 402.** Body includes price ($0.001), network (Base mainnet), recipient wallet address, and asset (USDC).
3. **Agent signs a USDC transfer authorization** using EIP-3009 (gasless, off-chain signature).
4. **Agent retries the call** with the signed payment payload in the `X-PAYMENT` header.
5. **API verifies the payment via a facilitator service**, then settles it on-chain.
6. **API returns the data.**

The facilitator handles all blockchain interaction. The API server doesn't need RPC nodes, hot wallets, or transaction signing. The agent doesn't need an account anywhere except a self-custodied wallet.

Coinbase operates the production x402 facilitator at `api.cdp.coinbase.com/platform/v2/x402`. They charge zero facilitator fees on Base mainnet — only the network's nominal gas cost, which they sponsor for the buyer.

---

## What We Built: AgentScrape v0.6.0

AgentScrape exposes six paid tools through both an HTTP REST API and an MCP (Model Context Protocol) server:

- `scrape_webpage` — Clean HTML/Markdown/text/JSON extraction
- `extract_structured_data` — Schema-defined JSON extraction via Groq + Llama
- `screenshot_webpage` — Full-page PNG captures with viewport control
- `extract_metadata` — Open Graph, Twitter cards, JSON-LD parsing
- `create_browser_session` — Persistent browser contexts for multi-step flows
- `run_workflow` — Composite multi-step operations in one call

Every tool costs $0.001 per call. The first 10 calls per wallet are free for evaluation.

### The Stack

The whole thing runs on Cloudflare Workers:

- **Runtime:** Cloudflare Workers (V8 isolate, global edge deployment)
- **Browser:** Cloudflare Browser Rendering (managed headless Chrome)
- **HTTP framework:** Hono v4 with `@x402/hono` v2 payment middleware
- **MCP transport:** `agents/mcp` + `agents/x402` from the Cloudflare Agents SDK
- **Facilitator:** Coinbase CDP at `api.cdp.coinbase.com/platform/v2/x402`
- **Auth:** Ed25519 JWT signed with `jose` (Workers-compatible via Web Crypto API)
- **AI extraction:** Groq inference with Llama 4 Scout (17B)

The Worker is ~1000 lines of TypeScript. Total deploy bundle: 548 KB gzipped. Cold start: 72ms.

---

## Try It Now

### As an MCP Server in Claude Desktop, Cursor, or any MCP client

Install via Smithery in one command:

```bash
npx -y @smithery/cli install hshintelligence/agentscrape --client claude
```

That registers six paid tools your agent can call directly. The agent handles payment automatically through Cloudflare's `agents/x402` client wrapper — you never see a key prompt.

### As a Direct HTTP API

```bash
# 1. Request — get a 402 with payment requirements
curl -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","format":"markdown"}'

# Response:
# HTTP/2 402
# payment-required: <base64-encoded x402 v2 PaymentRequired>
```

The `payment-required` header decodes to a complete x402 v2 payment requirements object: scheme, network, amount, USDC asset address, payTo wallet, and timeout.

A client using `@x402/fetch` or any x402-compliant wrapper signs the payment and retries automatically. The second call returns the scraped data.

### Free Tier

If you just want to test scraping without any wallet setup, the HTTP API offers 10 free calls per wallet per 30 days. Set an `x402-payer` header with any identifier:

```bash
curl -X POST https://agent-scrape.healingsunhaven.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -H "x402-payer: my-test-id" \
  -d '{"url":"https://news.ycombinator.com"}'
```

---

## What We Learned Shipping This

A few notes from the build that may save other teams time:

**The CDP facilitator URL is `api.cdp.coinbase.com/platform/v2/x402`, not `x402.org/facilitator`.** The x402.org facilitator is testnet-only (Base Sepolia, Solana Devnet). For real money on Base mainnet, you need the CDP endpoint with CDP API keys.

**Authentication is Ed25519 JWT, not API key headers.** Each call to verify/settle requires a freshly signed JWT with claims `iss: "cdp"`, `sub: <keyId>`, `aud: ["cdp_service"]`, `uri: "<METHOD> api.cdp.coinbase.com<path>"`, and a 120-second expiry.

**CDP gives you a raw 88-character base64 key, not PKCS#8 PEM.** The `jose` library needs PKCS#8. Conversion is straightforward: take the first 32 bytes of the decoded key, prepend the Ed25519 PKCS#8 ASN.1 prefix (`302e020100300506032b657004220420`), wrap in PEM headers.

**The `agents/x402` and `@x402/core` packages share the same `FacilitatorConfig` interface.** You write one `createAuthHeaders` callback and pass it to both the HTTP middleware (`HTTPFacilitatorClient`) and the MCP layer (`withX402`).

**Coinbase Bazaar (their official x402 discovery directory) indexes automatically.** No PR, no form, no manifest file. Add `bazaarResourceServerExtension` and `declareDiscoveryExtension()` per route, complete one successful settlement through CDP, and your service appears in `api.cdp.coinbase.com/platform/v2/x402/discovery/resources` within 10 minutes.

---

## Where AgentScrape Goes Next

Today, every tool is flat-priced at $0.001 for 48-hour market validation. Once we have settlement data, pricing will move to a tiered structure that reflects actual compute cost per operation.

We're also working on two adjacent products: AgentParse (PDF/OCR extraction) and AgentSearch (federated search across the web + arXiv + GitHub). All three will share the same x402 payment surface, so agents that adopt one get the others for free.

If you're building agents and want to skip the API-key glue code, give AgentScrape a try. Star the repo, install via Smithery, or call the HTTP endpoint directly. Feedback and bug reports are welcome.

**Links:**
- GitHub: https://github.com/hshintelligence/agent-scrape
- Smithery: https://smithery.ai/servers/hshintelligence/agentscrape
- Live API: https://agent-scrape.healingsunhaven.workers.dev
- x402 protocol: https://x402.gitbook.io/x402
