
/*
 * URBAN KICKS - CONFIRMAR PAGAMENTO
 * PagBank Sandbox + Cloudflare D1
 *
 * Confirma pagamento diretamente no PagBank.
 * Valida checkout, ordem, cobranca e valor.
 * Atualiza pedido e estoque atomicamente.
 * Impede processamento duplicado.
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
    !a ||
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

  const pagamentos = [];
  let ordemNaoVerificada = false;

  for (const resumo of ordens) {
    if (
      !/^ORDE_[A-Z0-9-]+$/i.test(resumo?.id || '')
    ) {
      return responder({
        erro: 'Identificador de ordem invalido'
      }, 409);
    }

    let ordem;

    try {
      ordem = await consultarPagBank(
        '/orders/' + encodeURIComponent(resumo.id),
        env.PAGBANK_TOKEN
      );
    } catch {
      return responder({
        erro: 'Falha ao consultar ordem PagBank'
      }, 502);
    }

    if (ordem.id !== resumo.id) {
      return responder({
        erro: 'Identificador da ordem nao confere'
      }, 409);
    }

    if (ordem.reference_id !== pedido.referencia) {
      ordemNaoVerificada = true;
      continue;
    }

    const cobrancas = Array.isArray(ordem.charges)
      ? ordem.charges
      : [];

    for (const cobranca of cobrancas) {
      if (cobranca.status !== 'PAID') {
        continue;
      }

      if (
        !/^CHAR_[A-Z0-9-]+$/i.test(cobranca.id || '') ||
        !Number.isSafeInteger(cobranca.amount?.value) ||
        cobranca.amount.value <= 0 ||
        cobranca.amount.currency !== 'BRL'
      ) {
        return responder({
          erro: 'Cobranca paga com dados invalidos'
        }, 409);
      }

      pagamentos.push({
        ordemId: ordem.id,
        cobrancaId: cobranca.id,
        valor: cobranca.amount.value
      });
    }
  }

  if (ordemNaoVerificada) {
    return responder({
      erro: 'Existem ordens sem vinculo confirmado',
      pagamentoConfirmado: false
    }, 409);
  }

  if (pagamentos.length !== 1) {
    return responder({
      pedidoId,
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      quantidadePagamentos: pagamentos.length,
      mensagem: 'Pagamento requer verificacao'
    }, 409);
  }

  const pagamento = pagamentos[0];

  if (pagamento.valor !== pedido.valor_total) {
    return responder({
      erro: 'Valor pago diferente do pedido',
      pagamentoConfirmado: false
    }, 409);
  }

  let itens;

  try {
    const resultado = await env.DB.prepare(`
      SELECT
        produto_id,
        tamanho,
        SUM(quantidade) AS quantidade,
        SUM(quantidade * preco_unitario) AS subtotal
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
      erro: 'Total dos itens nao confere'
    }, 409);
  }

  /*
   * Protecao transacional:
   *
   * SQLite RAISE(ABORT) nao pode ser usado
   * diretamente em um SELECT comum.
   *
   * Usamos um gatilho temporario de validacao
   * atraves de uma tabela permanente de controle.
   *
   * Para evitar depender de gatilhos adicionais,
   * a operacao utiliza INSERT condicional com
   * restricoes UNIQUE e CHECK.
   *
   * Uma falha SQL cancela todo o DB.batch().
   */

  const comandos = [];

  /*
   * Primeiro, reservar a confirmacao.
   *
   * A tabela pagamentos_processados deve possuir:
   * - pedido_id UNIQUE
   * - cobranca_pagbank UNIQUE
   */

  comandos.push(
    env.DB.prepare(`
      INSERT INTO pagamentos_processados
        (pedido_id, ordem_pagbank,
         cobranca_pagbank, valor)
      VALUES (?, ?, ?, ?)
    `).bind(
      pedidoId,
      pagamento.ordemId,
      pagamento.cobrancaId,
      pagamento.valor
    )
  );

  /*
   * Cada desconto usa uma instrucao que falha
   * se nao houver estoque suficiente.
   *
   * A insercao em estoque com quantidade -1
   * provoca conflito com CHECK (quantidade >= 0)
   * caso a atualizacao nao encontre estoque.
   *
   * A falha reverte o batch inteiro.
   */

  for (const item of itens) {
    comandos.push(
      env.DB.prepare(`
        INSERT INTO estoque
          (produto_id, tamanho, quantidade)
        VALUES (?, ?, -1)
        ON CONFLICT(produto_id, tamanho)
        DO UPDATE SET
          quantidade = CASE
            WHEN estoque.quantidade >= ?
            THEN estoque.quantidade - ?
            ELSE -1
          END,
          atualizado_em = CURRENT_TIMESTAMP
      `).bind(
        item.produto_id,
        item.tamanho,
        item.quantidade,
        item.quantidade
      )
    );
  }

  /*
   * Confirma o pedido somente se ainda estiver
   * pendente.
   *
   * O INSERT abaixo usa a tabela de pagamentos
   * como trava de unicidade.
   */

  comandos.push(
    env.DB.prepare(`
      UPDATE pedidos
      SET status = 'PAGO',
          atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'PENDENTE'
    `).bind(pedidoId)
  );

  try {
    const resultados = await env.DB.batch(comandos);

    const alteracoes = resultados.map(
      resultado => resultado.meta?.changes ?? 0
    );

    if (alteracoes.some(n => n !== 1)) {
      console.error('Alteracoes inesperadas', {
        pedidoId,
        alteracoes
      });

      return responder({
        erro: 'Verificacao de consistencia necessaria',
        pedidoId
      }, 503);
    }
  } catch (erro) {
    console.error('Erro na transacao', {
      pedidoId,
      mensagem: erro instanceof Error
        ? erro.message
        : 'Erro desconhecido'
    });

    return responder({
      erro: 'Confirmacao nao concluida',
      pedidoId,
      pagamentoConfirmado: false,
      mensagem: 'Verifique o banco antes de repetir'
    }, 503);
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
    mensagem: 'Pagamento confirmado e estoque atualizado'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
