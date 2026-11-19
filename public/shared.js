export const money = value => (value/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export function save(key,value) { try { localStorage.setItem(key,value); } catch {} }
export function saved(key) { try { return localStorage.getItem(key); } catch { return null; } }
export function forget(key) { try { localStorage.removeItem(key); } catch {} }
export async function api(path,options={}) {
  const response = await fetch(path,{...options,signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json',...options.headers}});
  const body=await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message || 'Não foi possível concluir. Tente novamente.'),{status:response.status,orderId:body.orderId,resetRequest:body.resetRequest});
  return body;
}
export function summary(container,items) {
  container.replaceChildren();
  items.forEach(item=>{
    const row=document.createElement('div');row.className='summary-line';
    const name=document.createElement('span');name.textContent=item.name;
    const price=document.createElement('span');price.textContent=money(item.price);
    row.append(name,price);container.append(row);
  });
}
export function showError(element,message) { element.textContent=message;element.hidden=false; }
