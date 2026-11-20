import test from 'node:test';
import assert from 'node:assert/strict';
import { reportCheckoutError } from '../lib/diagnostics.js';

test('checkout diagnostics identify the failing stage without exposing sensitive error data', t => {
  const output=[];
  t.mock.method(console,'error',value=>output.push(value));
  const failure=Object.assign(new Error('secret-api-token customer@example.com'),{cause:{code:'ECONNRESET'},body:{document:'private-customer-document'}});
  reportCheckoutError('order.reserve',failure);
  const record=JSON.parse(output[0]);
  assert.equal(record.stage,'order.reserve');
  assert.equal(record.code,'ECONNRESET');
  assert.equal(record.errorType,'Error');
  assert.doesNotMatch(output[0],/secret-api-token|customer@example.com|private-customer-document/);
});

test('checkout diagnostics identify Blob HTTP errors without logging the response', t => {
  const output=[];
  t.mock.method(console,'error',value=>output.push(value));
  reportCheckoutError('order.lookup',new Error('Vercel Blob: Failed to fetch blob: 403 Forbidden'));
  const record=JSON.parse(output[0]);
  assert.equal(record.category,'blob_http_error');
  assert.equal(record.upstreamStatus,403);
});
