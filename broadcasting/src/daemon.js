// HSH Broadcasting Tower — main daemon
// Runs 24/7 on Hetzner. Iterates services/, broadcasts each across all configured channels.
import 'dotenv/config';
import cron from 'node-cron';
import http from 'node:http';
import { logger } from './lib/logger.js';
import { loadServices } from './lib/service-loader.js';
import { broadcastWellKnown } from './broadcasters/wellknown-monitor.js';
import { refreshIpfsPins } from './broadcasters/ipfs-refresh.js';

const log = logger.child({ daemon: 'broadcasting-tower' });
const PORT = parseInt(process.env.PORT || '3000', 10);

async function bootstrap() {
  const services = await loadServices();
  log.info({ count: services.length, ids: services.map(s => s.id) }, 'HSH services loaded');
  return services;
}

// Cron — fast cadence (every 15 min): well-known endpoint health checks
cron.schedule('*/15 * * * *', async () => {
  log.info('cron: well-known monitor tick');
  const services = await loadServices();
  await broadcastWellKnown(services);
});

// Cron — medium cadence (every 6 hours): IPFS pin refresh
cron.schedule('0 */6 * * *', async () => {
  log.info('cron: IPFS pin refresh tick');
  const services = await loadServices();
  await refreshIpfsPins(services);
});

// Initial run on boot (don't wait for first cron)
bootstrap().then(async (services) => {
  await broadcastWellKnown(services);
  log.info('initial broadcast tick complete');
});

// Tiny HTTP health server on port 3000
http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const services = await loadServices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      uptime_seconds: Math.floor(process.uptime()),
      services_loaded: services.length,
      pid: process.pid,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    }, null, 2));
  } else if (req.url === '/services') {
    const services = await loadServices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(services.map(s => ({ id: s.id, name: s.name, version: s.version })), null, 2));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', endpoints: ['/health', '/services'] }));
  }
}).listen(PORT, () => log.info({ port: PORT }, 'HSH Broadcasting Tower listening'));

// Graceful shutdown
process.on('SIGTERM', () => { log.info('SIGTERM received, shutting down'); process.exit(0); });
process.on('SIGINT', () => { log.info('SIGINT received, shutting down'); process.exit(0); });
