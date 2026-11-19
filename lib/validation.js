const digits = value => String(value || '').replace(/\D/g, '');

export function validDocument(value) {
  const doc = digits(value);
  if (!/^\d{11}$|^\d{14}$/.test(doc) || /^(\d)\1+$/.test(doc)) return false;
  if (doc.length === 11) {
    return [9, 10].every(length => {
      const sum = [...doc.slice(0, length)].reduce((s, n, i) => s + Number(n) * (length + 1 - i), 0);
      const result = (sum * 10) % 11;
      return (result === 10 ? 0 : result) === Number(doc[length]);
    });
  }
  return [12, 13].every(length => {
    const sum = [...doc.slice(0, length)].reduce((s, n, i) => s + Number(n) * ((length - 1 - i) % 8 + 2), 0);
    return (sum % 11 < 2 ? 0 : 11 - sum % 11) === Number(doc[length]);
  });
}

export function validateCustomer(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('Preencha seus dados.');
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const email = String(input.email || '').trim().toLowerCase();
  const document = digits(input.document);
  if (name.length < 5 || name.length > 120 || !/^\S+\s+\S+/.test(name)) throw new Error('Informe seu nome completo.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um e-mail válido.');
  if (document.length !== 11 || !validDocument(document)) throw new Error('Informe um CPF válido.');
  if (name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z ]/g,'').trim().length < 5) throw new Error('Informe seu nome completo.');
  return { name, email, document };
}
