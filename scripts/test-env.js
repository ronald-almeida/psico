// Vercel makes production configuration available during builds. Tests must never
// inherit gateway credentials or send real Pushcut notifications.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('NEXUM_') || key.startsWith('PUSHCUT_')) delete process.env[key];
}
const localFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('External network is disabled in tests; inject a fake provider.');
  }
  return localFetch(input, options);
};
