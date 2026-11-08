
/*
 * URBAN KICKS - CONFIRMAR PAGAMENTO
 * PagBank Sandbox + Cloudflare D1
 *
 * Confirma pagamento consultando diretamente o PagBank.
 * Atualiza pedido, registra cobranca e desconta estoque
 * em uma unica transacao atomica D1.
 *
 * Acesso administrativo via CONSULTA_ADMIN_KEY.
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

async function consultarPagBank(caminho, token) {
  const resposta = await fetch(API + caminho, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!resposta.ok) {
    throw new Error(
      'PagBank retornou HTTP ' + resposta.status
    );
  }

  return resposta.json();
}

export async function onRequestPost({ request, env }) {
  if (
    !env.DB ||
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY
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

  if (
    !Number.isSafeInteger(pedidoId) ||
    pedidoId < 1
  ) {
    return responder({
      erro: 'Pedido invalido'
    }, 400);
  }

  let pedido;

  try {
    pedido = await env.DB.prepare(`
      SELECT id, referencia, checkout_id,
             status, valor_total
      FROM pedidos
      WHERE id = ?
      LIMIT 1
    `).bind(pedidoId).first();
  } catch {
    return responder({
      erro: 'Falha ao consultar pedido'
    }, 503);
  }

  if (!pedido) {
    return responder({
      erro: 'Pedido nao encontrado'
    }, 404);
  }

  if (pedido.status === 'PAGO') {
    return responder({
      pedidoId,
      status: 'PAGO',
      jaProcessado: true,
      estoqueAlterado: false
    });
  }

  if (pedido.status !== 'PENDENTE') {
    return responder({
      erro: 'Status nao permite confirmacao'
    }, 409);
  }

  if (
    !/^CHEC_[A-Z0-9-]+$/i.test(
      pedido.checkout_id || ''
    )
  ) {
    return responder({
      erro: 'Checkout invalido'
    }, 400);
  }

  let checkout;

  try {
    checkout = await consultarPagBank(
      '/checkouts/' +
        encodeURIComponent(pedido.checkout_id),
      env.PAGBANK_TOKEN
    );
  } catch {
    return responder({
      erro: 'Falha ao consultar checkout PagBank'
    }, 502);
  }

  if (
    checkout.id !== pedido.checkout_id ||
    checkout.reference_id !== pedido.referencia
  ) {
    return responder({
      erro: 'Checkout nao corresponde ao pedido'
    }, 409);
  }

  const ordens = Array.isArray(checkout.orders)
    ? checkout.orders
    : [];

  if (ordens.length === 0) {
    return responder({
      erro: 'Checkout sem ordens'
    }, 409);
  }

  const cobrancasPagas = [];

  for (const resumo of ordens) {
    if (
      !/^ORDE_[A-Z0-9-]+$/i.test(
        resumo?.id || ''
      )
    ) {
      return responder({
        erro: 'Identificador de ordem invalido'
      }, 409);
    }

    let ordem;

    try {
      ordem = await consultarPagBank(
        '/orders/' +
          encodeURIComponent(resumo.id),
        env.PAGBANK_TOKEN
      );
    } catch {
      return responder({
        erro: 'Falha ao consultar ordem PagBank'
      }, 502);
    }

    if (ordem.id !== resumo.id) {
      return responder({
        erro: 'Identificador da ordem divergente'
      }, 409);
    }

    const cobrancas = Array.isArray(ordem.charges)
      ? ordem.charges
      : [];

    for (const cobranca of cobrancas) {
      if (cobranca.status !== 'PAID') {
        continue;
      }

      cobrancasPagas.push({
        ordemId: ordem.id,
        referenciaOrdem: ordem.reference_id,
        cobrancaId: cobranca.id,
        valor: cobranca.amount?.value,
        moeda: cobranca.amount?.currency
      });
    }
  }

  if (cobrancasPagas.length === 0) {
    return responder({
      pedidoId,
      status: 'PENDENTE',
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem: 'Pagamento ainda nao confirmado'
    }, 409);
  }

  if (cobrancasPagas.length !== 1) {
    return responder({
      erro: 'Multiplas cobrancas pagas',
      mensagem: 'Revisao manual necessaria'
    }, 409);
  }

  const pagamento = cobrancasPagas[0];

  if (
    pagamento.referenciaOrdem !==
      pedido.referencia ||
    !/^CHAR_[A-Z0-9-]+$/i.test(
      pagamento.cobrancaId || ''
    ) ||
    !Number.isSafeInteger(pagamento.valor) ||
    pagamento.valor !== pedido.valor_total ||
    (pagamento.moeda &&
      pagamento.moeda !== 'BRL')
  ) {
    return responder({
      erro: 'Dados do pagamento nao conferem'
    }, 409);
  }

  let itens;

  try {
    const resultado = await env.DB.prepare(`
      SELECT
        produto_id,
        tamanho,
        SUM(quantidade) AS quantidade,
        SUM(
          quantidade * preco_unitario
        ) AS subtotal
      FROM pedido_itens
      WHERE pedido_id = ?
      GROUP BY produto_id, tamanho
    `).bind(pedidoId).all();

    itens = resultado.results || [];
  } catch {
    return responder({
      erro: 'Falha ao consultar itens'
    }, 503);
  }

  if (
    itens.length === 0 ||
    itens.some(item =>
      !Number.isSafeInteger(item.quantidade) ||
      item.quantidade < 1 ||
      !Number.isSafeInteger(item.subtotal) ||
      item.subtotal < 1
    )
  ) {
    return responder({
      erro: 'Itens invalidos'
    }, 409);
  }

  const totalItens = itens.reduce(
    (total, item) => total + item.subtotal,
    0
  );

  if (totalItens !== pedido.valor_total) {
    return responder({
      erro: 'Valor dos itens divergente'
    }, 409);
  }

  /*
   * Transacao atomica:
   *
   * 1. Atualiza o pedido somente se PENDENTE.
   * 2. Registra a cobranca com UNIQUE.
   * 3. Desconta o estoque.
   *
   * Se houver concorrencia, estoque insuficiente,
   * cobranca duplicada ou registro inexistente,
   * uma restricao SQL provoca rollback do batch.
   *
   * O INSERT no estoque usa quantidade negativa
   * intencionalmente: se o registro nao existir,
   * o CHECK(quantidade >= 0) impede sua criacao.
   */

  const comandos = [
    env.DB.prepare(`
      UPDATE pedidos
      SET
        status = CASE
          WHEN status = 'PENDENTE'
          THEN 'PAGO'
          ELSE NULL
        END,
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(pedidoId),

    env.DB.prepare(`
      INSERT INTO pagamentos_processados
      (
        pedido_id,
        ordem_pagbank,
        cobranca_pagbank,
        valor
      )
      VALUES (?, ?, ?, ?)
    `).bind(
      pedidoId,
      pagamento.ordemId,
      pagamento.cobrancaId,
      pagamento.valor
    )
  ];

  for (const item of itens) {
    comandos.push(
      env.DB.prepare(`
        INSERT INTO estoque
        (
          produto_id,
          tamanho,
          quantidade
        )
        VALUES (?, ?, ?)
        ON CONFLICT(produto_id, tamanho)
        DO UPDATE SET
          quantidade =
            estoque.quantidade + excluded.quantidade,
          atualizado_em = CURRENT_TIMESTAMP
      `).bind(
        item.produto_id,
        item.tamanho,
        -item.quantidade
      )
    );
  }

  try {
    await env.DB.batch(comandos);
  } catch (erro) {
    console.error('CONFIRMACAO FALHOU', {
      pedidoId,
      erro: erro instanceof Error
        ? erro.message
        : 'Erro desconhecido'
    });

    return responder({
      erro: 'Nao foi possivel confirmar o pedido',
      pedidoId,
      mensagem:
        'Nenhuma alteracao parcial deve ser aplicada. Consulte o D1 antes de repetir.'
    }, 409);
  }

  return responder({
    ambiente: 'SANDBOX',
    pedidoId,
    referencia: pedido.referencia,
    status: 'PAGO',
    pagamentoConfirmado: true,
    estoqueAlterado: true,
    ordemId: pagamento.ordemId,
    cobrancaId: pagamento.cobrancaId,
    valorPago: pagamento.valor,
    mensagem:
      'Pagamento confirmado e estoque atualizado'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
