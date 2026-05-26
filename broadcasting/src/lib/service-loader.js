// service-loader.js — reads services/*.json so workers iterate over all HSH services
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(__dirname, '..', '..', 'services');

export async function loadServices() {
  const files = await readdir(SERVICES_DIR);
  const services = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await readFile(join(SERVICES_DIR, file), 'utf8');
    const svc = JSON.parse(raw);
    if (svc.status === 'live') services.push(svc);
  }
  return services;
}

export async function getService(id) {
  const services = await loadServices();
  return services.find(s => s.id === id);
}
