# HSH Lighthouse — One-Command Service Deploy

`hsh-deploy` provisions a new HSH Intelligence agent-native service across all 20 broadcast tower layers in a single command. Built on the multi-tenant architecture where each new service is a configuration entry, not a rebuild.

## Usage

```bash
./deploy/hsh-deploy.sh <svc-id> "<name>" "<tagline>" "<description>" "<category>"
```

## Example

```bash
./deploy/hsh-deploy.sh agent-vision "AgentVision" \
  "AI image generation for agents" \
  "Pay-per-call AI image generation via x402 v2 on Base USDC" \
  "image-generation"
```

## What it does (15 steps, ~3 minutes wall-clock)

1. Validates inputs and dependencies (gh, wrangler, git, ssh, rsync, python3)
2. Creates a public GitHub repo under `hshintelligence/<svc-id>` with MIT license
3. Clones the repo into a temp working directory
4. Renders Worker source from templates with service-specific substitutions
5. Installs npm dependencies, commits, pushes initial code to GitHub
6. Deploys the Worker to Cloudflare at `https://<svc-id>.healingsunhaven.workers.dev`
7. Adds 17 GitHub topics for LLM corpus indexing
8. Activates GitHub Discussions
9. Generates a service descriptor JSON from the daemon template
10. Uploads the descriptor to Hetzner at `/opt/hsh-broadcasting-tower/services/<svc-id>.json`
11. Restarts the broadcasting daemon to trigger the initial health tick
12. Pins the new x402 manifest to IPFS via Pinata and writes the CID back into the descriptor
13. Verifies all 11 Worker discovery surfaces respond HTTP 200
14. Verifies the daemon recognizes the new service
15. Verifies the public catalog at `/services.json` now lists it

## The 20 layers — who handles each

### 12 layers automated by the daemon (drop a JSON file, done)

| # | Layer | How |
|---|---|---|
| 1 | `/services.json` catalog | Daemon reads `services/*.json`, Worker proxies with 60s cache |
| 2 | `/broadcasts.json` log | Ring buffer captures every health tick + IPFS pin |
| 3 | `/broadcasts/<svc-id>.json` per-service log | Same ring buffer filtered by `svc` field |
| 4 | Daemon `/services` endpoint | Auto-hydrates from services dir |
| 5 | Daemon `/health` endpoint | Includes services count |
| 6 | Well-known monitor (15-min cron) | Pings every endpoint from descriptor |
| 7 | IPFS pin refresh (6-hour cron) | Re-pins x402 manifest for each service |
| 8 | Broadcast log ring buffer | Records every interaction |
| 9 | HSH service registry foundation | services/*.json is the source of truth |
| 10 | pm2 auto-restart resilience | Service persists across daemon reboots |
| 11 | Per-service stats (latency, healthy %) | Computed from ring buffer per svc |
| 12 | Multi-tenant Caddy routing | broadcasting.hshintelligence.com serves all |

### 8 layers automated by `hsh-deploy` (Worker template + APIs)

| # | Layer | How |
|---|---|---|
| 13 | Cloudflare Worker (svc-id subdomain) | `wrangler deploy` from template |
| 14 | A2A Agent Card at /.well-known/agent.json | Templated into Worker |
| 15 | Schema.org Service JSON-LD at /schema.json | Templated into Worker |
| 16 | /.well-known/ai-plugin.json | Templated into Worker |
| 17 | /.well-known/security.txt + /humans.txt | Templated into Worker |
| 18 | RFC 8288 Link header on root | Templated into Worker |
| 19 | x402 manifest at /.well-known/x402.json | Templated into Worker |
| 20 | IPFS pin of x402 manifest | Pinata API call writes CID back to descriptor |

### 1 layer requires manual one-time action

AID DNS TXT record at `_agent.<svc-subdomain>.hshintelligence.com` — add at Cloudflare zone manually. Listed in the script's final message under "Next steps".

## File layout
broadcasting/
├── deploy/
│   └── hsh-deploy.sh          ← the entry point (this script)
├── templates/
│   ├── service/
│   │   └── service.template.json   ← canonical service descriptor schema
│   └── worker/
│       ├── package.template.json
│       ├── wrangler.template.toml
│       └── src/
│           └── index.template.ts   ← 72-line Worker covering 8 layers
├── services/
│   ├── agent-scrape.json
│   └── <new-svc-id>.json       ← gets added here by step 9
└── src/
├── daemon.js               ← cron-driven, reads services/*.json
├── broadcasters/
└── lib/

## Substitution variables

The templates use `{{VAR}}` placeholders, replaced by Python during render:

- `{{SVC_ID}}` — kebab-case service identifier
- `{{SVC_NAME}}` — display name
- `{{SVC_TAGLINE}}` — one-line summary
- `{{SVC_DESCRIPTION}}` — paragraph description
- `{{SVC_CATEGORY}}` — Schema.org-style category

## What hsh-deploy does NOT do

- Submit to external MCP registries (Glama, Smithery, mcp.so, PulseMCP) — these require either browser actions or manual review cycles
- Generate per-service business logic (the Worker template ships discovery surfaces, not tools) — service-specific tools must be added manually to `src/index.ts` after first deploy
- On-chain attestations (EAS, ENS, Story Protocol) — these need funded Base wallet
- Framework PRs (ElizaOS, AgentKit, LangChain) — these need maintainer review

## Architectural principle

The lighthouse architecture treats every HSH service as a tenant of shared infrastructure. The broadcasting daemon is the single point of truth — it lists services, monitors them, logs their broadcasts, and refreshes their IPFS pins. The Worker template ships only the per-service discovery surfaces and leaves business logic empty for service-specific code to fill in.

Adding service #2, #3, #N is now a 3-minute operation with one command. Service #1 (AgentScrape) was built before this tooling existed, so it remains hand-written and is the source of patterns this template generalizes.
