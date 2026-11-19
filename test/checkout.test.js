import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.js';
import {createStore} from '../lib/store.js';
import {NexumGateway,GatewayError,amountInCents} from '../lib/nexum.js';
const customer={name:'João da Silva',email:'teste@example.com',document:'52998224725'};
const code='000201-TESTE-LOCAL-SEM-VALOR-NAO-PAGAR';
const input=(productId='clube-luma')=>({requestKey:randomUUID(),productId,customer,amount:1});
async function setup(t,options={}){
 const charges=new Map();let calls=0,polls=0;
 const gateway={assertReady(){},async createCharge(o){calls++;const id=randomUUID();charges.set(id,{...o,id,status:'pending'});return {id,amountCents:o.amountCents,code,expiresAt:null};},async getCharge(id){polls++;return charges.get(id);}};
 const store=createStore(':memory:');
 const {server}=createApp({gateway,store,origin:'http://shop.test',...options});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(()=>{store.close();r();})));
 const base=`http://127.0.0.1:${server.address().port}`,cookie=`checkout_session=${'a'.repeat(64)}`;
 const request=async(path,body,overrides={})=>{const res=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:'http://shop.test',cookie,'content-type':'application/json',...overrides},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json()};};
 return {request,store,charges,calls:()=>calls,polls:()=>polls};
}
test('both product prices are calculated on the server, ignoring client amount',async t=>{
 const app=await setup(t);
 for(const [id,price] of [['clube-luma',59970],['luma-pro',24700]]){const r=await app.request('/api/orders',input(id));assert.equal(r.status,201);assert.equal(r.body.amount,price);assert.equal(r.body.items[0].id,id);assert.match(r.body.qrImage,/^data:image\/png;base64,/);assert.equal(r.body.accessUrl,undefined);}
});
test('unknown product, invalid CPF, CNPJ and invalid email never call gateway',async t=>{
 const app=await setup(t);
 for(const body of [input('unknown'),input(null),{...input(),customer:{...customer,document:'11111111111'}},{...input(),customer:{...customer,document:'11222333000181'}},{...input(),customer:{...customer,email:'invalid'}}])assert.equal((await app.request('/api/orders',body)).status,400);
 assert.equal(app.calls(),0);
});
test('concurrent retry creates one charge and a changed product conflicts',async t=>{
 const app=await setup(t),body=input();const r=await Promise.all([app.request('/api/orders',body),app.request('/api/orders',body)]);
 assert.equal(app.calls(),1);assert.equal(r[0].body.id,r[1].body.id);assert.equal((await app.request('/api/orders',{...body,productId:'luma-pro'})).status,409);
});
test('independent orders for the same customer retain separate products and totals',async t=>{
 const app=await setup(t);const a=await app.request('/api/orders',input()),b=await app.request('/api/orders',input('luma-pro'));
 assert.notEqual(a.body.id,b.body.id);assert.equal(a.body.amount,59970);assert.equal(b.body.amount,24700);assert.equal(app.calls(),2);
});
test('ownership and origin are checked before exposing or creating a charge',async t=>{
 const app=await setup(t),r=await app.request('/api/orders',input());assert.equal((await app.request(`/api/orders/${r.body.id}`,null,{cookie:''})).status,404);
 assert.equal((await app.request('/api/orders',input(),{origin:'https://elsewhere.test'})).status,403);assert.equal((await app.request('/api/orders',input(),{origin:''})).status,403);
});
test('payment confirmation requires matching transaction and gross amount',async t=>{
 const app=await setup(t),r=await app.request('/api/orders',input()),charge=[...app.charges.values()][0];charge.status='paid';charge.amountCents=1;
 assert.equal((await app.request(`/api/orders/${r.body.id}`)).status,502);assert.equal(app.store.get(r.body.id).status,'pending');
 app.store.db.prepare('UPDATE orders SET checked_at=0 WHERE id=?').run(r.body.id);charge.amountCents=59970;charge.id='wrong';assert.equal((await app.request(`/api/orders/${r.body.id}`)).status,502);
 app.store.db.prepare('UPDATE orders SET checked_at=0 WHERE id=?').run(r.body.id);charge.id=app.store.get(r.body.id).gateway_id;
 const paid=await app.request(`/api/orders/${r.body.id}`);assert.equal(paid.body.status,'paid');assert.equal(paid.body.code,undefined);
});
test('polling is limited to one upstream request every thirty seconds',async t=>{
 const app=await setup(t),r=await app.request('/api/orders',input());await app.request(`/api/orders/${r.body.id}`);await app.request(`/api/orders/${r.body.id}`);assert.equal(app.polls(),1);
});
test('paid orders can be refunded and no longer expose an access link',async t=>{
 const app=await setup(t),r=await app.request('/api/orders',input()),charge=[...app.charges.values()][0];charge.status='paid';await app.request(`/api/orders/${r.body.id}`);
 app.store.db.prepare('UPDATE orders SET checked_at=0 WHERE id=?').run(r.body.id);charge.status='refunded';const refund=await app.request(`/api/orders/${r.body.id}`);assert.equal(refund.body.status,'refunded');assert.equal(refund.body.accessUrl,undefined);
});
test('timeout records uncertainty and does not repeat a charge on retry',async t=>{
 let calls=0;const app=await setup(t,{gateway:{assertReady(){},async createCharge(){calls++;throw new GatewayError(true);}}});const body=input();const r=await app.request('/api/orders',body);assert.equal(r.status,202);assert.equal(r.body.status,'creation_unknown');await app.request('/api/orders',body);assert.equal(calls,1);
});
test('unconfigured gateway is visible as unavailable and cannot create a payment',async t=>{
 const app=await setup(t,{gateway:new NexumGateway({chatId:'',credential:''})});assert.equal((await app.request('/api/catalog')).body.checkoutAvailable,false);assert.equal((await app.request('/api/orders',input())).status,503);
});
test('Nexum request matches official auth, route, reais, normalized name and idempotency',async()=>{
 let sent;const g=new NexumGateway({chatId:'123',credential:'test',fetcher:async(url,options)=>{sent={url,...options};return Response.json({ok:true,tx_id:'tx_test',amount:599.7,status:'PENDING',qr_code_text:code,expires_in_seconds:86400});}});
 const webhook={url:'https://shop.test/api/webhooks/nexum',token:'test-only'};
 const c=await g.createCharge({reference:'order123',amountCents:59970,customer,webhook});const b=JSON.parse(sent.body);assert.equal(sent.url,'https://api.nexumpaybot.com/api/public/pix/create');assert.equal(b.amount,599.7);assert.equal(b.generatedName,'Joao da Silva');assert.equal(b.generatedDocument,customer.document);assert.equal(b.externalReference,'order123');assert.deepEqual(b.webhook,webhook);assert.equal(sent.headers['Idempotency-Key'],'order123');assert.equal(sent.headers['X-API-Credential'],'test');assert.equal(sent.headers.Origin,'https://nexumpaybot.com');assert.equal(c.id,'tx_test');assert.ok(Date.parse(c.expiresAt)>Date.now());
});
test('Nexum status verifies amount, transaction ID and documented aliases',async()=>{
 let status='PAID',tx='tx_test';const g=new NexumGateway({chatId:'123',credential:'test',fetcher:async url=>{assert.equal(url,'https://api.nexumpaybot.com/api/public/pix/status/tx_test');return Response.json({ok:true,tx_id:tx,amount:247,status});}});
 for(status of ['PAID','APPROVED','COMPLETED','SUCCESS','CONFIRMED','COMPLETO'])assert.equal((await g.getCharge('tx_test')).status,'paid');status='REFUNDED';assert.equal((await g.getCharge('tx_test')).status,'refunded');tx='other';await assert.rejects(()=>g.getCharge('tx_test'));
});
test('Nexum 202 PROCESSING retains transaction ID without inventing a QR code',async()=>{
 const g=new NexumGateway({chatId:'123',credential:'test',fetcher:async()=>Response.json({ok:true,tx_id:'tx_pending',amount:247,status:'PROCESSING',reconciliation_required:true},{status:202})});const c=await g.createCharge({reference:'ref',amountCents:24700,customer});assert.equal(c.code,null);assert.equal(c.id,'tx_pending');
});
test('Nexum handles 429 Retry-After, definitive errors and uncertain responses',async()=>{
 const request=fetcher=>new NexumGateway({chatId:'1',credential:'test',fetcher}).request('/api/public/pix/create',{method:'POST'});
 await assert.rejects(()=>request(async()=>new Response('',{status:429,headers:{'Retry-After':'90'}})),e=>!e.uncertain&&e.retryAfter===90);
 await assert.rejects(()=>request(async()=>new Response('',{status:401})),e=>!e.uncertain);
 await assert.rejects(()=>request(async()=>{throw new Error('timeout');}),e=>e.uncertain);
 await assert.rejects(()=>request(async()=>new Response('invalid')),e=>e.uncertain);
});
test('currency values must be numeric with at most two decimal places',()=>{assert.equal(amountInCents(599.7),59970);assert.equal(amountInCents(247),24700);assert.equal(amountInCents('247'),null);assert.equal(amountInCents(247.001),null);});
