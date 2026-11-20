import { createApp } from '../server.js';
import { BlobStore } from '../lib/blob-store.js';
import { NexumGateway } from '../lib/nexum.js';

const origin = process.env.VERCEL_ENV==='preview' ? `https://${process.env.VERCEL_URL}` : process.env.PUBLIC_ORIGIN || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
const app = createApp({
  origin,
  gateway: new NexumGateway(),
  store: new BlobStore(),
});

export default app.handler;
