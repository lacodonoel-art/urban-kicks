
/*
 * URBAN KICKS
 * Consulta direta de pedido PagBank Sandbox
 *
 * Arquivo:
 * functions/api/consultar-pedido-pagbank.js
 *
 * Somente leitura.
 * Nao confirma pagamentos.
 * Nao altera estoque.
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
  ) {
    return false;
  }

  let diferenca = 0;

  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diferenca === 0;
}

export async function onRequestPost({ request, env }) {
  if (
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY ||
    !env.DB
  ) {
    return responder({
      erro: 'Configuracao incompleta'
    }, 503);
  }

  const chave = request.headers.get('x-admin-key');

  if (!compararSeguro(chave, env.CONSULTA_ADMIN_KEY)) {
    return responder({
      erro: 'Nao autorizado'
    }, 401);
  }

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return responder({
      erro: 'JSON invalido'
    }, 400);
  }

  const pedidoId = entrada?.pedidoId;
  const ordemId = entrada?.ordemId;

  if (
    !Number.isSafeInteger(pedidoId) ||
    pedidoId < 1 ||
    typeof ordemId !== 'string' ||
    !/^ORDE_[A-F0-9-]{36}$/i.test(ordemId)
  ) {
    return responder({
      erro: 'Identificadores invalidos'
    }, 400);
  }

  let pedido;

  try {
    pedido = await env.DB.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE id = ?
      LIMIT 1
    `).bind(pedidoId).first();
  } catch {
    return responder({
      erro: 'Falha ao consultar D1'
    }, 503);
  }

  if (!pedido) {
    return responder({
      erro: 'Pedido local nao encontrado'
    }, 404);
  }

  if (
    typeof pedido.checkout_id !== 'string' ||
    !/^CHEC_[A-F0-9-]{36}$/i.test(
      pedido.checkout_id
    )
  ) {
    return responder({
      erro: 'Checkout local invalido'
    }, 400);
  }

  async function consultar(caminho) {
    const resposta = await fetch(API + caminho, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + env.PAGBANK_TOKEN,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(12000)
    });

    const dados = await resposta.json().catch(() => ({}));

    return {
      ok: resposta.ok,
      status: resposta.status,
      dados
    };
  }

  let checkout;

  try {
    checkout = await consultar(
      '/checkouts/' +
      encodeURIComponent(pedido.checkout_id)
    );
  } catch {
    return responder({
      erro: 'Falha ao consultar checkout'
    }, 502);
  }

  if (!checkout.ok) {
    return responder({
      erro: 'PagBank recusou consulta do checkout',
      statusPagBank: checkout.status
    }, 502);
  }

  const checkoutConfere =
    checkout.dados.id === pedido.checkout_id &&
    checkout.dados.reference_id === pedido.referencia;

  if (!checkoutConfere) {
    return responder({
      erro: 'Checkout nao corresponde ao pedido local',
      checkoutConfere: false
    }, 409);
  }

  const ordens = Array.isArray(checkout.dados.orders)
    ? checkout.dados.orders
    : [];

  const ordemVinculada = ordens.some(
    ordem => ordem?.id === ordemId
  );

  if (!ordemVinculada) {
    return responder({
      erro: 'Ordem nao pertence ao checkout informado',
      ordemVinculada: false
    }, 409);
  }

  let resultado;

  try {
    resultado = await consultar(
      '/orders/' + encodeURIComponent(ordemId)
    );
  } catch {
    return responder({
      erro: 'Falha ao consultar ordem PagBank'
    }, 502);
  }

  if (!resultado.ok) {
    return responder({
      erro: 'PagBank recusou consulta da ordem',
      statusPagBank: resultado.status
    }, 502);
  }

  const dados = resultado.dados;

  if (dados.id !== ordemId) {
    return responder({
      erro: 'Identificador da ordem divergente'
    }, 409);
  }

  const cobrancas = Array.isArray(dados.charges)
    ? dados.charges.map(cobranca => ({
        id: cobranca.id || null,
        status: cobranca.status || null,
        valor: cobranca.amount?.value ?? null,
        criadoEm: cobranca.created_at || null,
        pagoEm: cobranca.paid_at || null,
        metodo: cobranca.payment_method?.type || null
      }))
    : [];

  const qrCodes = Array.isArray(dados.qr_codes)
    ? dados.qr_codes.map(qr => ({
        id: qr.id || null,
        valor: qr.amount?.value ?? null,
        expiracao: qr.expiration_date || null
      }))
    : [];

  return responder({
    ambiente: 'SANDBOX',
    pedidoId: pedido.id,
    referenciaLocal: pedido.referencia,
    checkoutId: pedido.checkout_id,
    checkoutConfere: true,
    ordemVinculada: true,
    ordemId: dados.id,
    referenciaOrdem: dados.reference_id || null,
    statusNoBanco: pedido.status,
    valorNoBanco: pedido.valor_total,
    cobrancas,
    qrCodes,
    quantidadeCobrancas: cobrancas.length,
    consultaRealizada: true,
    pagamentoConfirmado: false,
    estoqueAlterado: false,
    aviso:
      'Consulta informativa. Nenhum pedido foi atualizado.'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
