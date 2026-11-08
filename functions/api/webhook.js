
/*
 * URBAN KICKS - WEBHOOK PAGBANK SANDBOX
 *
 * Etapa: autenticacao e identificacao de pedidos.
 *
 * - Valida assinatura SHA-256 antiga.
 * - Detecta assinaturas do formato novo.
 * - Consulta pedidos no Cloudflare D1.
 * - Nao aprova pagamentos automaticamente.
 * - Nao altera estoque nesta etapa.
 */

const LIMITE_CORPO = 200000;

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function converterHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
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

async function validarAssinaturaAntiga(
  corpo,
  assinatura,
  token
) {
  if (!/^[a-f0-9]{64}$/i.test(assinatura || '')) {
    return false;
  }

  const mensagem = token + '-' + corpo;

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(mensagem)
  );

  return compararSeguro(
    converterHex(digest),
    assinatura.toLowerCase()
  );
}

function identificarPedido(evento, request) {
  const referencia =
    typeof evento.reference_id === 'string'
      ? evento.reference_id
      : null;

  const checkoutEvento =
    typeof evento.checkout_id === 'string'
      ? evento.checkout_id
      : null;

  const origem = request.headers.get(
    'x-product-origin'
  );

  const produtoId = request.headers.get(
    'x-product-id'
  );

  const checkoutHeader =
    origem === 'CHECKOUT' &&
    produtoId?.startsWith('CHEC_')
      ? produtoId
      : null;

  return {
    referencia,
    checkoutId: checkoutEvento || checkoutHeader
  };
}

async function buscarPedido(db, identificacao) {
  const { referencia, checkoutId } = identificacao;

  if (referencia && checkoutId) {
    return await db.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE referencia = ?
        AND checkout_id = ?
      LIMIT 1
    `).bind(referencia, checkoutId).first();
  }

  if (referencia) {
    return await db.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE referencia = ?
      LIMIT 1
    `).bind(referencia).first();
  }

  if (checkoutId) {
    return await db.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE checkout_id = ?
      LIMIT 1
    `).bind(checkoutId).first();
  }

  return null;
}

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN) {
    return responder({
      erro: 'Token PagBank nao configurado'
    }, 503);
  }

  if (!env.DB) {
    return responder({
      erro: 'Banco D1 nao configurado'
    }, 503);
  }

  const tamanhoInformado = Number(
    request.headers.get('content-length') || 0
  );

  if (tamanhoInformado > LIMITE_CORPO) {
    return responder({
      erro: 'Notificacao muito grande'
    }, 413);
  }

  let corpo;

  try {
    corpo = await request.text();
  } catch {
    return responder({
      erro: 'Falha ao ler notificacao'
    }, 400);
  }

  if (!corpo || corpo.length > LIMITE_CORPO) {
    return responder({
      erro: 'Corpo invalido'
    }, 400);
  }

  const assinaturaNova = request.headers.get(
    'x-payload-signature'
  );

  const assinaturaAntiga = request.headers.get(
    'x-authenticity-token'
  );

  /*
   * O formato novo usa assinatura ECDSA.
   * Nao podemos validá-lo com o SHA-256 antigo.
   * Retornamos 503 ate implementar a verificacao
   * com a chave publica oficial do PagBank.
   */
  if (assinaturaNova) {
    return responder({
      erro: 'Assinatura ECDSA requer validacao',
      processado: false
    }, 503);
  }

  if (!assinaturaAntiga) {
    return responder({
      erro: 'Assinatura ausente'
    }, 401);
  }

  let autenticado;

  try {
    autenticado = await validarAssinaturaAntiga(
      corpo,
      assinaturaAntiga,
      env.PAGBANK_TOKEN
    );
  } catch {
    return responder({
      erro: 'Falha na validacao da assinatura'
    }, 503);
  }

  if (!autenticado) {
    return responder({
      erro: 'Assinatura invalida'
    }, 401);
  }

  let evento;

  try {
    evento = JSON.parse(corpo);
  } catch {
    return responder({
      erro: 'JSON invalido'
    }, 400);
  }

  if (
    !evento ||
    typeof evento !== 'object' ||
    Array.isArray(evento)
  ) {
    return responder({
      erro: 'Evento invalido'
    }, 400);
  }

  const identificacao = identificarPedido(
    evento,
    request
  );

  let pedido;

  try {
    pedido = await buscarPedido(
      env.DB,
      identificacao
    );
  } catch {
    return responder({
      erro: 'Falha ao consultar pedido no D1'
    }, 503);
  }

  const statusRecebido =
    typeof evento.status === 'string'
      ? evento.status
      : null;

  if (!pedido) {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: false,
      processado: false,
      statusRecebido,
      mensagem: 'Pedido nao identificado'
    });
  }

  /*
   * IMPORTANTE:
   *
   * O status recebido ainda nao e suficiente
   * para confirmar o pagamento.
   *
   * A proxima etapa devera:
   *
   * 1. Consultar o pagamento na API PagBank.
   * 2. Vincular a transacao ao checkout correto.
   * 3. Conferir o valor pago.
   * 4. Confirmar o status PAID.
   * 5. Atualizar pedido e estoque em transacao
   *    idempotente no banco D1.
   */

  return responder({
    recebido: true,
    autenticado: true,
    pedidoEncontrado: true,
    pedidoId: pedido.id,
    referencia: pedido.referencia,
    statusAtual: pedido.status,
    statusRecebido,
    processado: false,
    estoqueAlterado: false,
    mensagem: 'Pedido identificado. Pagamento ainda nao confirmado.'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
