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
  return send(404, { error: 'not found', endpoints: ['/health', '/services', '/broadcasts'] });
}).listen(PORT, () => log.info({ port: PORT }, 'HSH Broadcasting Tower listening'));

process.on('SIGTERM', () => { log.info('SIGTERM received, shutting down'); process.exit(0); });
process.on('SIGINT',  () => { log.info('SIGINT received, shutting down'); process.exit(0); });
