// Keep diagnostics useful without logging request bodies, cookies, API tokens,
// payment codes, customer data or private notification URLs.
export function reportCheckoutError(stage, error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
  const blobHttp = message.match(/^Vercel Blob: Failed to fetch blob: (\d{3})\b/) || message.match(/^Failed to fetch blob: (\d{3})\b/);
  const category = /No blob credentials found/.test(message) ? 'blob_credentials_missing'
    : /Invalid storage response/.test(message) ? 'blob_invalid_response'
    : /Storage busy/.test(message) ? 'blob_write_conflict'
    : /ifMatch|ETag|precondition/i.test(message) ? 'blob_conditional_write'
    : blobHttp ? 'blob_http_error' : undefined;
  console.error(JSON.stringify({ event: 'checkout_error', stage,
    errorType: /^[A-Za-z0-9_]{1,80}$/.test(error?.constructor?.name || '') ? error.constructor.name : 'Error',
    code: safeCode(error?.code) || safeCode(error?.cause?.code), category,
    upstreamStatus: error?.upstreamStatus || (blobHttp ? Number(blobHttp[1]) : undefined),
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1,5).filter(line=>/^\s+at .+:\d+:\d+\)?$/.test(line)) : [],
  }));
}
