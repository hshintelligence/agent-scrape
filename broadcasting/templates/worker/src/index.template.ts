// {{SVC_NAME}} — HSH Intelligence agent-native service
// Auto-generated from HSH lighthouse template
import { Hono } from "hono";

const VERSION = "0.1.0";
const SVC_ID = "{{SVC_ID}}";
const SVC_NAME = "{{SVC_NAME}}";
const PAY_TO = "0x3F3337295fea3613A5f128a8E834A0dca30f9E9a";
const NETWORK = "eip155:8453";
const FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

const app = new Hono();

app.get("/", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  c.header("Link", `<${baseUrl}/schema.json>; rel="describedby"; type="application/ld+json", <${baseUrl}/.well-known/agent.json>; rel="alternate"; type="application/json", <${baseUrl}/.well-known/x402.json>; rel="payment"; type="application/json", <${baseUrl}/services.json>; rel="related"; type="application/json"`);
  return c.json({ service: SVC_NAME, version: VERSION, org: "HSH Intelligence", payTo: PAY_TO, network: NETWORK, facilitator: FACILITATOR_URL });
});

app.get("/.well-known/agent.json", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({ name: SVC_NAME, description: "{{SVC_DESCRIPTION}}", url: baseUrl, provider: { name: "HSH Intelligence", url: "https://github.com/hshintelligence" }, version: VERSION, skills: [], securitySchemes: { x402: { type: "x402", network: NETWORK, asset: "USDC" } } });
});

app.get("/schema.json", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({ "@context": "https://schema.org", "@type": "Service", "name": SVC_NAME, "description": "{{SVC_DESCRIPTION}}", "url": baseUrl, "provider": { "@type": "Organization", "name": "HSH Intelligence", "url": "https://github.com/hshintelligence" }, "license": "https://spdx.org/licenses/MIT", "serviceType": "{{SVC_CATEGORY}}" });
});

app.get("/.well-known/ai-plugin.json", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({ schema_version: "v1", name_for_human: SVC_NAME, name_for_model: SVC_ID.replace(/-/g, "_"), description_for_human: "{{SVC_DESCRIPTION}}", description_for_model: "{{SVC_DESCRIPTION}}", auth: { type: "none" }, api: { type: "openapi", url: `${baseUrl}/openapi.json` }, contact_email: "contact@healingsunhaven.com" });
});

app.get("/.well-known/security.txt", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.text(`Contact: mailto:contact@healingsunhaven.com\nExpires: 2027-12-31T23:59:59.000Z\nPreferred-Languages: en\nCanonical: ${baseUrl}/.well-known/security.txt\n`, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

app.get("/humans.txt", (c) => c.text(`/* TEAM */\n  Org: HSH Intelligence\n  Contact: contact@healingsunhaven.com\n  GitHub: https://github.com/hshintelligence\n\n/* SITE */\n  Service: ${SVC_NAME}\n  License: MIT\n`, 200, { "Content-Type": "text/plain; charset=utf-8" }));

app.get("/.well-known/x402.json", (c) => c.json({ x402Version: 2, service: SVC_NAME, description: "{{SVC_DESCRIPTION}}", payTo: PAY_TO, network: NETWORK, facilitator: FACILITATOR_URL, routes: [] }));
app.get("/.well-known/x402", (c) => c.redirect("/.well-known/x402.json"));

app.get("/services.json", async (c) => {
  try {
    const upstream = await fetch("https://broadcasting.hshintelligence.com/services", { cf: { cacheTtl: 60, cacheEverything: true } });
    const data = await upstream.json();
    return c.json({ org: "HSH Intelligence", broadcasting_tower: "https://broadcasting.hshintelligence.com", fetched_at: new Date().toISOString(), count: Array.isArray(data) ? data.length : 0, services: data }, 200, { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
  } catch { return c.json({ error: "upstream_unavailable", org: "HSH Intelligence" }, 200); }
});

app.get("/broadcasts.json", async (c) => {
  try {
    const upstream = await fetch("https://broadcasting.hshintelligence.com/broadcasts", { cf: { cacheTtl: 30, cacheEverything: true } });
    return c.json(await upstream.json(), 200, { "Cache-Control": "public, max-age=30", "Access-Control-Allow-Origin": "*" });
  } catch { return c.json({ error: "upstream_unavailable" }, 200); }
});

app.get("/llms.txt", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.text(`# ${SVC_NAME}\n\n> {{SVC_DESCRIPTION}}\n\n## Endpoints\n- ${baseUrl}/mcp - MCP Streamable HTTP\n- ${baseUrl}/.well-known/agent.json - A2A Agent Card\n- ${baseUrl}/.well-known/x402.json - x402 manifest\n- ${baseUrl}/openapi.json - OpenAPI 3.1\n\n## Payment\nPay-per-call USDC on Base via x402 v2.\n`, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

app.get("/openapi.json", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({ openapi: "3.1.0", info: { title: SVC_NAME, version: VERSION, description: "{{SVC_DESCRIPTION}}" }, servers: [{ url: baseUrl }], paths: {} });
});

app.notFound((c) => c.json({ error: "not_found", service: SVC_NAME }, 404));

export default app;
