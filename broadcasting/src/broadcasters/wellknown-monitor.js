// wellknown-monitor.js — pings all discovery endpoints every 15 min and logs status
import { logger } from '../lib/logger.js';

// per-endpoint Accept headers; MCP Streamable HTTP requires SSE-compatible Accept
const ENDPOINT_HEADERS = {
  primary:       { Accept: 'application/json' },
  mcp:           { Accept: 'application/json, text/event-stream' },
  x402_manifest: { Accept: 'application/json' },
  a2a_card:      { Accept: 'application/json' },
  openapi:       { Accept: 'application/json' },
  llms_txt:      { Accept: 'text/plain' },
};
const ENDPOINT_KEYS = Object.keys(ENDPOINT_HEADERS);

export async function broadcastWellKnown(services) {
  const log = logger.child({ worker: 'wellknown-monitor' });
  for (const svc of services) {
    for (const key of ENDPOINT_KEYS) {
      const url = svc.endpoints[key];
      if (!url) continue;
      const t0 = Date.now();
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'HSH-Broadcasting-Tower/0.1', ...ENDPOINT_HEADERS[key] },
        });
        const ms = Date.now() - t0;
        // MCP returns 200 OR 405 (method not allowed for GET) when alive — both are healthy signals
        const healthy = r.ok || (key === 'mcp' && r.status === 405);
        if (healthy) log.info({ svc: svc.id, endpoint: key, status: r.status, ms }, 'discovery endpoint healthy');
        else log.warn({ svc: svc.id, endpoint: key, status: r.status, ms }, 'discovery endpoint returned non-2xx');
      } catch (err) {
        log.error({ svc: svc.id, endpoint: key, err: err.message }, 'discovery endpoint UNREACHABLE');
      }
    }
  }
}
