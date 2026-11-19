import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const files=['server.js',...['api','lib','public','scripts','test'].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.js')).map(f=>join(dir,f)))];
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(1);}
for(const name of ['index.html','checkout.html','payment.html','thanks.html']){
  const html=readFileSync(join('public',name),'utf8');
  for(const [,path] of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)){
    if(['/','/black-friday','/checkout','/pagamento','/obrigado'].includes(path))continue;
    readFileSync(join('public',path));
  }
}
console.log(`Sintaxe verificada em ${files.length} arquivos. Referências locais das quatro páginas válidas.`);
