// ipfs-refresh.js — re-pins each service's x402 manifest to IPFS every 6 hours
// keeps Pinata replication fresh + content-addressed identity stable
import { logger } from '../lib/logger.js';

export async function refreshIpfsPins(services) {
  const log = logger.child({ worker: 'ipfs-refresh' });
  const jwt = process.env.PINATA_JWT;
  if (!jwt) { log.warn('PINATA_JWT not set, skipping IPFS refresh'); return; }

  for (const svc of services) {
    if (!svc.endpoints?.x402_manifest) continue;
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
      if (result.IpfsHash) log.info({ svc: svc.id, cid: result.IpfsHash, size: result.PinSize }, 'IPFS pin refreshed');
      else log.error({ svc: svc.id, result }, 'IPFS pin failed');
    } catch (err) {
      log.error({ svc: svc.id, err: err.message }, 'IPFS refresh error');
    }
  }
}
