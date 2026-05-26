import { logger } from '../lib/logger.js';
import { logBroadcast } from '../lib/broadcast-log.js';

export async function refreshIpfsPins(services) {
  const log = logger.child({ worker: 'ipfs-refresh' });
  const jwt = process.env.PINATA_JWT;
  if (!jwt) { log.warn('PINATA_JWT not set, skipping IPFS refresh'); return; }

  for (const svc of services) {
    if (!svc.endpoints?.x402_manifest) continue;
    const t0 = Date.now();
    try {
      const manifest = await fetch(svc.endpoints.x402_manifest).then(r => r.text());
      const fd = new FormData();
      fd.append('file', new Blob([manifest], { type: 'application/json' }), `${svc.id}-x402-manifest.json`);
      fd.append('pinataMetadata', JSON.stringify({
        name: `${svc.id}-x402-manifest-${new Date().toISOString().slice(0,10)}`,
        keyvalues: { service: svc.id, org: 'hsh-intelligence', type: 'x402-manifest', version: svc.version },
      }));
      const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST', headers: { 'Authorization': `Bearer ${jwt}` }, body: fd,
      });
      const result = await r.json();
      const ms = Date.now() - t0;
      const healthy = !!result.IpfsHash;
      logBroadcast({ worker: 'ipfs-refresh', svc: svc.id, cid: result.IpfsHash || null, size: result.PinSize || null, ms, healthy });
      if (healthy) log.info({ svc: svc.id, cid: result.IpfsHash, size: result.PinSize }, 'IPFS pin refreshed');
      else log.error({ svc: svc.id, result }, 'IPFS pin failed');
    } catch (err) {
      logBroadcast({ worker: 'ipfs-refresh', svc: svc.id, ms: Date.now() - t0, healthy: false, error: err.message });
      log.error({ svc: svc.id, err: err.message }, 'IPFS refresh error');
    }
  }
}
