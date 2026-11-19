import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  return {
    db,
    get(id) { return db.prepare('SELECT * FROM orders WHERE id = ?').get(id); },
    find(owner, key) { return db.prepare('SELECT * FROM orders WHERE owner = ? AND request_key = ?').get(owner, key); },
    insert(o) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = this.find(o.owner, o.key);
        if (existing) { db.exec('COMMIT'); return { created: false, order: existing }; }
        db.prepare('INSERT INTO orders (id,owner,request_key,fingerprint,amount,items,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(o.id, o.owner, o.key, o.fingerprint, o.amount, JSON.stringify(o.items), 'creating', Date.now());
        db.exec('COMMIT');
        return { created: true, order: this.get(o.id) };
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    charge(id, c) { db.prepare("UPDATE orders SET status='pending',gateway_id=?,code=?,expires_at=? WHERE id=?").run(c.id,c.code,c.expiresAt,id); },
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
    claimCheck(id) {
      return db.prepare('UPDATE orders SET checked_at=? WHERE id=? AND checked_at<=?').run(Date.now(),id,Date.now()-30000).changes===1;
    },
    deferCheck(id,owner,seconds) { db.prepare('UPDATE orders SET checked_at=? WHERE id=?').run(Date.now()+Math.max(0,seconds-30)*1000,id); },
    close() { db.close(); },
  };
}
