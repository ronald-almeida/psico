import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');

/** One private document per session: reservation and idempotency share the same CAS. */
export class BlobStore {
  constructor({ reader = get, writer = put, pause = delay } = {}) {
    Object.assign(this, { reader, writer, pause });
  }
  path(owner) { return `psico/sessions/${digest(owner)}.json`; }
  async read(path) {
    const result = await this.reader(path, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(8000) });
    if (!result) return { data: {}, etag: null };
    if (result.statusCode !== 200 || !result.blob.etag) throw new Error('Invalid storage response');
    return { data: await new Response(result.stream).json(), etag: result.blob.etag };
  }
  async mutate(path, change, ttlDays) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { data, etag } = await this.read(path);
      const { result, changed = true } = change(data);
      if (!changed) return result;
      try {
        await this.writer(path, JSON.stringify(data), {
          access: 'private', addRandomSuffix: false, allowOverwrite: etag !== null,
          ...(etag ? { ifMatch: etag } : {}), ...(ttlDays ? { ttlDays } : {}),
          contentType: 'application/json', abortSignal: AbortSignal.timeout(8000),
        });
        return result;
      } catch (e) {
        const conflict = e instanceof BlobPreconditionFailedError || (etag === null && /already exists/i.test(e.message));
        if (!conflict) throw e;
        await this.pause(20 * (attempt + 1));
      }
    }
    throw new Error('Storage busy');
  }
  async get(id, owner) { return (await this.read(this.path(owner))).data.orders?.find(o => o.id === id); }
  async find(owner, key) { return (await this.read(this.path(owner))).data.orders?.find(o => o.request_key === key); }
  insert(o) {
    return this.mutate(this.path(o.owner), data => {
      data.orders ??= [];
      const existing = data.orders.find(order => order.request_key === o.key);
      if (existing) return { result: { created: false, order: existing }, changed: false };
      const order = { id: o.id, owner: o.owner, request_key: o.key, fingerprint: o.fingerprint,
        amount: o.amount, items: JSON.stringify(o.items), status: 'creating',
        gateway_id: null, code: null, expires_at: null, checked_at: 0, created_at: Date.now() };
      data.orders.push(order);
      return { result: { created: true, order } };
    });
  }
  charge(id, charge, owner) {
    return this.mutate(this.path(owner), data => {
      const order = data.orders?.find(o => o.id === id);
      if (!order) throw new Error('Missing reserved order');
      if (!['creating', 'creation_unknown'].includes(order.status)) return { changed: false };
      Object.assign(order, { status: 'pending', gateway_id: charge.id, code: charge.code, expires_at: charge.expiresAt ?? null });
      return {};
    });
  }
  status(id, status, owner) {
    return this.mutate(this.path(owner), data => {
      const order = data.orders?.find(o => o.id === id);
      if (!order) throw new Error('Missing reserved order');
      // A delayed poll from another function must not undo payment or refund.
      if (order.status === 'refunded' || (order.status === 'paid' && !['paid', 'refunded'].includes(status)) ||
          (status === 'creation_unknown' && order.status !== 'creating')) return { changed: false };
      Object.assign(order, { status, checked_at: Date.now() });
      return {};
    });
  }
  allow(key, max, windowMs) {
    return this.mutate(`psico/limits/${digest(key)}.json`, data => {
      const now = Date.now();
      if (!data.expires || data.expires <= now) Object.assign(data, { count: 0, expires: now + windowMs });
      if (data.count >= max) return { result: false, changed: false };
      data.count++;
      return { result: true };
    }, 1);
  }
  claimCheck(id,owner) {
    return this.mutate(this.path(owner),data=>{
      const order=data.orders?.find(o=>o.id===id);
      if(!order || Date.now()-order.checked_at<30000)return {result:false,changed:false};
      order.checked_at=Date.now();return {result:true};
    });
  }
  deferCheck(id,owner,seconds) {
    return this.mutate(this.path(owner),data=>{
      const order=data.orders?.find(o=>o.id===id);
      if(order)order.checked_at=Date.now()+Math.max(0,seconds-30)*1000;
      return {};
    });
  }
  close() {}
}
