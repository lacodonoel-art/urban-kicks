
/*
 * URBAN KICKS - WEBHOOK PAGBANK SANDBOX
 *
 * Etapa: autenticacao e diagnostico.
 *
 * - Valida assinatura SHA-256 antiga.
 * - Detecta assinaturas do formato novo.
 * - Consulta pedidos no Cloudflare D1.
 * - Registra diagnosticos seguros nos logs.
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
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'configuracao',
      tokenConfigurado: false
    });

    return responder({
      erro: 'Token PagBank nao configurado'
    }, 503);
  }

  if (!env.DB) {
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'configuracao',
      bancoConfigurado: false
    });

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

  if (
    !corpo ||
    new TextEncoder().encode(corpo).length > LIMITE_CORPO
  ) {
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

  const origemProduto = request.headers.get(
    'x-product-origin'
  );

  const identificadorProduto = request.headers.get(
    'x-product-id'
  );

  // Diagnostico seguro: registra somente presenca
  // de cabecalhos, nunca seus valores secretos.

  console.log('WEBHOOK DIAGNOSTICO', {
    etapa: 'recebimento',
    metodo: request.method,
    assinaturaAntigaPresente: Boolean(
      assinaturaAntiga
    ),
    assinaturaNovaPresente: Boolean(
      assinaturaNova
    ),
    origemProdutoPresente: Boolean(
      origemProduto
    ),
    identificadorProdutoPresente: Boolean(
      identificadorProduto
    ),
    corpoRecebido: Boolean(corpo)
  });

  /*
   * Assinatura nova:
   * Nao e validada pelo metodo SHA-256 antigo.
   */

  if (assinaturaNova) {
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'autenticacao',
      resultado: 'formato_novo_nao_suportado'
    });

    return responder({
      erro: 'Assinatura ECDSA requer validacao',
      processado: false
    }, 503);
  }

  /*
   * Assinatura antiga ausente.
   */

  if (!assinaturaAntiga) {
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'autenticacao',
      resultado: 'assinatura_ausente',
      assinaturaAntigaPresente: false,
      assinaturaNovaPresente: Boolean(
        assinaturaNova
      ),
      origemProdutoPresente: Boolean(
        origemProduto
      ),
      identificadorProdutoPresente: Boolean(
        identificadorProduto
      )
    });

    return responder({
      erro: 'Assinatura ausente'
    }, 401);
  }

  /*
   * Validacao da assinatura SHA-256 antiga.
   */

  let autenticado = false;

  try {
    autenticado = await validarAssinaturaAntiga(
      corpo,
      assinaturaAntiga,
      env.PAGBANK_TOKEN
    );
  } catch {
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'autenticacao',
      resultado: 'erro_validacao'
    });

    return responder({
      erro: 'Falha na validacao da assinatura'
    }, 503);
  }

  if (!autenticado) {
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'autenticacao',
      resultado: 'assinatura_invalida'
    });

    return responder({
      erro: 'Assinatura invalida'
    }, 401);
  }

  console.log('WEBHOOK DIAGNOSTICO', {
    etapa: 'autenticacao',
    resultado: 'assinatura_valida'
  });

  /*
   * Leitura do evento autenticado.
   */

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

  /*
   * Identificacao do pedido.
   */

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
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'banco',
      resultado: 'erro_consulta'
    });

    return responder({
      erro: 'Falha ao consultar pedido no D1'
    }, 503);
  }

  const statusRecebido =
    typeof evento.status === 'string'
      ? evento.status
      : null;

  if (!pedido) {
    console.log('WEBHOOK DIAGNOSTICO', {
      etapa: 'pedido',
      resultado: 'nao_encontrado'
    });

    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: false,
      processado: false,
      statusRecebido,
      mensagem: 'Pedido nao identificado'
    });
  }

  console.log('WEBHOOK DIAGNOSTICO', {
    etapa: 'pedido',
    resultado: 'encontrado',
    pedidoId: pedido.id,
    statusAtual: pedido.status
  });

  /*
   * SEGURANCA:
   *
   * O webhook ainda nao confirma pagamentos.
   *
   * Proximas etapas:
   *
   * 1. Consultar pagamento na API PagBank.
   * 2. Conferir checkout e referencia.
   * 3. Conferir valor pago.
   * 4. Confirmar status PAID.
   * 5. Atualizar pedido e estoque com
   *    protecao contra processamento duplicado.
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
    mensagem:
      'Pedido identificado. Pagamento ainda nao confirmado.'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
