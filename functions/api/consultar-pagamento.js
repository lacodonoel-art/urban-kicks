
/*
 * URBAN KICKS - CONSULTA PAGBANK SANDBOX
 * Consulta de checkout protegida.
 * Somente leitura: nao altera pedidos ou estoque.
 */

const API = 'https://sandbox.api.pagseguro.com';

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function compararSeguro(a, b) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
    a.length !== b.length
  ) return false;

  let diferenca = 0;

  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diferenca === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN || !env.DB ||
      !env.CONSULTA_ADMIN_KEY) {
    return responder({
      erro: 'Configuracao incompleta'
    }, 503);
  }

  const chave = request.headers.get('x-admin-key');

  if (!compararSeguro(chave, env.CONSULTA_ADMIN_KEY)) {
    return responder({ erro: 'Nao autorizado' }, 401);
  }

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return responder({ erro: 'JSON invalido' }, 400);
  }

  const pedidoId = entrada?.pedidoId;

  if (!Number.isSafeInteger(pedidoId) ||
      pedidoId < 1) {
    return responder({ erro: 'Pedido invalido' }, 400);
  }

  let pedido;

  try {
    pedido = await env.DB.prepare(
      `SELECT id, referencia, checkout_id,
              status, valor_total
       FROM pedidos WHERE id = ? LIMIT 1`
    ).bind(pedidoId).first();
  } catch {
    return responder({
      erro: 'Falha ao consultar banco'
    }, 503);
  }

  if (!pedido) {
    return responder({ erro: 'Pedido nao encontrado' }, 404);
  }

  if (!/^CHEC_[A-Z0-9-]+$/i.test(pedido.checkout_id)) {
    return responder({
      erro: 'Checkout invalido'
    }, 400);
  }

  let resposta;
  let dados;

  try {
    resposta = await fetch(
      API + '/checkouts/' +
      encodeURIComponent(pedido.checkout_id),
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + env.PAGBANK_TOKEN,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    dados = await resposta.json().catch(() => ({}));
  } catch {
    return responder({
      erro: 'Falha de comunicacao com PagBank'
    }, 502);
  }

  if (!resposta.ok) {
    return responder({
      erro: 'Consulta recusada pelo PagBank',
      statusPagBank: resposta.status
    }, 502);
  }

  const checkoutConfere =
    dados.id === pedido.checkout_id &&
    dados.reference_id === pedido.referencia;

  const transacoes = Array.isArray(dados.orders)
    ? dados.orders.map(ordem => ({
        pedidoPagBank: ordem.id || null,
        referencia: ordem.reference_id || null,
        cobrancas: Array.isArray(ordem.charges)
          ? ordem.charges.map(c => ({
              id: c.id || null,
              status: c.status || null,
              valor: c.amount?.value ?? null
            }))
          : []
      }))
    : [];

  return responder({
    ambiente: 'SANDBOX',
    pedidoId: pedido.id,
    referencia: pedido.referencia,
    checkoutId: pedido.checkout_id,
    statusNoBanco: pedido.status,
    valorNoBanco: pedido.valor_total,
    checkoutConfere,
    statusCheckout: dados.status || null,
    transacoes,
    consultaRealizada: true,
    pagamentoConfirmado: false,
    estoqueAlterado: false,
    aviso: 'Consulta informativa. Nenhum pedido foi atualizado.'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
