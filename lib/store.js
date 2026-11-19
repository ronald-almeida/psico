import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyPixEvent } from './webhook.js';
import { claimDelivery, finishDelivery } from './notifications.js';

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, amount INTEGER NOT NULL, items TEXT NOT NULL,
      status TEXT NOT NULL, gateway_id TEXT, code TEXT, expires_at TEXT,
      checked_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(owner, request_key)
    );
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'notifications')) db.exec('ALTER TABLE orders ADD COLUMN notifications TEXT');
  function notificationChange(id, owner, change) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row=db.prepare('SELECT * FROM orders WHERE id=? AND owner=?').get(id,owner);
      if (!row) throw new Error('Missing reserved order');
      row.notifications=row.notifications?JSON.parse(row.notifications):null;
      const result=change(row);
      if (result==='claimed' || result===true) db.prepare('UPDATE orders SET notifications=? WHERE id=?').run(JSON.stringify(row.notifications),id);
      db.exec('COMMIT');return result;
    } catch(e) { db.exec('ROLLBACK');throw e; }
  }
  return {
    db,
    get(id) { return db.prepare('SELECT * FROM orders WHERE id = ?').get(id); },
    find(owner, key) { return db.prepare('SELECT * FROM orders WHERE owner = ? AND request_key = ?').get(owner, key); },
    insert(o) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = this.find(o.owner, o.key);
        if (existing) { db.exec('COMMIT'); return { created: false, order: existing }; }
        db.prepare('INSERT INTO orders (id,owner,request_key,fingerprint,amount,items,status,created_at,notifications) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(o.id, o.owner, o.key, o.fingerprint, o.amount, JSON.stringify(o.items), 'creating', Date.now(), o.notify?'{}':null);
        db.exec('COMMIT');
        return { created: true, order: this.get(o.id) };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    charge(id, c) {
      const order=this.get(id);
      if (!order || (order.gateway_id && order.gateway_id!==c.id)) throw new Error('Charge does not match reserved order');
      db.prepare("UPDATE orders SET status=CASE WHEN status IN ('creating','creation_unknown') THEN 'pending' ELSE status END,gateway_id=?,code=?,expires_at=? WHERE id=?")
        .run(c.id,c.code,c.expiresAt,id);
    },
    webhook(id, event, owner) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const order=this.get(id);
        if (order?.owner!==owner) throw Object.assign(new Error('Pedido não encontrado.'),{status:404});
        if (applyPixEvent(order,event)) db.prepare('UPDATE orders SET gateway_id=?,status=?,checked_at=? WHERE id=?').run(order.gateway_id,order.status,order.checked_at,id);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    status(id, status) {
      db.prepare("UPDATE orders SET status=?,checked_at=? WHERE id=? AND status!='refunded' AND (status!='paid' OR ? IN ('paid','refunded')) AND (?!='creation_unknown' OR status='creating')")
        .run(status,Date.now(),id,status,status);
    },
    allow(key, max, windowMs) {
      const now = Date.now();
      db.prepare('DELETE FROM limits WHERE expires < ?').run(now);
      db.prepare('INSERT INTO limits (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+windowMs);
      return db.prepare('SELECT count FROM limits WHERE key=?').get(key).count <= max;
    },
    claimNotification(id, status, owner, claimId) { return notificationChange(id,owner,order=>claimDelivery(order,status,claimId)); },
    finishNotification(id, status, owner, claimId, delivered) { return notificationChange(id,owner,order=>finishDelivery(order,status,claimId,delivered)); },
    claimCheck(id) {
      return db.prepare('UPDATE orders SET checked_at=? WHERE id=? AND checked_at<=?').run(Date.now(),id,Date.now()-30000).changes===1;
    },
    deferCheck(id,owner,seconds) { db.prepare('UPDATE orders SET checked_at=? WHERE id=?').run(Date.now()+Math.max(0,seconds-30)*1000,id); },
    close() { db.close(); },
  };
}
