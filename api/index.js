import { createApp } from '../server.js';
import { BlobStore } from '../lib/blob-store.js';
import { NexumGateway } from '../lib/nexum.js';
import { authorizedProbe, probeStorage } from '../lib/storage-probe.js';

const origin = process.env.VERCEL_ENV==='preview' ? `https://${process.env.VERCEL_URL}` : process.env.PUBLIC_ORIGIN || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
const app = createApp({
  origin,
  gateway: new NexumGateway(),
  store: new BlobStore(),
});

export default async function handler(req,res) {
  if(authorizedProbe(req)) {
    try { const result=await probeStorage();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result)); }
    catch(e) { res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({errorType:e.constructor.name})); }
    return;
  }
  return app.handler(req,res);
}
