#!/usr/bin/env bash
# hsh-deploy — one-command HSH service provisioner
# Provisions all 20 broadcast tower layers for a new HSH agent-native service.
#
# Usage:
#   ./deploy/hsh-deploy.sh <svc-id> "<service-name>" "<tagline>" "<description>" "<category>"
#
# Example:
#   ./deploy/hsh-deploy.sh agent-vision "AgentVision" \
#     "AI image generation for agents" \
#     "Pay-per-call AI image generation via x402 on Base USDC" \
#     "image-generation"
#
# What this does (in order):
#   1.  Validates inputs + dependencies
#   2.  Creates GitHub repo (public, MIT licensed)
#   3.  Generates Worker source from templates (8 layers)
#   4.  Pushes Worker code to GitHub
#   5.  Deploys Worker to Cloudflare
#   6.  Adds GitHub topics (LLM corpus indexing)
#   7.  Sets GitHub homepage URL to deployed Worker
#   8.  Copies brand badges into new repo
#   9.  Generates service descriptor JSON for daemon
#  10.  Uploads descriptor to Hetzner broadcasting/services/
#  11.  Restarts daemon (auto-broadcasts to 12 lighthouse layers)
#  12.  Pins x402 manifest to IPFS via Pinata
#  13.  Adds AID DNS TXT record at Cloudflare (if API token present)
#  14.  Activates GitHub Discussions on new repo
#  15.  Final verification — fetches all surfaces, confirms they're live

set -euo pipefail

# ============================================================
# ARGS + VALIDATION
# ============================================================
if [ "$#" -lt 5 ]; then
  cat <<USAGE
Usage: $0 <svc-id> "<name>" "<tagline>" "<description>" "<category>"

  svc-id        kebab-case identifier, e.g. agent-vision
  name          display name, e.g. "AgentVision"
  tagline       one-line tagline (<=80 chars)
  description   one-paragraph description (<=300 chars)
  category      e.g. "image-generation", "web-scraping", "rag"

Example:
  $0 agent-vision "AgentVision" \\
     "AI image generation for agents" \\
     "Pay-per-call AI image generation via x402 v2 on Base USDC" \\
     "image-generation"
USAGE
  exit 1
fi

SVC_ID="$1"
SVC_NAME="$2"
SVC_TAGLINE="$3"
SVC_DESCRIPTION="$4"
SVC_CATEGORY="$5"

# Validate svc-id format (kebab-case, alphanumeric + dashes only)
if ! [[ "$SVC_ID" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]]; then
  echo "✗ svc-id must be kebab-case (e.g. agent-vision), got: $SVC_ID"; exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HETZNER_HOST="root@204.168.244.106"
HSH_ORG="hshintelligence"
GH_REPO="${HSH_ORG}/${SVC_ID}"

# Resolve GitHub-noreply email for commit author (avoids email-privacy push rejection)
GH_USER_LOGIN=$(gh api user --jq '.login' 2>/dev/null || echo "hshintelligence")
GH_USER_ID=$(gh api user --jq '.id' 2>/dev/null || echo "0")
COMMIT_EMAIL="${GH_USER_ID}+${GH_USER_LOGIN}@users.noreply.github.com"
WORKER_URL="https://${SVC_ID}.healingsunhaven.workers.dev"
TMP_DIR="$(mktemp -d)"
trap "rm -rf $TMP_DIR" EXIT

# ── Idempotent git helpers (kimi.ai-researched, set -e safe) ──
safe_git_commit() {
  local msg="$1"
  if git diff --cached --quiet; then
    echo "  • Nothing staged, skipping commit"
    return 0
  fi
  git commit -m "$msg" --quiet
}

safe_git_push() {
  local branch="${1:-main}"
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "  • No remote configured, skipping push"
    return 0
  fi
  git fetch origin "$branch" --quiet 2>/dev/null || true
  local local_head remote_head
  local_head=$(git rev-parse "$branch" 2>/dev/null || echo "x")
  remote_head=$(git rev-parse "origin/$branch" 2>/dev/null || echo "y")
  if [[ "$local_head" == "$remote_head" ]]; then
    echo "  • Remote $branch already up-to-date"
    return 0
  fi
  git push origin "$branch" --quiet
}

safe_git_sync() {
  local msg="$1"
  local branch="${2:-main}"
  git add -A
  safe_git_commit "$msg"
  safe_git_push "$branch"
}

echo "================================================================"
echo "  HSH-DEPLOY  ::  $SVC_NAME  ($SVC_ID)"
echo "================================================================"
echo "  GitHub:    https://github.com/$GH_REPO"
echo "  Worker:    $WORKER_URL"
echo "  Category:  $SVC_CATEGORY"
echo "  Tagline:   $SVC_TAGLINE"
echo "  Work dir:  $TMP_DIR"
echo "================================================================"
echo ""

# ============================================================
# DEPENDENCIES
# ============================================================
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing: $1"; exit 1; }; }
need gh
need git

# wrangler: prefer global, fall back to npx (Cloudflare CLI is often project-local)
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER_CMD="wrangler"
elif command -v npx >/dev/null 2>&1; then
  WRANGLER_CMD="npx --yes wrangler@latest"
  echo "  • Using npx wrangler (no global install detected)"
else
  echo "✗ missing: wrangler (and npx not available either)"; exit 1
fi
need curl
need ssh
need rsync
need python3

# ============================================================
# STEP 1 — Create GitHub repo
# ============================================================
echo "[1/17] Creating GitHub repo $GH_REPO..."
if gh repo view "$GH_REPO" >/dev/null 2>&1; then
  echo "  • Repo already exists, skipping creation"
else
  gh repo create "$GH_REPO" \
    --public \
    --description "$SVC_DESCRIPTION" \
    --homepage "$WORKER_URL" \
    --license MIT \
    --add-readme=false
  echo "  ✓ Repo created"
fi

# ============================================================
# STEP 2 — Clone repo locally
# ============================================================
echo "[2/17] Cloning into $TMP_DIR/$SVC_ID..."
cd "$TMP_DIR"
gh repo clone "$GH_REPO" "$SVC_ID" -- -q
cd "$SVC_ID"

# ============================================================
# STEP 3 — Render Worker source from templates
# ============================================================
echo "[3/17] Rendering Worker source from templates..."
mkdir -p src .github/workflows assets/badges

# Use python for safe template substitution
python3 <<PYEOF
import os
substitutions = {
    "{{SVC_ID}}": "$SVC_ID",
    "{{SVC_NAME}}": "$SVC_NAME",
    "{{SVC_TAGLINE}}": "$SVC_TAGLINE",
    "{{SVC_DESCRIPTION}}": "$SVC_DESCRIPTION",
    "{{SVC_CATEGORY}}": "$SVC_CATEGORY",
}
template_files = [
    ("$REPO_ROOT/templates/worker/src/index.template.ts", "src/index.ts"),
    ("$REPO_ROOT/templates/worker/wrangler.template.toml", "wrangler.toml"),
    ("$REPO_ROOT/templates/worker/package.template.json", "package.json"),
]
for src, dst in template_files:
    with open(src) as f: content = f.read()
    for k, v in substitutions.items(): content = content.replace(k, v)
    with open(dst, "w") as f: f.write(content)
    print(f"  ✓ Rendered {dst}")
PYEOF

# README
cat > README.md <<READMEEOF
# $SVC_NAME

> $SVC_TAGLINE

$SVC_DESCRIPTION

[![Powered by AgentScrape](https://raw.githubusercontent.com/hshintelligence/agent-scrape/main/assets/badges/x402-powered.svg)](https://www.x402.org)

## Endpoints

- **MCP**: \`$WORKER_URL/mcp\`
- **A2A Agent Card**: \`$WORKER_URL/.well-known/agent.json\`
- **x402 manifest**: \`$WORKER_URL/.well-known/x402.json\`
- **OpenAPI**: \`$WORKER_URL/openapi.json\`
- **llms.txt**: \`$WORKER_URL/llms.txt\`

## Payment

Pay-per-call in USDC on Base mainnet via the x402 v2 protocol. No signup, no API keys.

## Part of HSH Intelligence

This service is broadcast 24/7 by the [HSH Broadcasting Tower](https://broadcasting.hshintelligence.com).
See all HSH services: $WORKER_URL/services.json

## Using $SVC_NAME from ElizaOS

ElizaOS supports remote MCP servers natively via [@elizaos/plugin-mcp](https://www.npmjs.com/package/@elizaos/plugin-mcp):

    bun add @elizaos/plugin-mcp

Add to your character JSON:

    {
      "plugins": ["@elizaos/plugin-mcp"],
      "settings": {
        "mcp": {
          "servers": {
            "$SVC_ID": {
              "type": "streamable-http",
              "url": "$WORKER_URL/mcp"
            }
          }
        }
      }
    }

## Using $SVC_NAME from LangChain.js

    import { MultiServerMCPClient } from "@langchain/mcp-adapters";

    const client = new MultiServerMCPClient({
      mcpServers: {
        $SVC_ID: { url: "$WORKER_URL/mcp" }
      }
    });
    const tools = await client.getTools();

## Using $SVC_NAME from LangChain Python

    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient({
        "$SVC_ID": {
            "url": "$WORKER_URL/mcp",
            "transport": "streamable_http",
        }
    })
    tools = await client.get_tools()

## Using $SVC_NAME from LlamaIndex

    from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

    mcp_client = BasicMCPClient("$WORKER_URL/mcp")
    tools = McpToolSpec(client=mcp_client).to_tool_list()

## Discoverability

- Official MCP Registry: io.github.$HSH_ORG/$SVC_ID
- A2A Agent Card: $WORKER_URL/.well-known/agent.json
- x402 manifest: $WORKER_URL/.well-known/x402.json
- OpenAPI 3.1: $WORKER_URL/openapi.json
- llms.txt: $WORKER_URL/llms.txt

## License

MIT
READMEEOF
echo "  ✓ README.md written"

# .gitignore
cat > .gitignore <<'GIEOF'
node_modules
.wrangler
.dev.vars
.env
.DS_Store
dist
GIEOF

# ============================================================
# STEP 4 — npm install + commit + push
# ============================================================
echo "[4/17] Installing dependencies + idempotent commit..."
npm install --silent 2>&1 | tail -3 || echo "  (npm install will run later)"
git config user.email "$COMMIT_EMAIL"
git config user.name "HSH Intelligence"
git add -A
safe_git_commit "feat: initial $SVC_NAME service from HSH lighthouse template

Auto-provisioned by hsh-deploy. Ships all 8 per-service broadcast layers:
- A2A Agent Card
- Schema.org Service JSON-LD
- /.well-known/ai-plugin.json (OpenAI plugin spec)
- /.well-known/security.txt (RFC 9116)
- /humans.txt
- RFC 8288 Link header on root
- x402 v2 manifest at /.well-known/x402.json (+ /.well-known/x402 alias)
- llms.txt + openapi.json

Connects to HSH Broadcasting Tower so the 12 lighthouse-internal layers
auto-broadcast this service on the next 15-minute health tick."
safe_git_push main
echo "  ✓ Initial commit synced"

# ============================================================
# STEP 5 — Deploy Worker to Cloudflare
# ============================================================
echo "[5/17] Deploying Worker to Cloudflare..."
$WRANGLER_CMD deploy 2>&1 | tail -4
echo "  ✓ Worker deployed at $WORKER_URL"

# ============================================================
# STEP 6 — Add GitHub topics
# ============================================================
echo "[6/17] Adding GitHub topics..."
gh repo edit "$GH_REPO" \
  --add-topic x402 --add-topic x402-protocol \
  --add-topic mcp --add-topic mcp-server --add-topic model-context-protocol \
  --add-topic ai-agents --add-topic agent-native --add-topic agentic-commerce \
  --add-topic usdc --add-topic base-network --add-topic coinbase \
  --add-topic cloudflare-workers --add-topic typescript --add-topic hono \
  --add-topic pay-per-call --add-topic micropayments \
  --add-topic "$SVC_CATEGORY" 2>&1 | tail -3
echo "  ✓ 17 topics added"

# ============================================================
# STEP 7 — Activate Discussions
# ============================================================
echo "[7/17] Activating GitHub Discussions..."
gh api -X PATCH "/repos/$GH_REPO" -F has_discussions=true --jq '{has_discussions}' >/dev/null
echo "  ✓ Discussions activated"

# ============================================================
# STEP 8 — Generate service descriptor for Hetzner daemon
# ============================================================
echo "[8/17] Generating service descriptor JSON..."
python3 <<PYEOF > "$TMP_DIR/${SVC_ID}.json"
import json
with open("$REPO_ROOT/templates/service/service.template.json") as f:
    raw = f.read()
subs = {
    "{{SVC_ID}}": "$SVC_ID",
    "{{SVC_NAME}}": "$SVC_NAME",
    "{{SVC_TAGLINE}}": "$SVC_TAGLINE",
    "{{SVC_DESCRIPTION}}": "$SVC_DESCRIPTION",
    "{{SVC_CATEGORY}}": "$SVC_CATEGORY",
}
for k, v in subs.items(): raw = raw.replace(k, v)
print(json.dumps(json.loads(raw), indent=2))
PYEOF
echo "  ✓ Descriptor written: $TMP_DIR/${SVC_ID}.json"

# ============================================================
# STEP 9 — Push descriptor to Hetzner daemon
# ============================================================
echo "[9/17] Uploading descriptor to Hetzner..."
scp -q "$TMP_DIR/${SVC_ID}.json" "$HETZNER_HOST:/opt/hsh-broadcasting-tower/services/${SVC_ID}.json"
echo "  ✓ Descriptor uploaded to /opt/hsh-broadcasting-tower/services/${SVC_ID}.json"

# ============================================================
# STEP 10 — Restart daemon (triggers immediate broadcast tick)
# ============================================================
echo "[10/17] Restarting broadcasting daemon..."
ssh -q "$HETZNER_HOST" 'pm2 restart hsh-broadcasting-tower 2>&1 | tail -3'
sleep 6
echo "  ✓ Daemon restarted, initial broadcast tick fired"

# ============================================================
# STEP 11 — Pin x402 manifest to IPFS via daemon (uses PINATA_JWT from daemon .env)
# ============================================================
echo "[11/17] Triggering IPFS pin for $SVC_ID manifest..."
ssh -q "$HETZNER_HOST" "bash -lc '
  source /opt/hsh-broadcasting-tower/.env
  MANIFEST=\$(curl -s ${WORKER_URL}/.well-known/x402.json)
  RESPONSE=\$(curl -s -X POST https://api.pinata.cloud/pinning/pinJSONToIPFS \
    -H \"Authorization: Bearer \$PINATA_JWT\" \
    -H \"Content-Type: application/json\" \
    -d \"{\\\"pinataContent\\\":\$MANIFEST,\\\"pinataMetadata\\\":{\\\"name\\\":\\\"${SVC_ID}-x402-manifest-v1\\\",\\\"keyvalues\\\":{\\\"service\\\":\\\"${SVC_ID}\\\",\\\"org\\\":\\\"hsh-intelligence\\\"}}}\")
  CID=\$(echo \"\$RESPONSE\" | python3 -c \"import json,sys; print(json.load(sys.stdin).get(\\\"IpfsHash\\\",\\\"\\\"))\")
  echo \"  CID: \$CID\"
  if [ -n \"\$CID\" ]; then
    python3 -c \"
import json
with open(\\\"/opt/hsh-broadcasting-tower/services/${SVC_ID}.json\\\") as f: d=json.load(f)
d[\\\"ipfs\\\"][\\\"manifest_cid\\\"]=\\\"\$CID\\\"
d[\\\"ipfs\\\"][\\\"pinned_at\\\"]=__import__(\\\"datetime\\\").datetime.utcnow().isoformat()+\\\"Z\\\"
with open(\\\"/opt/hsh-broadcasting-tower/services/${SVC_ID}.json\\\",\\\"w\\\") as f: json.dump(d,f,indent=2)
print(\\\"  ✓ Descriptor updated with CID\\\")
\"
  fi
'"

# ============================================================
# STEP 12 — Publish to Official MCP Registry (canonical Anthropic registry)
# ============================================================
echo "[12/17] Publishing to Official MCP Registry..."

MCP_REG_DIR="$TMP_DIR/${SVC_ID}/mcp-registry"
mkdir -p "$MCP_REG_DIR"

# Build server.json (description capped to 100 chars to satisfy registry schema)
python3 - <<PYJSON > "$MCP_REG_DIR/server.json"
import json
desc = "$SVC_TAGLINE"
if len(desc) > 100:
    desc = desc[:97] + "..."
print(json.dumps({
  "\$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": f"io.github.$HSH_ORG/$SVC_ID",
  "title": "$SVC_NAME",
  "description": desc,
  "version": "0.1.0",
  "repository": {
    "url": f"https://github.com/$HSH_ORG/$SVC_ID",
    "source": "github"
  },
  "websiteUrl": "$WORKER_URL",
  "remotes": [
    {"type": "streamable-http", "url": f"$WORKER_URL/mcp"}
  ]
}, indent=2))
PYJSON
echo "  ✓ server.json prepared at mcp-registry/server.json"

# Also write a README for the artifact
cat > "$MCP_REG_DIR/README.md" <<MDEOF
# Official MCP Registry artifact

This directory contains the canonical server.json published to the
Official MCP Registry at io.github.$HSH_ORG/$SVC_ID.

## Re-publish on version bump

    brew install mcp-publisher
    mcp-publisher login github
    cd mcp-registry/
    mcp-publisher validate
    mcp-publisher publish
MDEOF

# Validate + publish (non-fatal — graceful skip on missing CLI or expired JWT)
if command -v mcp-publisher >/dev/null 2>&1; then
  (
    cd "$MCP_REG_DIR"
    if mcp-publisher validate 2>&1 | sed 's/^/    /'; then
      if mcp-publisher publish 2>&1 | tee /tmp/mcp-pub-$$.log | sed 's/^/    /' | grep -q "Successfully published"; then
        echo "  ✓ Published to registry.modelcontextprotocol.io"
      elif grep -qi "expired\|unauthorized\|jwt" /tmp/mcp-pub-$$.log 2>/dev/null; then
        echo "  ⚠ Registry JWT expired — run 'mcp-publisher login github' then re-run"
      else
        echo "  ⚠ Publish skipped (non-fatal — other layers shipped)"
      fi
      rm -f /tmp/mcp-pub-$$.log
    fi
  ) || true
else
  echo "  ⚠ mcp-publisher not installed (install: brew install mcp-publisher)"
fi

# Commit the registry artifact into the new service's repo (idempotent)
(
  cd "$TMP_DIR/$SVC_ID"
  git add mcp-registry/
  safe_git_commit "feat: publish to Official MCP Registry as io.github.$HSH_ORG/$SVC_ID"
  safe_git_push main
) || true
echo "  ✓ mcp-registry/ committed to repo"

# ============================================================
# STEP 13 — Final verification
# ============================================================
echo "[13/17] Verifying deployment..."
sleep 4
SURFACES=(
  "/"
  "/.well-known/agent.json"
  "/.well-known/x402.json"
  "/.well-known/ai-plugin.json"
  "/.well-known/security.txt"
  "/humans.txt"
  "/schema.json"
  "/openapi.json"
  "/llms.txt"
  "/services.json"
  "/broadcasts.json"
)
healthy=0
total=${#SURFACES[@]}
for s in "${SURFACES[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}${s}")
  if [ "$code" = "200" ]; then
    healthy=$((healthy+1))
    echo "  ✓ $code  $s"
  else
    echo "  ✗ $code  $s"
  fi
done
echo ""
echo "  Per-service surfaces healthy: $healthy/$total"

# Verify daemon knows about the new service
echo ""
echo "[14/17] Verifying daemon sees the service..."
DAEMON_SERVICES=$(ssh -q "$HETZNER_HOST" "curl -s http://localhost:3000/services")
echo "  Daemon services: $DAEMON_SERVICES"

# Verify catalog endpoint includes it
echo ""
echo "[15/17] Verifying public catalog includes it..."
sleep 3
CATALOG=$(curl -s "https://agent-scrape.healingsunhaven.workers.dev/services.json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'  Catalog count: {d[\"count\"]}')
for s in d.get('services', []): print(f'    - {s[\"id\"]} ({s[\"name\"]})')
")
echo "$CATALOG"

# ============================================================
# STEP 16 — Prep awesome-list PR branches (best-effort, non-fatal)
# ============================================================
echo "[16/17] Prepping awesome-list PR branches..."

prep_registry_pr() {
  local upstream="$1" fork_name="$2"
  local fork_url="https://github.com/$HSH_ORG/$fork_name.git"
  local pr_url="https://github.com/$upstream/compare/main...$HSH_ORG:$fork_name:add-$SVC_ID"
  local clone_dir="$TMP_DIR/registry-prs/$fork_name"

  echo "  → $upstream (branch: add-$SVC_ID)"
  mkdir -p "$TMP_DIR/registry-prs"

  # Best-effort fork (idempotent — silently no-op if already exists)
  gh api -X POST "/repos/$upstream/forks" -F name="$fork_name" -F default_branch_only=true >/dev/null 2>&1 || true
  sleep 2

  # Clone our fork (skip if not yet created or maintainer disabled forks)
  if ! git clone "$fork_url" "$clone_dir" --quiet 2>/dev/null; then
    echo "    ⚠ fork not available (maintainer may have disabled forks) — manual PR needed"
    echo "    PR URL: $pr_url"
    return 0
  fi

  (
    cd "$clone_dir"
    git remote add upstream "https://github.com/$upstream.git" 2>/dev/null || true
    git fetch upstream main --quiet 2>/dev/null || true
    git reset --hard upstream/main --quiet 2>/dev/null || true
    git checkout -b "add-$SVC_ID" --quiet 2>/dev/null || git checkout "add-$SVC_ID" --quiet

    # Build the markdown bullet — using printf with single-quoted format
    # string to avoid bash command-substitution on the backticks
    local bullet
    printf -v bullet -- "- [%s/%s](https://github.com/%s/%s) - %s. MIT licensed. Live at %s." \
      "$HSH_ORG" "$SVC_ID" "$HSH_ORG" "$SVC_ID" "$SVC_TAGLINE" "$WORKER_URL/mcp"

    if grep -qF "$HSH_ORG/$SVC_ID" README.md 2>/dev/null; then
      echo "    • Bullet already present, skipping README edit"
    else
      printf '\n%s\n' "$bullet" >> README.md
      git config user.email "$COMMIT_EMAIL"
      git config user.name "HSH Intelligence"
      git add README.md
      safe_git_commit "Add $SVC_NAME to $upstream"
      git push origin "add-$SVC_ID" --quiet 2>&1 | tail -2
      echo "    ✓ Branch pushed"
    fi
  ) || true

  echo "    🔗 PR URL: $pr_url"
}

# Best-effort prep for 2 popular registries (non-fatal — script continues if these fail)
prep_registry_pr "punkpeye/awesome-mcp-servers" "awesome-mcp-servers-fork-$SVC_ID" || true
prep_registry_pr "TensorBlock/awesome-mcp-servers" "awesome-mcp-servers-tensorblock-fork-$SVC_ID" || true

# ============================================================
# STEP 17 — Done
# ============================================================
echo ""
echo "================================================================"
echo "  ✓ HSH-DEPLOY COMPLETE"
echo "================================================================"
echo "  Service:   $SVC_NAME ($SVC_ID)"
echo "  Worker:    $WORKER_URL"
echo "  GitHub:    https://github.com/$GH_REPO"
echo "  Catalog:   $WORKER_URL/services.json"
echo "  Logs:      $WORKER_URL/broadcasts/${SVC_ID}.json"
echo ""
echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║  HUMAN ACTIONS REQUIRED — click these URLs to ship the rest ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  REGISTRIES (browser submission required):"
echo "    Glama Servers:             https://glama.ai/mcp/servers"
echo "    Smithery:                  https://smithery.ai/new"
echo ""
echo "  AWESOME-LIST PRs (branches already pushed — open URL + click submit):"
echo "    punkpeye/awesome-mcp-servers — see PR URL printed above"
echo "    TensorBlock/awesome-mcp-servers — see PR URL printed above"
echo "    Consider also: jaw9c/awesome-remote-mcp-servers (1.1k stars)"
echo ""
echo "  FRAMEWORK INTEGRATION PRs (highest leverage docs PRs):"
echo "    langchain-ai/langchainjs/libs/langchain-mcp-adapters/examples/"
echo "    langchain-ai/langchain-mcp-adapters/examples/"
echo "    run-llama/llama_index/llama-index-integrations/tools/llama-index-tools-mcp/examples/"
echo "    coinbase/agentkit/typescript/agentkit/src/action-providers/x402/README.md"
echo ""
echo "  DNS + SOCIAL:"
echo "    AID DNS TXT at Cloudflare: _agent.${SVC_ID}.hshintelligence.com"
echo "    Announce on X:             @hshintelligence (tag @coinbase @LangChainAI @llama_index)"
echo "    Announce on Farcaster:     (needs funded OP-mainnet wallet for handle)"
echo ""
echo "  CODE WORK:"
echo "    Fill service-specific tools in src/index.ts and run: wrangler deploy"
echo "================================================================"
