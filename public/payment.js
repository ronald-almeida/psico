import {api,money,summary,save,forget,showError} from './shared.js';
const id=new URLSearchParams(location.search).get('pedido');
const error=document.querySelector('#payment-error');
const check=document.querySelector('#check-payment');
const copy=document.querySelector('#copy-code');
let timer,clock,current,checking=false,stopped=false;
function countdown(){
  if(!current?.expiresAt){document.querySelector('#expiry').textContent='A confirmação é verificada automaticamente.';return;}
  const remaining=Math.max(0,Math.ceil((Date.parse(current.expiresAt)-Date.now())/1000));
  document.querySelector('#expiry').textContent=remaining>0 ? `Código válido por ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}` : 'Prazo do código encerrado. Verificando a situação do pagamento…';
  copy.disabled=remaining===0;
  document.querySelector('#qr-image').hidden=remaining===0;
}
async function refresh(){
  if(checking||stopped)return;
  checking=true;check.disabled=true;clearTimeout(timer);
  try{
    const o=await api(`/api/orders/${encodeURIComponent(id)}`);current=o;
    document.querySelector('#loader').hidden=true;error.hidden=true;
    if(o.status==='paid'){save('checkout-order',o.id);location.replace(`/obrigado?pedido=${encodeURIComponent(o.id)}`);stopped=true;return;}
    if(o.status==='pending' && o.code){
      document.querySelector('#payment-title').textContent='Falta só o seu Pix!';
      document.querySelector('#payment-description').textContent='Pague com o aplicativo do seu banco para concluir a compra.';
      document.querySelector('#restart').href=`/checkout?produto=${encodeURIComponent(o.items[0].id)}`;
      document.querySelector('#payment-details').hidden=false;
      document.querySelector('#payment-amount').textContent=money(o.amount);
      summary(document.querySelector('#payment-items'),o.items);
      document.querySelector('#qr-image').src=o.qrImage;
      document.querySelector('#pix-code').value=o.code;
      check.hidden=false;countdown();clearInterval(clock);clock=setInterval(countdown,1000);
    }else if(['expired','cancelled','refunded','failed'].includes(o.status)){
      stopped=true;clearInterval(clock);document.querySelector('#payment-details').hidden=true;check.hidden=true;
      document.querySelector('#payment-title').textContent=({expired:'Seu Pix expirou',cancelled:'Pagamento cancelado',refunded:'Pagamento reembolsado',failed:'Pagamento não concluído'})[o.status];
      document.querySelector('#payment-description').textContent='Se você já pagou, verifique novamente antes de gerar outro pedido. Se não pagou, volte ao checkout para recomeçar.';
      document.querySelector('#restart').hidden=false;
      check.hidden=false;forget('checkout-order');forget('checkout-request');
    }else{
      document.querySelector('#payment-title').textContent='Estamos verificando seu Pix';
      document.querySelector('#payment-description').textContent='A geração ainda está em análise. Aguarde a confirmação antes de iniciar outro pedido para evitar cobranças duplicadas. Guarde o número do pedido: '+o.id;
      check.hidden=false;document.querySelector('#restart').hidden=true;
    }
  }catch(e){
    document.querySelector('#loader').hidden=true;
    if(e.status===404){stopped=true;document.querySelector('#payment-title').textContent='Pedido não encontrado';document.querySelector('#payment-description').textContent='Abra o pagamento no mesmo navegador em que iniciou a compra.';document.querySelector('#restart').hidden=false;}
    else{showError(error,'Não foi possível atualizar agora. Seu pedido continua salvo. Tente verificar novamente.');check.hidden=false;}
  }finally{
    checking=false;check.disabled=false;
    if(!stopped&&!document.hidden)timer=setTimeout(refresh,30000);
  }
}
copy.addEventListener('click',async()=>{
  const field=document.querySelector('#pix-code');
  try{await navigator.clipboard.writeText(field.value);document.querySelector('#copy-feedback').textContent='Código copiado! Agora cole no aplicativo do seu banco.';}
  catch{field.focus();field.select();document.querySelector('#copy-feedback').textContent='Selecione e copie o código acima para colar no aplicativo do seu banco.';}
});
check.addEventListener('click',()=>{stopped=false;refresh();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else if(!stopped)refresh();});
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);clearInterval(clock);});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
if(/^[a-f0-9-]{36}$/i.test(id||''))refresh();else{document.querySelector('#loader').hidden=true;document.querySelector('#payment-title').textContent='Vamos começar?';document.querySelector('#payment-description').textContent='Preencha seus dados no checkout para gerar o pagamento.';document.querySelector('#restart').hidden=false;}
