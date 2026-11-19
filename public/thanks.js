import {api,money,summary,forget,showError} from './shared.js';
const id=new URLSearchParams(location.search).get('pedido');
const returnLink=document.querySelector('#return-link');
async function initialize(){
  try{
    if(!/^[a-f0-9-]{36}$/i.test(id||''))throw new Error('Pedido não encontrado. Acesse esta página pelo seu pagamento.');
    const o=await api(`/api/orders/${encodeURIComponent(id)}`);
    if(o.status!=='paid'){
      document.querySelector('#thanks-title').textContent='Ainda aguardamos seu pagamento';
      document.querySelector('#thanks-description').textContent='A confirmação aparecerá aqui assim que o pagamento for verificado.';
      returnLink.href=`/pagamento?pedido=${encodeURIComponent(id)}`;returnLink.textContent='Ver meu pagamento Pix';returnLink.hidden=false;return;
    }
    document.querySelector('#confirmed-icon').hidden=false;
    document.querySelector('#thanks-title').textContent='Obrigada pela sua compra!';
    document.querySelector('#thanks-description').textContent='Seu pagamento no Pix foi confirmado. Estamos felizes em ter você com a gente!';
    const whatsapp=new URL('https://wa.me/5575988393742');
    whatsapp.searchParams.set('text',`Olá! Concluí minha compra de ${o.items.map(item=>item.name).join(' + ')} e gostaria das orientações de acesso.\n\nNúmero do pedido: ${o.id}`);
    document.querySelector('#whatsapp-link').href=whatsapp.href;
    document.querySelector('#receipt-id').textContent=o.id;
    document.querySelector('#confirmed-content').hidden=false;
    summary(document.querySelector('#receipt-items'),o.items);
    document.querySelector('#receipt-total').textContent=money(o.amount);
    if(o.accessUrl&&new URL(o.accessUrl).protocol==='https:'){
      const link=document.querySelector('#access-link');link.href=o.accessUrl;link.hidden=false;
    }
    forget('checkout-order');forget('checkout-request');
  }catch(e){
    document.querySelector('#thanks-title').textContent='Vamos conferir seu pedido';
    document.querySelector('#thanks-description').textContent='A confirmação não pôde ser consultada neste momento.';
    showError(document.querySelector('#thanks-error'),e.message);
    returnLink.hidden=false;
    if(/^[a-f0-9-]{36}$/i.test(id||'')){returnLink.href=`/pagamento?pedido=${encodeURIComponent(id)}`;returnLink.textContent='Consultar meu pagamento';}
  }finally{document.querySelector('#loader').hidden=true;}
}
initialize();
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
