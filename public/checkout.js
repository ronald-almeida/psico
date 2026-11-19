import {api,money,summary,save,showError} from './shared.js';
const form=document.querySelector('#checkout-form'),button=document.querySelector('#pay-button'),message=document.querySelector('#form-error');
const fields=Object.fromEntries(['name','email','confirmEmail','document'].map(name=>[name,form.elements.namedItem(name)]));
const productId=new URLSearchParams(location.search).get('produto');
let product,requestKey=crypto.randomUUID();
fields.document.addEventListener('input',()=>{const d=fields.document.value.replace(/\D/g,'').slice(0,11);fields.document.value=d.replace(/^(\d{3})(\d{3})(\d{3})(\d{0,2}).*/,'$1.$2.$3-$4');});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(button.disabled||!product)return;
  message.hidden=true;
  if(fields.email.value.trim().toLowerCase()!==fields.confirmEmail.value.trim().toLowerCase()){
    showError(message,'Os e-mails precisam ser iguais. Confira a confirmação do seu e-mail.');fields.confirmEmail.focus();return;
  }
  button.disabled=true;button.textContent='Preparando seu Pix…';
  const payload={productId,customer:{name:fields.name.value,email:fields.email.value,document:fields.document.value}};
  try{
    let order;
    for(let attempt=0;attempt<2;attempt++){
      try{order=await api('/api/orders',{method:'POST',body:JSON.stringify({...payload,requestKey})});break;}
      catch(e){if(e.status!==409||!e.resetRequest||attempt>0)throw e;requestKey=crypto.randomUUID();}
    }
    if(order.amount!==product.price||order.items.length!==1||order.items[0].id!==productId)throw new Error('O valor do Pix não corresponde à oferta selecionada. Atualize a página e tente novamente.');
    save('checkout-order',order.id);location.assign(`/pagamento?pedido=${encodeURIComponent(order.id)}`);
  }catch(e){
    if(e.resetRequest)requestKey=crypto.randomUUID();
    showError(message,e.name==='TimeoutError'?'A consulta demorou. Tente novamente para retomar o mesmo pedido.':e.message);
    message.scrollIntoView({behavior:'smooth',block:'center'});button.disabled=false;button.textContent='Gerar Pix e finalizar compra';
  }
});
async function initialize(){
  try{
    const catalog=await api('/api/catalog');product=catalog.products.find(p=>p.id===productId);
    if(!product){document.querySelector('#product-name').textContent='Oferta não encontrada';form.hidden=true;throw new Error('Volte às ofertas e selecione o produto desejado.');}
    document.title=`${product.name} | Checkout Pix`;
    document.querySelector('#product-name').textContent=product.name;
    document.querySelector('#product-description').textContent=product.description;
    const img=document.querySelector('#product-image');img.src=product.image;img.alt=product.name;img.hidden=false;
    document.querySelector('#product-price').textContent=money(product.price);document.querySelector('#total').textContent=money(product.price);
    summary(document.querySelector('#summary-items'),[product]);
    button.disabled=!catalog.checkoutAvailable;document.querySelector('#availability').hidden=catalog.checkoutAvailable;
  }catch(e){form.hidden=false;showError(message,e.message);}
}
initialize();window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
