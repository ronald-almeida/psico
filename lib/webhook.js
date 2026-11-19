import { createHmac, timingSafeEqual } from 'node:crypto';
import { amountInCents } from './nexum.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const tokenPattern = new RegExp(`^v1\\.(${uuid})\\.([a-f0-9]{64})\\.([a-f0-9]{64})$`);
const fail = (status, message) => Object.assign(new Error(message), { status });

export class NexumWebhooks {
  constructor({ origin, secret = process.env.NEXUM_WEBHOOK_SECRET } = {}) {
    this.origin = origin;
    this.secret = secret;
  }
  isConfigured() { return typeof this.secret === 'string' && this.secret.length >= 32; }
  sign(value) { return createHmac('sha256', this.secret).update(value).digest('hex'); }
  configuration(id, owner) {
    if (!this.isConfigured()) return undefined;
    const url = new URL('/api/webhooks/nexum', this.origin);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw fail(503, 'Configuração do webhook inválida.');
    // A signed token identifies the reserved order without exposing the session cookie
    // or requiring a separate non-atomic index in Blob. Only Nexum receives it.
    const payload = `v1.${id}.${owner}`;
    return { url: url.href, token: `${payload}.${this.sign(payload)}` };
  }
  authenticate(token) {
    if (!this.isConfigured()) throw fail(503, 'Webhook indisponível.');
    const match = typeof token === 'string' && token.match(tokenPattern);
    if (!match || !timingSafeEqual(Buffer.from(match[3], 'hex'), Buffer.from(this.sign(`v1.${match[1]}.${match[2]}`), 'hex'))) {
      throw fail(401, 'Webhook não autorizado.');
    }
    return { id: match[1], owner: match[2] };
  }
}

export function parsePixEvent(body, id) {
  const transaction = body?.transaction;
  if (body?.event !== 'pix.status_changed' || !['PENDING', 'PAID'].includes(body.status) ||
      typeof body.tx_id !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(body.tx_id) ||
      transaction?.id !== body.tx_id || transaction.status !== body.status ||
      transaction.external_reference !== id || amountInCents(transaction.amount) === null ||
      (body.status === 'PAID' && body.paid !== true) || (body.status === 'PENDING' && body.paid === true)) {
    throw fail(400, 'Evento Pix inválido.');
  }
  return { id: body.tx_id, amount: amountInCents(transaction.amount), status: body.status === 'PAID' ? 'paid' : 'pending' };
}

export function applyPixEvent(order, event) {
  if (!order) throw fail(404, 'Pedido não encontrado.');
  if (order.amount !== event.amount || (order.gateway_id && order.gateway_id !== event.id)) throw fail(409, 'Evento incompatível com o pedido.');
  // Duplicate/delayed notifications cannot undo a confirmed payment or refund.
  if (order.status === 'refunded' || (event.status === 'pending' && ['paid', 'expired', 'cancelled', 'failed'].includes(order.status)) ||
      (order.status === event.status && order.gateway_id === event.id)) return false;
  Object.assign(order, { gateway_id: event.id, status: event.status, checked_at: Date.now() });
  return true;
}
