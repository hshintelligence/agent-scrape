import 'dotenv/config';
import cron from 'node-cron';
import http from 'node:http';
import { logger } from './lib/logger.js';
import { loadServices } from './lib/service-loader.js';
import { broadcastWellKnown } from './broadcasters/wellknown-monitor.js';
import { refreshIpfsPins } from './broadcasters/ipfs-refresh.js';
import { getBroadcasts, getBroadcastStats } from './lib/broadcast-log.js';

const log = logger.child({ daemon: 'broadcasting-tower' });
const PORT = parseInt(process.env.PORT || '3000', 10);

async function bootstrap() {
  const services = await loadServices();
  log.info({ count: services.length, ids: services.map(s => s.id) }, 'HSH services loaded');
  return services;
}

cron.schedule('*/15 * * * *', async () => {
  log.info('cron: well-known monitor tick');
  const services = await loadServices();
  await broadcastWellKnown(services);
});

cron.schedule('0 */6 * * *', async () => {
  log.info('cron: IPFS pin refresh tick');
  const services = await loadServices();
  await refreshIpfsPins(services);
});

bootstrap().then(async (services) => {
  await broadcastWellKnown(services);
  log.info('initial broadcast tick complete');
});

http.createServer(async (req, res) => {
  const send = (status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra });
    res.end(JSON.stringify(body, null, 2));
  };
  if (req.url === '/health') {
    const services = await loadServices();
    return send(200, {
      status: 'alive',
      uptime_seconds: Math.floor(process.uptime()),
      services_loaded: services.length,
      pid: process.pid,
      version: '0.2.0',
      timestamp: new Date().toISOString(),
    });
  }
  if (req.url === '/services') {
    const services = await loadServices();
    return send(200, services.map(s => ({ id: s.id, name: s.name, version: s.version })));
  }
  if (req.url === '/broadcasts' || req.url === '/broadcasts.json') {
    return send(200, {
      org: 'HSH Intelligence',
      tower: 'https://broadcasting.hshintelligence.com',
      stats: getBroadcastStats(),
      recent: getBroadcasts().slice(0, 50),
    }, { 'Cache-Control': 'public, max-age=30' });
  }
  // Per-service broadcast log: /broadcasts/<svc-id> or /broadcasts/<svc-id>.json
  const svcMatch = req.url.match(/^\/broadcasts\/([a-z0-9-]+)(?:\.json)?$/);
  if (svcMatch) {
    const svcId = svcMatch[1];
    const services = await loadServices();
    const svc = services.find(s => s.id === svcId);
    if (!svc) return send(404, { error: 'service_not_found', svc_id: svcId, available: services.map(s => s.id) });
    const allEvents = getBroadcasts();
    const svcEvents = allEvents.filter(e => e.svc === svcId);
    const now = Date.now();
    const stats = {
      total_events_in_buffer: svcEvents.length,
      events_last_1h:  svcEvents.filter(e => now - new Date(e.ts).getTime() < 3600000).length,
      events_last_24h: svcEvents.filter(e => now - new Date(e.ts).getTime() < 86400000).length,
      healthy_events:  svcEvents.filter(e => e.healthy === true).length,
      healthy_percent: svcEvents.length > 0 ? Math.round(svcEvents.filter(e => e.healthy === true).length / svcEvents.length * 100) : 0,
      by_worker: svcEvents.reduce((a, e) => { a[e.worker] = (a[e.worker] || 0) + 1; return a; }, {}),
      by_endpoint: svcEvents.reduce((a, e) => { if (e.endpoint) a[e.endpoint] = (a[e.endpoint] || 0) + 1; return a; }, {}),
      avg_latency_ms: svcEvents.length > 0 ? Math.round(svcEvents.reduce((a, e) => a + (e.ms || 0), 0) / svcEvents.length) : 0,
      oldest_event_ts: svcEvents[svcEvents.length - 1]?.ts || null,
      newest_event_ts: svcEvents[0]?.ts || null,
    };
    return send(200, {
      org: 'HSH Intelligence',
      service: { id: svc.id, name: svc.name, version: svc.version, status: svc.status },
      stats,
      recent: svcEvents.slice(0, 50),
    }, { 'Cache-Control': 'public, max-age=30' });
  }
  return send(404, { error: 'not found', endpoints: ['/health', '/services', '/broadcasts'] });
}).listen(PORT, () => log.info({ port: PORT }, 'HSH Broadcasting Tower listening'));

process.on('SIGTERM', () => { log.info('SIGTERM received, shutting down'); process.exit(0); });
process.on('SIGINT',  () => { log.info('SIGINT received, shutting down'); process.exit(0); });
