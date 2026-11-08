
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

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN) {
    return responder({
      erro: 'Token PagBank não configurado'
    }, 503);
  }

  if (!env.DB) {
    return responder({
      erro: 'Banco D1 não configurado'
    }, 503);
  }

  let pedido;

  try {
    pedido = await request.json();
  } catch (erro) {
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
    const id = item?.id;
    const tamanho = String(item?.size ?? '');
    const quantidade = item?.quantity;

    if (
      !Number.isInteger(id) ||
      !Object.prototype.hasOwnProperty.call(PRODUTOS, id) ||
      !/^\d{2}$/.test(tamanho) ||
      Number(tamanho) < 34 ||
      Number(tamanho) > 44 ||
      !Number.isInteger(quantidade) ||
      quantidade < 1 ||
      quantidade > 5
    ) {
      return responder({
        erro: 'Produto, tamanho ou quantidade inválida'
      }, 400);
    }

    const chave = String(id) + '-' + tamanho;
    const total =
      (agrupados.get(chave)?.quantity || 0) + quantidade;

    if (total > 5) {
      return responder({
        erro: 'Limite de 5 unidades por produto e tamanho'
      }, 400);
    }

    agrupados.set(chave, {
      id,
      tamanho,
      quantity: total
    });
  }

  const produtosAgrupados = [...agrupados.values()];

  const itens = produtosAgrupados.map(
    ({ id, tamanho, quantity }) => ({
      reference_id: String(id) + '-' + tamanho,
      name: PRODUTOS[id].nome + ' - Tamanho ' + tamanho,
      quantity,
      unit_amount: PRODUTOS[id].valor
    })
  );

  const valorTotal = produtosAgrupados.reduce(
    (total, item) =>
      total + PRODUTOS[item.id].valor * item.quantity,
    0
  );

  const referencia = 'UK-' + crypto.randomUUID();

  // Criar checkout no PagBank Sandbox.
  let dados;

  try {
    const resposta = await fetch(PAGBANK_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.PAGBANK_TOKEN,
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
        return_url: SITE_URL + '/',
        payment_notification_urls: [
          SITE_URL + '/api/webhook'
        ],
        notification_urls: [
          SITE_URL + '/api/webhook'
        ]
      })
    });

    dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      return responder({
        erro: 'PagBank recusou a criação do checkout',
        statusPagBank: resposta.status,
        detalhes: dados.error_messages || dados.message || null
      }, 502);
    }
  } catch (erro) {
    return responder({
      erro: 'Falha de comunicação com PagBank'
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
    return responder({
      erro: 'Link de pagamento Sandbox não recebido'
    }, 502);
  }

  const checkoutId = dados.id;

  if (
    typeof checkoutId !== 'string' ||
    !checkoutId.startsWith('CHEC_')
  ) {
    return responder({
      erro: 'Identificador do checkout não recebido'
    }, 502);
  }

  // Registrar pedido e itens no banco D1.
  // Tudo é gravado em uma transação atômica.
  // Nenhum estoque é descontado nesta etapa.

  try {
    const comandos = [
      env.DB.prepare(
        `INSERT INTO pedidos
         (referencia, checkout_id, status, valor_total)
         VALUES (?, ?, 'PENDENTE', ?)`
      ).bind(referencia, checkoutId, valorTotal)
    ];

    for (const item of produtosAgrupados) {
      comandos.push(
        env.DB.prepare(
          `INSERT INTO pedido_itens
           (pedido_id, produto_id, produto_nome,
            tamanho, quantidade, preco_unitario)
           SELECT id, ?, ?, ?, ?, ?
           FROM pedidos
           WHERE referencia = ?`
        ).bind(
          item.id,
          PRODUTOS[item.id].nome,
          item.tamanho,
          item.quantity,
          PRODUTOS[item.id].valor,
          referencia
        )
      );
    }

    await env.DB.batch(comandos);
  } catch (erro) {
    console.error(
      'Erro ao registrar pedido no D1:',
      erro instanceof Error ? erro.message : 'Erro desconhecido'
    );

    return responder({
      erro: 'Checkout criado, mas pedido não registrado',
      referencia,
      mensagem: 'Não tente pagar novamente até verificar o pedido.'
    }, 503);
  }

  return responder({
    checkoutUrl: link,
    referencia,
    checkoutId,
    status: 'PENDENTE'
  });
}
