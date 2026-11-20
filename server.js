import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { products, orderItems, accessLink } from './lib/catalog.js';
import { validateCustomer } from './lib/validation.js';
import { createStore } from './lib/store.js';
import { NexumGateway } from './lib/nexum.js';
import { NexumWebhooks, parsePixEvent } from './lib/webhook.js';
import { PixNotifications } from './lib/notifications.js';
import { reportCheckoutError } from './lib/diagnostics.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });
const types = { ".webp":"image/webp", ".ttf":"font/ttf", '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw error(415,'Formato de solicitação inválido.');
  // Vercel may parse JSON before invoking this handler.
  if (req.body !== undefined) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > 8192) throw error(413,'Solicitação muito grande.');
    try { return JSON.parse(body); } catch { throw error(400,'Solicitação inválida.'); }
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw error(413,'Solicitação muito grande.');
  }
  try { return JSON.parse(body); } catch { throw error(400,'Solicitação inválida.'); }
}

export function createApp({ gateway = new NexumGateway(), store = createStore(process.env.DATABASE_PATH || './data/orders.sqlite'),
  origin = process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:3000', webhooks = new NexumWebhooks({ origin }), notifications = new PixNotifications() } = {}) {
  const secure = new URL(origin).protocol === 'https:';
  const inflight = new Map();
  async function notifyWithoutBlockingCheckout(order) {
    try { await notifications.deliver(store,order.id,order.status,order.owner); }
    catch { console.warn('Pix notification delivery pending; retry on webhook or next order check.'); }
  }
  function json(res, status, payload) {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(payload));
  }
  function session(req, res) {
    const token = req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('checkout_session='))?.split('=')[1];
    if (/^[a-f0-9]{64}$/.test(token || '')) return hash(token);
    const next = randomBytes(32).toString('hex');
    res.setHeader('Set-Cookie',`checkout_session=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
    return hash(next);
  }
  async function publicOrder(o) {
    const result = { id:o.id, amount:o.amount, items:JSON.parse(o.items), status:o.status, expiresAt:o.expires_at };
    if (o.status === 'pending' && o.code) {
      result.code=o.code;
      result.qrImage=await QRCode.toDataURL(o.code, { width:280, margin:2, errorCorrectionLevel:'M' });
    }
    if (o.status === 'paid') result.accessUrl=accessLink(result.items[0].id);
    return result;
  }
  async function refresh(o) {
    if (!['pending','expired','paid'].includes(o.status) || !o.gateway_id) return o;
    if (inflight.has(o.id)) return inflight.get(o.id);
    const task = (async () => {
      if (!await store.claimCheck(o.id,o.owner)) return store.get(o.id,o.owner);
      let charge;
      try { charge = await gateway.getCharge(o.gateway_id); }
      catch(e) { if(e.retryAfter>30) await store.deferCheck(o.id,o.owner,e.retryAfter); throw e; }
      if (charge.id !== o.gateway_id || charge.amountCents !== o.amount ||
          !['pending','paid','expired','cancelled','refunded','failed'].includes(charge.status) ||
          (o.status === 'paid' && !['paid','refunded'].includes(charge.status))) {
        throw error(502,'Não foi possível verificar o pagamento. Tente novamente em instantes.');
      }
      await store.status(o.id, charge.status, o.owner);
      return store.get(o.id, o.owner);
    })();
    inflight.set(o.id,task);
    try { return await task; } finally { inflight.delete(o.id); }
  }
  const handler = async (req,res) => {
    let stage='request';
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/webhooks/nexum') {
        stage='webhook.receive';
        if (req.method !== 'POST') throw error(405, 'Método não permitido.');
        const { id, owner } = webhooks.authenticate(req.headers['x-webhook-token']);
        const event = parsePixEvent(await readJson(req), id);
        await store.webhook(id, event, owner);
        await notifications.deliver(store,id,event.status,owner);
        return json(res, 200, { received: true });
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) throw error(403,'Origem não permitida.');
        const owner = session(req,res);
        if (req.method === 'GET' && url.pathname === '/api/catalog') return json(res,200,{products,checkoutAvailable:gateway.isConfigured?.()??true});
        if (req.method === 'POST' && url.pathname === '/api/orders') {
          if (req.headers.origin !== origin) throw error(403,'Origem não permitida.');
          const input = await readJson(req);
          if (!input || typeof input !== 'object') throw error(400,'Solicitação inválida.');
          if (!/^[a-f0-9-]{36}$/i.test(input.requestKey || '')) throw error(400,'Identificador de pedido inválido.');
          let customer, items;
          try { customer=validateCustomer(input.customer); items=orderItems(input.productId); } catch(e) { throw error(400,e.message); }
          const amount = items.reduce((total,item)=>total+item.price,0);
          const fingerprint = hash(JSON.stringify({customer,items}));
          async function existingOrder(order) {
            if (order.fingerprint === fingerprint) return json(res,200,await publicOrder(order));
            return json(res,409,{resetRequest:true});
          }
          // Deduplicate only retries of this attempt, never the customer's CPF or prior orders.
          stage='order.lookup';
          const existing = await store.find(owner,input.requestKey);
          if (existing) return await existingOrder(existing);
          gateway.assertReady();
          const id=randomUUID();
          stage='webhook.configure';
          const webhook=webhooks.configuration(id,owner);
          stage='order.reserve';
          const reserved=await store.insert({id,owner,key:input.requestKey,fingerprint,amount,items,notify:notifications.isConfigured()});
          if (!reserved.created) return await existingOrder(reserved.order);
          try {
            stage='pix.create';
            const charge=await gateway.createCharge({reference:id,amountCents:amount,customer,items,webhook});
            if (!charge || typeof charge.id!=='string' || charge.id.length>200 ||
                (charge.code!==null && (typeof charge.code!=='string' || charge.code.length<20 || charge.code.length>4096)) || charge.amountCents!==amount ||
                (charge.expiresAt && (!Number.isFinite(Date.parse(charge.expiresAt)) || Date.parse(charge.expiresAt)<=Date.now()))) throw new Error('Invalid gateway response');
            stage='order.save_pix';
            await store.charge(id,charge,owner);
          } catch (e) {
            reportCheckoutError(stage,e);
            stage='order.save_failure';
            if(e.uncertain === false){await store.status(id,'failed',owner);return json(res,502,{message:e.message,resetRequest:true});}
            // Never retry blindly: the provider may have created the charge before timing out.
            await store.status(id,'creation_unknown',owner);
            return json(res,202,await publicOrder(await store.get(id,owner)));
          }
          stage='order.read_created';
          const created=await store.get(id,owner);
          await notifyWithoutBlockingCheckout(created);
          return json(res,201,await publicOrder(created));
        }
        const match=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})$/);
        if (req.method==='GET' && match) {
          stage='order.rate_limit';
          if (!await store.allow(`status:${owner}`,120,60000)) throw error(429,'Aguarde alguns instantes para consultar novamente.');
          stage='order.read';
          const o=await store.get(match[1],owner);
          if (!o || o.owner!==owner) throw error(404,'Pedido não encontrado neste navegador.');
          stage='pix.refresh';
          const updated=await refresh(o);
          await notifyWithoutBlockingCheckout(updated);
          return json(res,200,await publicOrder(updated));
        }
        throw error(404,'Página não encontrada.');
      }
      if (!['GET','HEAD'].includes(req.method)) throw error(405,'Método não permitido.');
      const pages={'/':'index.html','/black-friday':'index.html','/checkout':'checkout.html','/pagamento':'payment.html','/obrigado':'thanks.html'};
      const pathname=decodeURIComponent(url.pathname);
      const relative=pages[pathname] || pathname.replace(/^\/+/, '');
      const file=resolve(root,relative);
      if (!file.startsWith(root) || relative.includes('..')) throw error(404,'Página não encontrada.');
      let content;
      try { content=await readFile(file); } catch { throw error(404,'Página não encontrada.'); }
      res.writeHead(200,{'Content-Type':types[extname(file)] || 'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});
      res.end(req.method==='HEAD'?undefined:content);
    } catch(e) {
      if (!e.status || e.status>=500) reportCheckoutError(stage,e);
      if (res.headersSent) return res.end();
      json(res,e.status || 502,{message:e.status ? e.message : 'Não foi possível consultar o pagamento. Tente novamente em instantes.'});
    }
  };
  const server = createServer(handler);
  server.requestTimeout=30000;
  return {server,store,handler};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {server,store}=createApp();
  const host=process.env.HOST || '127.0.0.1';
  const port=Number(process.env.PORT || 3000);
  server.listen(port,host,()=>console.log(`Checkout local: http://${host}:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
}
