```javascript
// Urban Kicks — Cloudflare Pages Function
// PagBank Sandbox (ambiente de testes)
// Preços em centavos, validados no servidor.

const PRODUTOS = {
  1: { nome: 'New Balance — Cinza Urbano', valor: 39990 },
  2: { nome: 'Nike TN — Edição Iridescente', valor: 44990 },
  3: { nome: 'Nike Air Max Plus — Preto e Prata', valor: 42990 },
  4: { nome: 'Nike Shox — Total Black', valor: 49990 },
  5: { nome: 'Nike Air Max Plus — Blue Gradient', valor: 44990 },
  6: { nome: 'Nike Shox — Marrom Escuro', valor: 48990 },
  7: { nome: 'Nike P-6000 — Branco', valor: 37990 },
  8: { nome: 'Nike P-6000 — Branco Lateral', valor: 37990 }
};

const SITE_URL = 'https://urban-kicks.pages.dev';
const PAGBANK_API = 'https://sandbox.api.pagseguro.com/checkouts';

const responder = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN) {
    return responder(
      { erro: 'Token PagBank não configurado' },
      503
    );
  }

  let pedido;

  try {
    pedido = await request.json();
  } catch {
    return responder({ erro: 'JSON inválido' }, 400);
  }

  if (
    !pedido ||
    !Array.isArray(pedido.items) ||
    pedido.items.length < 1 ||
    pedido.items.length > 20
  ) {
    return responder({ erro: 'Carrinho inválido' }, 400);
  }

  const agrupados = new Map();

  for (const item of pedido.items) {
    const id = Number(item?.id);
    const tamanho = String(item?.size ?? '');
    const quantidade = item?.quantity;

    if (
      !Number.isInteger(id) ||
      !PRODUTOS[id] ||
      !/^\d{2}$/.test(tamanho) ||
      Number(tamanho) < 34 ||
      Number(tamanho) > 44 ||
      !Number.isInteger(quantidade) ||
      quantidade < 1 ||
      quantidade > 5
    ) {
      return responder(
        { erro: 'Produto, tamanho ou quantidade inválida' },
        400
      );
    }

    const chave = `${id}-${tamanho}`;
    const total =
      (agrupados.get(chave)?.quantity || 0) + quantidade;

    if (total > 5) {
      return responder(
        { erro: 'Limite de 5 unidades por produto e tamanho' },
        400
      );
    }

    agrupados.set(chave, {
      id,
      tamanho,
      quantity: total
    });
  }

  const itens = [...agrupados.values()].map(
    ({ id, tamanho, quantity }) => ({
      reference_id: `${id}-${tamanho}`,
      name: `${PRODUTOS[id].nome} - Tamanho ${tamanho}`,
      quantity,
      unit_amount: PRODUTOS[id].valor
    })
  );

  const referencia = `UK-${crypto.randomUUID()}`;

  try {
    const resposta = await fetch(PAGBANK_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAGBANK_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        reference_id: referencia,
        items: itens,

        payment_methods: [
          { type: 'PIX' },
          { type: 'CREDIT_CARD' }
        ],

        return_url: `${SITE_URL}/`,

        payment_notification_urls: [
          `${SITE_URL}/api/webhook`
        ],

        notification_urls: [
          `${SITE_URL}/api/webhook`
        ]
      })
    });

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      return responder({
        erro: 'PagBank recusou a criação do checkout',
        statusPagBank: resposta.status,
        detalhes:
          dados.error_messages ||
          dados.message ||
          null
      }, 502);
    }

    const link = dados.links?.find(
      item => item.rel === 'PAY'
    )?.href;

    if (
      typeof link !== 'string' ||
      !link.startsWith(
        'https://pagamento.sandbox.pagbank.com.br/'
      )
    ) {
      return responder(
        { erro: 'Link de pagamento Sandbox não recebido' },
        502
      );
    }

    return responder({
      checkoutUrl: link,
      referencia
    });

  } catch {
    return responder(
      { erro: 'Falha de comunicação com PagBank' },
      502
    );
  }
}
```
