const BASE_URL = 'https://api.nexumpaybot.com';
const STATUSES = Object.fromEntries([
  ...['PENDING','PENDENTE','PROCESSING','WAITING','INITIATED','CREATED','RESERVED','UNKNOWN'].map(s=>[s,'pending']),
  ...['PAID','APPROVED','COMPLETED','SUCCESS','CONFIRMED','COMPLETO'].map(s=>[s,'paid']),
  ...['FAILED','FAIL','ERROR','REJECTED'].map(s=>[s,'failed']),
  ['REFUNDED','refunded'], ['CANCELLED','cancelled'], ['CANCELED','cancelled'], ['EXPIRED','expired'],
]);
export const amountInCents = amount => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
};
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id);
const validCode = code => typeof code === 'string' && code.startsWith('000201') && code.length >= 20 && code.length <= 4096;
export class GatewayError extends Error {
  constructor(uncertain = false, retryAfter = 30, upstreamStatus) {
    super('Não foi possível consultar o Pix agora. Tente novamente em instantes.');
    this.status = 502; this.uncertain = uncertain; this.retryAfter = retryAfter;
    this.upstreamStatus = upstreamStatus;
  }
}
/** Official contract: https://app.nexumpaybot.com/api/index.html (19 Nov 2026). */
export class NexumGateway {
  constructor({chatId=process.env.NEXUM_CHAT_ID, credential=process.env.NEXUM_API_CREDENTIAL, fetcher=fetch}={}) {
    Object.assign(this,{chatId,credential,fetcher});
  }
  isConfigured() { return Boolean(this.chatId?.trim() && this.credential?.trim()); }
  assertReady() {
    if (!this.isConfigured()) throw Object.assign(new Error('O pagamento está temporariamente indisponível. Tente novamente mais tarde.'),{status:503});
  }
  async request(path, options={}) {
    this.assertReady();
    const creating=options.method==='POST';
    try {
      const response=await this.fetcher(`${BASE_URL}${path}`,{
        ...options, headers:{Accept:'application/json','Content-Type':'application/json',Origin:'https://nexumpaybot.com',
          'X-API-Chat-Id':this.chatId.trim(),'X-API-Credential':this.credential.trim(),...options.headers},
        redirect:'error',signal:AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const retry=response.headers.get('retry-after');
        const seconds=retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry)-Date.now())/1000) : 30;
        throw new GatewayError(creating && (response.status>=500 || response.status===408),Number.isFinite(seconds)?Math.max(30,seconds):30,response.status);
      }
      const body=await response.json();
      if (!body || body.ok!==true) throw new GatewayError(creating);
      return body;
    } catch(e) { if(e instanceof GatewayError)throw e;throw new GatewayError(creating); }
  }
  async createCharge({reference,amountCents,customer,webhook}) {
    const charge=await this.request('/api/public/pix/create',{
      method:'POST',headers:{'Idempotency-Key':reference},body:JSON.stringify({amount:amountCents/100,
        generatedName:customer.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z ]/g,' ').replace(/\s+/g,' ').trim(),
        generatedEmail:customer.email,generatedDocument:customer.document,externalReference:reference,...(webhook?{webhook}:{})}),
    });
    const processing=charge.status==='PROCESSING' && charge.reconciliation_required===true;
    if (!validId(charge.tx_id) || amountInCents(charge.amount)!==amountCents ||
        (!processing && !validCode(charge.qr_code_text)) || !Object.hasOwn(STATUSES,charge.status)) throw new GatewayError(true);
    const seconds=charge.expires_in_seconds;
    return {id:charge.tx_id,amountCents,code:validCode(charge.qr_code_text)?charge.qr_code_text:null,
      expiresAt:Number.isSafeInteger(seconds)&&seconds>0?new Date(Date.now()+seconds*1000).toISOString():null};
  }
  async getCharge(id) {
    if (!validId(id)) throw new GatewayError();
    const charge=await this.request(`/api/public/pix/status/${encodeURIComponent(id)}`);
    if (charge.tx_id!==id || amountInCents(charge.amount)===null || !Object.hasOwn(STATUSES,charge.status)) throw new GatewayError();
    return {id:charge.tx_id,amountCents:amountInCents(charge.amount),status:STATUSES[charge.status]};
  }
}
