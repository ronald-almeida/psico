import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { BlobStore } from '../lib/blob-store.js';
import { createApp } from '../server.js';
import { PixNotifications } from '../lib/notifications.js';

// Shared service with separate clients, uncached reads, and atomic ETag writes.
function storageService() {
  const documents = new Map();
  let revision = 0;
  return {
    documents,
    pause: async () => {},
    async reader(path, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const entry = documents.get(path);
      return entry ? { statusCode: 200, blob: { etag: entry.etag }, stream: new Response(entry.body).body } : null;
    },
    async writer(path, body, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      const entry = documents.get(path);
      if (entry && !options.allowOverwrite) throw new Error('This blob already exists');
      if (options.ifMatch && entry?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
      const etag = `revision-${++revision}`;
      documents.set(path, { body, etag });
      return { etag };
    },
  };
}
const reservation = (overrides = {}) => ({ id: randomUUID(), owner: 'session', key: randomUUID(), fingerprint: 'hash', amount: 59970, items: [], ...overrides });

test('Blob clients deduplicate only matching attempt keys and allow independent attempts', async () => {
  for (const sameKey of [true, false]) {
    const service = storageService();
    const a = new BlobStore(service), b = new BlobStore(service);
    const first = reservation(), second = reservation(sameKey ? { key: first.key } : {});
    const results = await Promise.all([a.insert(first), b.insert(second)]);
    assert.equal(results.filter(r => r.created).length, sameKey?1:2);
    if(sameKey)assert.equal(results[0].order.id, results[1].order.id);
    else assert.notEqual(results[0].order.id, results[1].order.id);
    const restarted = new BlobStore(service);
    assert.equal((await restarted.find(first.owner,first.key)).id, results[0].order.id);
    assert.equal(await restarted.get(results[0].order.id, 'another-session'), undefined);
  }
});

test('Blob conditional updates never revert paid or refunded status across clients', async () => {
  const service = storageService(), a = new BlobStore(service), b = new BlobStore(service), o = reservation();
  await a.insert(o);
  await a.charge(o.id, { id: 'nexum_test', code: 'pix', expiresAt: null }, o.owner);
  await Promise.all([a.status(o.id, 'paid', o.owner), b.status(o.id, 'pending', o.owner)]);
  assert.equal((await a.get(o.id, o.owner)).status, 'paid');
  await Promise.all([a.status(o.id, 'refunded', o.owner), b.status(o.id, 'paid', o.owner)]);
  assert.equal((await b.get(o.id, o.owner)).status, 'refunded');
});

test('Blob handles early and reordered webhooks atomically across independent functions',async()=>{
  const service=storageService(),a=new BlobStore(service),b=new BlobStore(service),o=reservation();
  await a.insert(o);
  const event={id:'early-pix',amount:o.amount,status:'paid'};
  await Promise.all([a.webhook(o.id,event,o.owner),b.webhook(o.id,{...event,status:'pending'},o.owner)]);
  await b.charge(o.id,{id:event.id,code:'test-qr',expiresAt:null},o.owner);
  assert.equal((await a.get(o.id,o.owner)).status,'paid');assert.equal((await a.get(o.id,o.owner)).code,'test-qr');
  await assert.rejects(()=>b.webhook(o.id,{...event,id:'another-transaction'},o.owner),e=>e.status===409);
  await assert.rejects(()=>b.webhook(o.id,{...event,amount:1},o.owner),e=>e.status===409);
  await assert.rejects(()=>b.webhook(o.id,event,'other-owner'),e=>e.status===404);
  await a.status(o.id,'refunded',o.owner);await b.webhook(o.id,event,o.owner);
  assert.equal((await b.get(o.id,o.owner)).status,'refunded');
});

test('Blob notification leases deduplicate across restarts and retry failed sends',async()=>{
  const service=storageService(),a=new BlobStore(service),b=new BlobStore(service),o=reservation({notify:true});
  await a.insert(o);await a.webhook(o.id,{id:'test',amount:o.amount,status:'pending'},o.owner);
  let sends=0,fail=true;
  const notifier=new PixNotifications({pendingUrl:'https://api.pushcut.io/test/notifications/test',paidUrl:'',fetcher:async()=>{sends++;return new Response('',{status:fail?503:200});}});
  await assert.rejects(()=>notifier.deliver(a,o.id,'pending',o.owner),e=>e.status===503);
  fail=false;
  await Promise.allSettled([notifier.deliver(a,o.id,'pending',o.owner),notifier.deliver(b,o.id,'pending',o.owner)]);
  await notifier.deliver(new BlobStore(service),o.id,'pending',o.owner);
  assert.equal(sends,2);assert.ok((await a.get(o.id,o.owner)).notifications.pending.sentAt);
  await a.webhook(o.id,{id:'test',amount:o.amount,status:'paid'},o.owner);
  assert.equal(await b.claimNotification(o.id,'pending',o.owner,'late'),'done');
});

test('old orders are not retroactively notified and abandoned notification leases can be retried',async()=>{
  const store=new BlobStore(storageService()),old=reservation(),fresh=reservation({notify:true});
  await store.insert(old);await store.charge(old.id,{id:'old',code:'pix',expiresAt:null},old.owner);
  assert.equal(await store.claimNotification(old.id,'pending',old.owner,'test'),'done');
  await store.insert(fresh);await store.charge(fresh.id,{id:'new',code:'pix',expiresAt:null},fresh.owner);
  assert.equal(await store.claimNotification(fresh.id,'pending',fresh.owner,'first'),'claimed');
  await store.mutate(store.path(fresh.owner),data=>{data.orders.find(o=>o.id===fresh.id).notifications.pending.leaseUntil=0;return {};});
  assert.equal(await store.claimNotification(fresh.id,'pending',fresh.owner,'second'),'claimed');
  await store.finishNotification(fresh.id,'pending',fresh.owner,'first',true);
  assert.equal((await store.get(fresh.id,fresh.owner)).notifications.pending.sentAt,undefined);
});

test('Blob retains uncertain orders while allowing new attempts', async () => {
  const service = storageService(), store = new BlobStore(service), o = reservation();
  await store.insert(o);
  await store.status(o.id, 'creation_unknown', o.owner);
  assert.equal((await new BlobStore(service).insert(reservation({key:o.key}))).created, false);
  assert.equal((await new BlobStore(service).insert(reservation({fingerprint:'changed-cart',amount:24700}))).created, true);
  assert.equal((await new BlobStore(service).insert(reservation())).created, true);
  assert.equal((await store.get(o.id,o.owner)).status,'creation_unknown');
});

test('Blob no longer caps the session at one hundred orders',async()=>{
  const store=new BlobStore(storageService());
  for(let attempt=0;attempt<101;attempt++)assert.equal((await store.insert(reservation())).created,true);
  assert.equal((await store.read(store.path('session'))).data.orders.length,101);
});

test('separate Blob clients reserve one updated cart without reusing the previous amount', async () => {
  const service=storageService(), a=new BlobStore(service), b=new BlobStore(service), original=reservation();
  await a.insert(original);
  await a.charge(original.id,{id:'old-pix',code:'original-code',expiresAt:null},original.owner);
  const next=reservation({fingerprint:'both-extras',amount:24700});
  const results=await Promise.all([a.insert(next),b.insert({...next,id:randomUUID()})]);
  assert.equal(results.filter(result=>result.created).length,1);
  assert.equal(results[0].order.id,results[1].order.id);
  assert.equal(results[0].order.amount,24700);assert.notEqual(results[0].order.id,original.id);
  assert.equal((await b.get(original.id,original.owner)).amount,59970);
});

test('Blob rate limits remain atomic under concurrent function calls', async () => {
  const service = storageService();
  const results = await Promise.all(Array.from({ length: 6 }, () => new BlobStore(service).allow('ip', 3, 60000)));
  assert.equal(results.filter(Boolean).length, 3);
});

test('storage failures fail closed before calling the payment provider', async t => {
  let calls = 0;
  const { server } = createApp({ origin: 'http://checkout.local', store: new BlobStore({ reader: async () => { throw new Error('Unavailable'); } }),
    gateway: { assertReady() {}, async createCharge() { calls++; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
    method: 'POST', headers: { origin: 'http://checkout.local', 'content-type': 'application/json' },
    body: JSON.stringify({ requestKey: randomUUID(), productId: 'clube-luma', customer: { name: 'Cliente de Teste', email: 'teste@example.com', document: '52998224725', phone: '11999999999' } }),
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 0);
});

test('two independent HTTP functions sharing Blob create only one payment', async t => {
  const service = storageService();
  let calls = 0;
  const gateway = { assertReady() {}, async createCharge({ amountCents }) {
    calls++;
    return { id: `nexum_test_${calls}`, amountCents, code: '000201-TESTE-LOCAL-SEM-VALOR-NAO-PAGAR', expiresAt: null };
  } };
  const servers = [];
  for (let i = 0; i < 2; i++) {
    const { server } = createApp({ gateway, store: new BlobStore(service), origin: 'http://checkout.local' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  const body = { requestKey: randomUUID(), productId: 'clube-luma', customer: { name: 'Cliente de Teste', email: 'teste@example.com', document: '52998224725', phone: '11999999999' } };
  const results = await Promise.all(servers.map(async server => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders`, {
      method: 'POST', headers: { origin: 'http://checkout.local', 'content-type': 'application/json', cookie: `checkout_session=${'a'.repeat(64)}` }, body: JSON.stringify(body),
    });
    assert.ok([200, 201].includes(response.status));
    return response.json();
  }));
  assert.equal(calls, 1);
  assert.equal(results[0].id, results[1].id);
  const updatedKey=randomUUID();
  const updated=await Promise.all(servers.map(async server=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/orders`,{
      method:'POST',headers:{origin:'http://checkout.local','content-type':'application/json',cookie:`checkout_session=${'a'.repeat(64)}`},
      body:JSON.stringify({...body,requestKey:updatedKey,productId:'luma-pro'}),
    });
    assert.ok([200,201].includes(response.status));return response.json();
  }));
  assert.equal(calls,2);assert.equal(updated[0].id,updated[1].id);
  assert.notEqual(updated[0].id,results[0].id);assert.equal(updated[0].amount,24700);
  const fresh=await Promise.all(servers.map(async server=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/orders`,{
      method:'POST',headers:{origin:'http://checkout.local','content-type':'application/json',cookie:`checkout_session=${'a'.repeat(64)}`},
      body:JSON.stringify({...body,requestKey:randomUUID()}),
    });
    assert.equal(response.status,201);return response.json();
  }));
  assert.equal(calls,4);assert.notEqual(fresh[0].id,fresh[1].id);
});

