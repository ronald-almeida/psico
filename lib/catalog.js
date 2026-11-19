export const products = Object.freeze([
  Object.freeze({ id: 'clube-luma', name: 'Combo Total — Clube + Luma', price: 59970, image: '/assets/clube-luma.webp', description: 'Clube Pp de Formação de Prática Clínica + Supervisora Digital LUMA + Consultório dos Sonhos + 3 bônus' }),
  Object.freeze({ id: 'luma-pro', name: 'Supervisora Digital Luma Pro', price: 24700, image: '/assets/luma-pro.webp', description: 'Supervisora digital para avaliação, intervenção e protocolos.' }),
]);
export function orderItems(id) {
  const product = products.find(item => item.id === id);
  if (!product) throw new Error('Selecione uma oferta disponível.');
  return [product];
}
export function accessLink(productId) {
  const value = productId === 'clube-luma' ? process.env.CLUBE_LUMA_ACCESS_URL : process.env.LUMA_PRO_ACCESS_URL;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
