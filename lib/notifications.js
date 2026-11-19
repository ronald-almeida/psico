import { randomUUID } from 'node:crypto';

function pushcutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.pushcut.io' && !url.port && !url.username && !url.password &&
      /^\/[^/]+\/notifications\/[^/]+$/.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export class PixNotifications {
  constructor({ pendingUrl = process.env.PUSHCUT_PIX_PENDING_URL, paidUrl = process.env.PUSHCUT_PIX_PAID_URL, fetcher = fetch } = {}) {
    this.urls = { pending: pushcutUrl(pendingUrl), paid: pushcutUrl(paidUrl) };
    this.fetcher = fetcher;
  }
  isConfigured() { return Boolean(this.urls.pending || this.urls.paid); }
  async deliver(store, id, status, owner) {
    const url = this.urls[status];
    if (!url) return;
    const claimId = randomUUID();
    const result = await store.claimNotification(id, status, owner, claimId);
    if (result === 'done') return;
    if (result === 'busy') throw Object.assign(new Error('Notificação em processamento.'), { status: 503 });
    try {
      // Preserve the notification configured by the user; send no customer data.
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `psico-${id}-${status}` }) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Notification rejected');
      await store.finishNotification(id, status, owner, claimId, true);
    } catch {
      await store.finishNotification(id, status, owner, claimId, false);
      // Never include a secret URL or the provider's response in errors/logs.
      throw Object.assign(new Error('Notificação temporariamente indisponível.'), { status: 503 });
    }
  }
}

export function claimDelivery(order, status, claimId) {
  if (!order?.notifications || order.status !== status) return 'done';
  const current = order.notifications[status];
  if (current?.sentAt) return 'done';
  if (current?.leaseUntil > Date.now()) return 'busy';
  order.notifications[status] = { claimId, leaseUntil: Date.now() + 30000, attempts: (current?.attempts || 0) + 1 };
  return 'claimed';
}

export function finishDelivery(order, status, claimId, delivered) {
  const current = order?.notifications?.[status];
  if (!current || current.claimId !== claimId || current.sentAt) return false;
  order.notifications[status] = { attempts: current.attempts, ...(delivered ? { sentAt: Date.now() } : { leaseUntil: 0 }) };
  return true;
}
