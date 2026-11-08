
/*
 * URBAN KICKS - CONFIRMAR PAGAMENTO
 * PagBank Sandbox + Cloudflare D1
 *
 * Acesso exclusivo com CONSULTA_ADMIN_KEY.
 * Confere checkout, ordem, cobranca e valor.
 * Registra pagamento e atualiza estoque.
 * Protecao contra processamento duplicado.
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
  if (!a || !b || a.length !== b.length) {
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
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!resposta.ok) {
    throw new Error(
      'Consulta PagBank HTTP ' + resposta.status
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
    return responder({ erro: 'Nao autorizado' }, 401);
  }

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return responder({ erro: 'JSON invalido' }, 400);
  }

  const pedidoId = entrada?.pedidoId;

  if (!Number.isSafeInteger(pedidoId) || pedidoId < 1) {
    return responder({ erro: 'Pedido invalido' }, 400);
  }

  const pedido = await env.DB.prepare(`
    SELECT id, referencia, checkout_id,
           status, valor_total
    FROM pedidos
    WHERE id = ?
    LIMIT 1
  `).bind(pedidoId).first();

  if (!pedido) {
    return responder({ erro: 'Pedido nao encontrado' }, 404);
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
      erro: 'Status do pedido nao permite confirmacao'
    }, 409);
  }

  if (!/^CHEC_[A-Z0-9-]+$/i.test(pedido.checkout_id)) {
    return responder({ erro: 'Checkout invalido' }, 400);
  }

  let checkout;

  try {
    checkout = await consultarPagBank(
      '/checkouts/' + encodeURIComponent(pedido.checkout_id),
      env.PAGBANK_TOKEN
    );
  } catch {
    return responder({
      erro: 'Falha ao consultar checkout'
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

  let pagamentoValido = null;

  for (const ordemResumo of ordens) {
    if (!/^ORDE_[A-Z0-9-]+$/i.test(ordemResumo.id || '')) {
      continue;
    }

    let ordem;

    try {
      ordem = await consultarPagBank(
        '/orders/' + encodeURIComponent(ordemResumo.id),
        env.PAGBANK_TOKEN
      );
    } catch {
      return responder({
        erro: 'Falha ao consultar ordem PagBank'
      }, 502);
    }

    if (
      ordem.id !== ordemResumo.id ||
      ordem.reference_id !== pedido.referencia
    ) {
      continue;
    }

    const cobrancas = Array.isArray(ordem.charges)
      ? ordem.charges
      : [];

    const pagas = cobrancas.filter(c =>
      c.status === 'PAID' &&
      Number.isSafeInteger(c.amount?.value) &&
      c.amount.value > 0 &&
      (!c.amount.currency ||
        c.amount.currency === 'BRL')
    );

    if (
      pagas.length === 1 &&
      pagas[0].amount.value === pedido.valor_total &&
      /^CHAR_[A-Z0-9-]+$/i.test(pagas[0].id || '')
    ) {
      if (pagamentoValido) {
        return responder({
          erro: 'Multiplas cobrancas pagas. Revisao necessaria'
        }, 409);
      }

      pagamentoValido = {
        ordemId: ordem.id,
        cobrancaId: pagas[0].id,
        valor: pagas[0].amount.value
      };
    }
  }

  if (!pagamentoValido) {
    return responder({
      pedidoId,
      status: 'PENDENTE',
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem: 'Nenhuma cobranca PAID valida encontrada'
    }, 409);
  }

  const resultadoItens = await env.DB.prepare(`
    SELECT produto_id, tamanho,
           SUM(quantidade) AS quantidade,
           SUM(quantidade * preco_unitario) AS subtotal
    FROM pedido_itens
    WHERE pedido_id = ?
    GROUP BY produto_id, tamanho
  `).bind(pedidoId).all();

  const itens = resultadoItens.results || [];

  if (
    itens.length === 0 ||
    itens.some(i =>
      !Number.isSafeInteger(i.quantidade) ||
      i.quantidade < 1
    )
  ) {
    return responder({
      erro: 'Itens do pedido invalidos'
    }, 409);
  }

  const totalItens = itens.reduce(
    (total, i) => total + i.subtotal, 0
  );

  if (totalItens !== pedido.valor_total) {
    return responder({
      erro: 'Valor dos itens nao confere'
    }, 409);
  }

  const estoque = await env.DB.prepare(`
    SELECT produto_id, tamanho, quantidade
    FROM estoque
  `).all();

  const disponivel = new Map(
    (estoque.results || []).map(e => [
      e.produto_id + '-' + e.tamanho,
      e.quantidade
    ])
  );

  for (const item of itens) {
    const chave = item.produto_id + '-' + item.tamanho;

    if ((disponivel.get(chave) ?? 0) < item.quantidade) {
      return responder({
        erro: 'Estoque insuficiente',
        produtoId: item.produto_id,
        tamanho: item.tamanho,
        estoqueAlterado: false
      }, 409);
    }
  }

  /*
   * Todas as escritas sao executadas em
   * uma unica transacao D1.
   *
   * A restricao UNIQUE impede reutilizar
   * o pedido ou a cobranca.
   *
   * A restricao CHECK do estoque impede
   * quantidade negativa e causa rollback.
   */

  const comandos = [
    env.DB.prepare(`
      INSERT INTO pagamentos_processados
      (pedido_id, ordem_pagbank, cobranca_pagbank, valor)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM pedidos
        WHERE id = ? AND status = 'PENDENTE'
      )
    `).bind(
      pedidoId,
      pagamentoValido.ordemId,
      pagamentoValido.cobrancaId,
      pagamentoValido.valor,
      pedidoId
    )
  ];

  for (const item of itens) {
    comandos.push(
      env.DB.prepare(`
        UPDATE estoque
        SET quantidade = quantidade - ?,
            atualizado_em = CURRENT_TIMESTAMP
        WHERE produto_id = ?
          AND tamanho = ?
          AND quantidade >= ?
      `).bind(
        item.quantidade,
        item.produto_id,
        item.tamanho,
        item.quantidade
      )
    );
  }

  comandos.push(
    env.DB.prepare(`
      UPDATE pedidos
      SET status = 'PAGO',
          atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDENTE'
    `).bind(pedidoId)
  );

  try {
    const resultados = await env.DB.batch(comandos);

    const alteracoes = resultados.map(
      r => r.meta?.changes ?? 0
    );

    if (alteracoes.some(n => n !== 1)) {
      /*
       * Uma alteracao inesperada exige
       * verificacao manual. O batch ja
       * foi executado neste ponto.
       */
      console.error(
        'Confirmacao: contagem inesperada',
        { pedidoId, alteracoes }
      );

      return responder({
        erro: 'Verificar consistencia do pedido',
        pedidoId
      }, 503);
    }
  } catch (erro) {
    console.error('Falha na confirmacao:', {
      pedidoId,
      mensagem: erro instanceof Error
        ? erro.message
        : 'Erro desconhecido'
    });

    return responder({
      erro: 'Falha ao processar pagamento',
      pedidoId,
      mensagem: 'Consulte o banco antes de tentar novamente'
    }, 503);
  }

  return responder({
    ambiente: 'SANDBOX',
    pedidoId,
    referencia: pedido.referencia,
    status: 'PAGO',
    pagamentoConfirmado: true,
    estoqueAlterado: true,
    ordemId: pagamentoValido.ordemId,
    cobrancaId: pagamentoValido.cobrancaId,
    valorPago: pagamentoValido.valor,
    mensagem: 'Pagamento confirmado e estoque atualizado'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
