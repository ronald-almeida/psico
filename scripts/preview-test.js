// Local QA only: no real gateway calls, no valid Pix, no production confirmation endpoint.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createStore } from '../lib/store.js';
if(process.env.NODE_ENV==='production')throw new Error('Local QA cannot run in production');
const control=resolve('../qa-status.txt');
const charges=new Map();
const gateway={assertReady(){},async createCharge({amountCents,reference}){
  const id=`nexum_test_${randomUUID()}`;charges.set(id,{id,reference,amountCents});
  return {id,amountCents,code:'TESTE LOCAL SEM VALOR. ESTE NAO E UM CODIGO PIX. NAO PAGAR.',expiresAt:new Date(Date.now()+900000).toISOString()};
},async getCharge(id){let status='pending';try{status=readFileSync(control,'utf8').trim();}catch{}return {...charges.get(id),status};}};
const {server}=createApp({gateway,store:createStore(':memory:'),origin:'http://127.0.0.1:3001'});
server.listen(3001,'127.0.0.1',()=>console.log('SIMULAÇÃO LOCAL: http://127.0.0.1:3001 — sem transações reais.'));

