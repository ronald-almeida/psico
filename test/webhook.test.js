import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createStore } from '../lib/store.js';
import { NexumWebhooks } from '../lib/webhook.js';
import { PixNotifications } from '../lib/notifications.js';
import { GatewayError } from '../lib/nexum.js';

const secret='local-test-secret-not-a-production-secret';
const customer={name:'Cliente de Teste',email:'teste@example.com',document:'52998224725'};
const pendingUrl='https://api.pushcut.io/test-only/notifications/Gerou1';
const paidUrl='https://api.pushcut.io/test-only/notifications/VENDA%20APROVADA1';
const code='000201-TESTE-LOCAL-SEM-VALOR-NAO-PAGAR';
const payload=(charge,status='PENDING')=>({event:'pix.status_changed',tx_id:charge.id,status,paid:status==='PAID',
  transaction:{id:charge.id,status,amount:charge.amountCents/100,external_reference:charge.reference}});

async function setup(t,{duringCreate,failedDeliveries=0}={}) {
  const store=createStore(':memory:'),charges=[],deliveries=[];let base,createCalls=0;
  const notifications=new PixNotifications({pendingUrl,paidUrl,fetcher:async(url,options)=>{
    deliveries.push({url,options});
    return new Response('',{status:failedDeliveries-->0?503:200});
  }});
  const hook=async(charge,status='PENDING',changes={},token=charge.webhook.token)=>{
    const response=await fetch(base+'/api/webhooks/nexum',{method:'POST',headers:{'content-type':'application/json','x-webhook-token':token,origin:'https://api.nexumpaybot.com'},body:JSON.stringify({...payload(charge,status),...changes})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const gateway={assertReady(){},async createCharge(input){
    createCalls++;const charge={...input,id:randomUUID(),status:'pending'};charges.push(charge);
    if(duringCreate)await duringCreate(charge,hook);
    return {id:charge.id,amountCents:input.amountCents,code,expiresAt:null};
  },async getCharge(id){return charges.find(c=>c.id===id);}};
  const {server}=createApp({gateway,store,origin:'https://shop.test',notifications,webhooks:new NexumWebhooks({origin:'https://shop.test',secret})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>new Promise(resolve=>server.close(()=>{store.close();resolve();})));
  const cookie=`checkout_session=${'a'.repeat(64)}`;
  const create=async(productId='clube-luma')=>{
    const response=await fetch(base+'/api/orders',{method:'POST',headers:{origin:'https://shop.test',cookie,'content-type':'application/json'},
      body:JSON.stringify({requestKey:randomUUID(),productId,customer})});
    return {status:response.status,body:await response.json()};
  };
  const read=async id=>{const response=await fetch(base+`/api/orders/${id}`,{headers:{cookie}});return response.json();};
  return {store,create,hook,read,charges,deliveries,base,createCalls:()=>createCalls,setFailures:n=>{failedDeliveries=n;}};
}

test('new Pix registers authenticated webhook and sends pending Pushcut once, with no customer data',async t=>{
  const app=await setup(t),order=await app.create(),charge=app.charges[0];
  assert.equal(order.status,201);assert.equal(charge.webhook.url,'https://shop.test/api/webhooks/nexum');
  assert.equal(JSON.stringify(order.body).includes(charge.webhook.token),false);
  assert.equal(JSON.stringify(order.body).includes('notifications'),false);
  assert.equal((await app.hook(charge)).status,200);assert.equal((await app.hook(charge)).status,200);
  assert.equal(app.deliveries.length,1);assert.equal(app.deliveries[0].url,pendingUrl);
  assert.deepEqual(JSON.parse(app.deliveries[0].options.body),{id:`psico-${order.body.id}-pending`});
  assert.equal(app.deliveries[0].options.method,'POST');assert.equal(app.deliveries[0].options.redirect,'error');
});

test('missing or forged token is rejected before changing an order or notifying',async t=>{
  const app=await setup(t),order=await app.create(),charge=app.charges[0];
  for(const token of ['',charge.webhook.token.slice(0,-1)+(charge.webhook.token.endsWith('0')?'1':'0'),charge.webhook.token.replace(order.body.id,randomUUID())]){
    assert.equal((await app.hook(charge,'PAID',{},token)).status,401);
  }
  assert.equal(app.store.get(order.body.id).status,'pending');assert.equal(app.deliveries.length,1);
});

test('valid token still requires matching reference, transaction, gross amount and paid status',async t=>{
  const app=await setup(t),order=await app.create(),charge=app.charges[0],good=payload(charge,'PAID');
  for(const changes of [
    {transaction:{...good.transaction,external_reference:randomUUID()}},
    {transaction:{...good.transaction,amount:1}},
    {tx_id:'other',transaction:{...good.transaction,id:'other'}},
    {transaction:{...good.transaction,status:'PENDING'}},
    {paid:false},{event:'withdraw.status_changed'},
  ])assert.ok([400,409].includes((await app.hook(charge,'PAID',changes)).status));
  assert.equal((await app.hook(charge,'PAID',{customer:{extra:'x'.repeat(9000)}})).status,413);
  assert.equal(app.store.get(order.body.id).status,'pending');assert.equal(app.deliveries.length,1);
});

test('paid webhook works without browser cookie, deduplicates and ignores delayed pending/refunded replay',async t=>{
  const app=await setup(t),order=await app.create(),charge=app.charges[0];
  const results=await Promise.all(Array.from({length:4},()=>app.hook(charge,'PAID')));
  assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,503].includes(r.status)));
  assert.equal(results[0].headers.has('set-cookie'),false);
  assert.equal((await app.hook(charge,'PAID')).status,200);
  assert.equal(app.store.get(order.body.id).status,'paid');assert.equal(app.deliveries.filter(d=>d.url===paidUrl).length,1);
  assert.equal((await app.read(order.body.id)).status,'paid');
  assert.equal((await app.hook(charge,'PENDING')).status,200);assert.equal(app.store.get(order.body.id).status,'paid');
  app.store.status(order.body.id,'refunded');await app.hook(charge,'PAID');
  assert.equal(app.store.get(order.body.id).status,'refunded');assert.equal(app.deliveries.length,2);
});

test('callbacks arriving before create returns preserve paid state and still attach the Pix',async t=>{
  const app=await setup(t,{duringCreate:async(charge,hook)=>{
    assert.equal((await hook(charge,'PENDING')).status,200);
    assert.equal((await hook(charge,'PAID')).status,200);
  }});
  const order=await app.create('luma-pro');assert.equal(order.body.status,'paid');assert.equal(order.body.amount,24700);
  assert.equal(app.store.get(order.body.id).code,code);assert.equal(app.deliveries.length,2);
  assert.equal(order.body.code,undefined);
});

test('notification failure preserves payment, returns retryable webhook response and retries without another charge',async t=>{
  const app=await setup(t,{failedDeliveries:1}),order=await app.create(),charge=app.charges[0];
  assert.equal(order.status,201);assert.equal((await app.hook(charge)).status,200);
  app.setFailures(1);assert.equal((await app.hook(charge,'PAID')).status,503);
  assert.equal(app.store.get(order.body.id).status,'paid');assert.equal((await app.hook(charge,'PAID')).status,200);
  assert.equal((await app.hook(charge,'PAID')).status,200);assert.equal(app.createCalls(),1);
  assert.equal(app.deliveries.filter(d=>d.url===paidUrl).length,2);
});

test('callback recovers an uncertain creation and polling also sends paid notification once',async t=>{
  const uncertain=await setup(t,{duringCreate:async()=>{throw new GatewayError(true);}}),created=await uncertain.create();
  assert.equal(created.body.status,'creation_unknown');await uncertain.hook(uncertain.charges[0],'PAID');
  assert.equal(uncertain.store.get(created.body.id).status,'paid');
  const app=await setup(t),order=await app.create();app.charges[0].status='paid';
  assert.equal((await app.read(order.body.id)).status,'paid');await app.read(order.body.id);
  assert.equal(app.deliveries.filter(d=>d.url===paidUrl).length,1);
});

test('Pushcut configuration rejects non-Pushcut, HTTP, redirect and credential URLs',()=>{
  for(const pendingUrl of ['http://api.pushcut.io/token/notifications/test','https://other.test/token/notifications/test','https://user@api.pushcut.io/token/notifications/test','https://api.pushcut.io/token/notifications/test?extra=1']){
    assert.equal(new PixNotifications({pendingUrl,paidUrl:''}).isConfigured(),false);
  }
});
