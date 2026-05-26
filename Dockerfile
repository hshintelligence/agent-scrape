# AgentScrape MCP server — Glama-compatible Dockerfile
# Runs the Cloudflare Worker locally via wrangler dev for introspection.

FROM node:20-bookworm-slim

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source
COPY . .

# Wrangler dev runs the worker locally on port 8787
# MCP endpoint will be available at http://localhost:8787/mcp
EXPOSE 8787

# Required secrets must be provided at runtime via -e flags or env file:
#   -e GROQ_API_KEY=...
#   -e CDP_API_KEY_ID=...
#   -e CDP_API_KEY_SECRET=...
ENV NODE_ENV=production

CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--remote"]
