# Psico Black Friday — Daniela Janssen

Página da campanha e dois checkouts próprios, exclusivamente Pix:

| Produto | Identificador | Valor |
| --- | --- | ---: |
| Combo Total — Clube + Luma | `clube-luma` | R$ 599,70 |
| Supervisora Digital Luma Pro | `luma-pro` | R$ 247,00 |

A página mantém a composição, as imagens, a fonte Montserrat e os textos da referência. O botão “Falar com a equipe” foi removido. Os botões de compra abrem `/checkout?produto=clube-luma` e `/checkout?produto=luma-pro`. Sem cartão, boleto, parcelamento ou Pix automático recorrente. As imagens e fontes são locais; scripts de rastreamento e links de pagamento do site original não foram incluídos.

## Desenvolvimento

Node.js 24 e pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

No PowerShell: `Copy-Item .env.example .env`. Abra `http://127.0.0.1:3000`. `pnpm build` verifica a sintaxe, arquivos locais e testes de pagamento/armazenamento. O servidor local usa SQLite em `data/`.

## Vercel e configuração real

Repositório: `ronald-almeida/psico`. Projeto Vercel: `psico`, Node.js 24, funções em São Paulo (`gru1`). O projeto usa Vercel Blob **privado**, com autenticação OIDC e `BLOB_STORE_ID`; não usa SQLite no disco temporário da função.

Configure as variáveis **somente no servidor**, em Vercel → psico → Settings → Environment Variables:

- `NEXUM_CHAT_ID`: identificador da conta Nexum.
- `NEXUM_API_CREDENTIAL`: credencial fixa gerada no painel Nexum → Integração. Armazene como Sensitive.
- `NEXUM_WEBHOOK_SECRET`: segredo aleatório de pelo menos 32 caracteres, armazenado como Sensitive. Assina os tokens de recebimento de webhook de cada pedido. Não altere enquanto houver Pix pendentes gerados com ele.
- `PUSHCUT_PIX_PENDING_URL` e `PUSHCUT_PIX_PAID_URL`: URLs privadas de notificação do Pushcut, também como Sensitive. Em produção, correspondem a **Gerou1** e **VENDA APROVADA1**, respectivamente. Nunca coloque esses links no código público ou no Git.
- `PUBLIC_ORIGIN`: opcional, domínio HTTPS canônico. Sem ela, produção usa `VERCEL_PROJECT_PRODUCTION_URL`; previews usam `VERCEL_URL`.
- `CLUBE_LUMA_ACCESS_URL` e `LUMA_PRO_ACCESS_URL`: opcionais, endereços HTTPS das áreas de membros, exibidos **somente após** pagamento confirmado.

Faça um novo deploy após configurar variáveis. Sem credenciais Nexum, as ofertas e os checkouts são exibidos, mas o botão de pagamento fica indisponível. A aplicação nunca gera Pix fictício em produção. Não copie chaves de outros gateways.

Após confirmar o Pix, o checkout abre `/obrigado?pedido=...`, com agradecimento, recibo e botão **Continuar no WhatsApp**, direcionado ao **(75) 98839-3742** (`https://wa.me/5575988393742`). A mensagem vem preenchida com o produto e o número do pedido para solicitar orientações de acesso; o cliente precisa enviá-la. A página só exibe a confirmação e esse botão após verificar o pagamento no servidor.

Não há integração automática de matrícula, envio de e-mail ou criação de contas em uma área de membros. Se configurado, o link específico do produto também é exibido. A autorização de acesso ao conteúdo deve ser feita pela plataforma de cursos; um link comum não cria matrícula nem substitui o controle de acesso dessa plataforma.

## Contrato Nexum

[Documentação oficial consultada em 19/11/2026](https://app.nexumpaybot.com/api/index.html).

- `POST https://api.nexumpaybot.com/api/public/pix/create`: valor em reais, nome normalizado sem acentos, e-mail e CPF validados; `externalReference` e `Idempotency-Key` iguais ao ID interno do pedido. Com o segredo configurado, envia `webhook.url` apontando para `/api/webhooks/nexum` no domínio da aplicação e `webhook.token` exclusivo do pedido.
- Headers privados `X-API-Chat-Id` e `X-API-Credential`, e `Origin: https://nexumpaybot.com`, conforme documentação.
- `GET /api/public/pix/status/{tx_id}`: apenas após conferir ID da transação e valor bruto. Estados e aliases seguem o contrato publicado. Reembolso revoga a exposição do link.
- Consulta no máximo uma vez a cada 30 segundos, com reserva atômica entre instâncias e respeito a `Retry-After` em respostas 429.
- QR Code gerado no próprio servidor a partir de `qr_code_text`; não envia o Pix a um serviço de imagens. Expiração só é exibida quando o provedor informa `expires_in_seconds`.
- Resposta `202 PROCESSING` mantém a transação e consulta seu status, sem inventar QR Code. Se a API não fornecer o código, a interface permanece em verificação; o contrato de status documentado não garante recuperação do QR.
- Timeout ou resposta inválida mantém a tentativa como incerta e bloqueia reenvio automático daquela tentativa. Consulte a referência do pedido no painel Nexum antes de gerar outra cobrança. Uma rejeição definitiva permite nova tentativa.

## Dados e segurança

Preços em centavos e produtos são definidos no servidor. O navegador não escolhe o valor cobrado. Reservas e idempotência usam escrita condicional por ETag no Blob. Uma falha de armazenamento impede chamar o gateway. Cookie HttpOnly, Secure em HTTPS, SameSite Strict e validação de origem isolam os pedidos por navegador. Dados cadastrais são enviados à Nexum e não persistidos pela aplicação nem registrados em logs. O armazenamento privado guarda os itens, valor, referência, código Pix e hashes de sessão/idempotência. A sessão dura 30 dias; pedidos não são apagados automaticamente.

O endpoint público **`POST /api/webhooks/nexum`** recebe `pix.status_changed` nos estados `PENDING` e `PAID`, inclusive com o navegador fechado. Exige o header `X-Webhook-Token` enviado pela Nexum, autentica a assinatura do token e confere referência do pedido, ID da transação e valor bruto. Não depende de cookie. Payloads de clientes e URLs de sucesso não confirmam pagamento. O estado é persistido antes de responder, inclusive se o callback chegar antes da resposta de criação do Pix. Eventos atrasados não revertem pagamentos confirmados ou reembolsados.

A página de pagamento continua consultando automaticamente a cada 30 segundos como apoio e redireciona para o agradecimento ao confirmar. Não há botão de verificação manual. Sem `NEXUM_WEBHOOK_SECRET`, o recebimento fica desativado e resta a consulta automática; produção deve ter o segredo configurado. Cobranças anteriores à implantação não recebem um webhook retroativo. Endpoints de saque não fazem parte deste checkout.

## Avisos Pushcut

Pedidos novos disparam **Gerou1** ao gerar o Pix e **VENDA APROVADA1** após confirmação autenticada. Os callbacks e a consulta automática compartilham o registro de entrega no armazenamento privado, com reserva atômica para evitar envios simultâneos e repetição de avisos já entregues. A chamada preserva o conteúdo definido no Pushcut e não inclui nome, CPF ou e-mail do cliente. Pedidos antigos não disparam avisos retroativos.

Falhas de notificação não desfazem o pagamento nem geram outra cobrança. No webhook, uma falha retorna HTTP 503 para acionar as retentativas documentadas da Nexum (até três, com intervalos de 1, 2 e 4 segundos). Consultas posteriores também tentam entregar avisos ainda pendentes. Não há retentativa ilimitada em segundo plano: se o Pushcut continuar indisponível depois dessas tentativas e o cliente fechar o navegador, o aviso permanece pendente até outra consulta/callback. Como em toda entrega HTTP sem garantia transacional do destinatário, um timeout após a aceitação pelo Pushcut pode causar repetição na retentativa; o mesmo identificador de notificação é reutilizado.

Referências: [webhooks Nexum](https://app.nexumpaybot.com/api/index.html) e [notificações Pushcut](https://www.pushcut.io/support/notifications).

## Testes e simulação

`pnpm test` cobre os dois preços, adulteração de valores, CPF, concorrência, idempotência, isolamento de sessão, falhas do provedor, estados Nexum, reembolso, armazenamento, intervalo de consulta, autenticação dos webhooks, callbacks antecipados/duplicados/fora de ordem, notificações Pushcut e falhas/repetições de entrega. As chamadas Nexum e Pushcut dos testes são simuladas.

`node scripts/preview-test.js` abre **apenas localmente** `http://127.0.0.1:3001`, com banco em memória e código sem valor financeiro. O arquivo `../qa-status.txt` controla `pending`, `paid`, `expired` ou `refunded`. O simulador não usa credenciais e não é executado pelo deploy. Uma compra real só poderá ser validada após a configuração Nexum; nenhuma compra real foi efetuada na implementação.

Referência visual: [campanha original](https://cursosdanielajanssen.com.br/black-friday). Recursos originais públicos: imagens da página e fonte Montserrat. Os direitos das marcas, imagens e textos permanecem com seus respectivos titulares.
