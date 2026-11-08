
/*
 * URBAN KICKS
 * CONFIRMACAO DE PAGAMENTO
 *
 * PagBank Sandbox + Cloudflare Pages + D1
 *
 * Funcoes:
 * - Autenticacao administrativa
 * - Consulta real ao PagBank Sandbox
 * - Validacao do checkout e das ordens
 * - Identificacao de cobrancas pagas
 * - Registro de cobrancas duplicadas
 * - Confirmacao unica do pedido
 * - Baixa unica do estoque
 * - Transacao atomica no D1
 *
 * ATENCAO:
 * Esta versao utiliza exclusivamente o Sandbox.
 * Cobrancas duplicadas sao sinalizadas para revisao.
 * Nenhum estorno e realizado automaticamente.
 */

const API = "https://sandbox.api.pagseguro.com";

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function compararSeguro(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
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

function identificadorValido(valor, prefixo) {
  if (typeof valor !== "string") {
    return false;
  }

  const padrao = new RegExp(
    "^" + prefixo + "_[A-F0-9-]{36}$",
    "i"
  );

  return padrao.test(valor);
}

async function consultarPagBank(caminho, token) {
  const resposta = await fetch(API + caminho, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!resposta.ok) {
    throw new Error(
      "PagBank retornou HTTP " + resposta.status
    );
  }

  return resposta.json();
}

async function buscarPedido(DB, pedidoId) {
  return DB.prepare(`
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
}

async function buscarItens(DB, pedidoId) {
  const resultado = await DB.prepare(`
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

  return resultado.results || [];
}

function validarItens(itens, valorTotal) {
  if (!Array.isArray(itens) || itens.length === 0) {
    return false;
  }

  let total = 0;

  for (const item of itens) {
    if (
      !Number.isSafeInteger(item.produto_id) ||
      !Number.isSafeInteger(item.quantidade) ||
      item.quantidade < 1 ||
      !Number.isSafeInteger(item.subtotal) ||
      item.subtotal < 1 ||
      (
        typeof item.tamanho !== "string" &&
        typeof item.tamanho !== "number"
      )
    ) {
      return false;
    }

    total += item.subtotal;
  }

  return Number.isSafeInteger(total) &&
    total === valorTotal;
}

async function consultarCobrancas(
  checkout,
  pedido,
  token
) {
  const ordens = Array.isArray(checkout.orders)
    ? checkout.orders
    : [];

  if (ordens.length === 0) {
    throw new Error("Checkout sem ordens");
  }

  const ordensVistas = new Set();
  const cobrancasVistas = new Set();
  const cobrancasPagas = [];

  for (const resumo of ordens) {
    const ordemId = resumo?.id;

    if (
      !identificadorValido(ordemId, "ORDE") ||
      ordensVistas.has(ordemId)
    ) {
      throw new Error(
        "Ordem invalida ou repetida"
      );
    }

    ordensVistas.add(ordemId);

    const ordem = await consultarPagBank(
      "/orders/" + encodeURIComponent(ordemId),
      token
    );

    if (
      ordem.id !== ordemId ||
      ordem.reference_id !== pedido.referencia
    ) {
      throw new Error(
        "Ordem nao corresponde ao pedido"
      );
    }

    const cobrancas = Array.isArray(ordem.charges)
      ? ordem.charges
      : [];

    for (const cobranca of cobrancas) {
      if (cobranca.status !== "PAID") {
        continue;
      }

      const cobrancaId = cobranca.id;
      const valor = cobranca.amount?.value;
      const moeda = cobranca.amount?.currency;

      if (
        !identificadorValido(cobrancaId, "CHAR") ||
        cobrancasVistas.has(cobrancaId)
      ) {
        throw new Error(
          "Cobranca invalida ou repetida"
        );
      }

      if (
        !Number.isSafeInteger(valor) ||
        valor !== pedido.valor_total ||
        (moeda && moeda !== "BRL")
      ) {
        throw new Error(
          "Valor ou moeda divergente"
        );
      }

      if (
        typeof cobranca.paid_at !== "string" ||
        !Number.isFinite(
          Date.parse(cobranca.paid_at)
        )
      ) {
        throw new Error(
          "Data de pagamento invalida"
        );
      }

      cobrancasVistas.add(cobrancaId);

      cobrancasPagas.push({
        ordemId,
        cobrancaId,
        valor,
        metodo:
          cobranca.payment_method?.type || null,
        pagoEm: cobranca.paid_at
      });
    }
  }

  cobrancasPagas.sort((a, b) => {
    const diferenca =
      Date.parse(a.pagoEm) -
      Date.parse(b.pagoEm);

    if (diferenca !== 0) {
      return diferenca;
    }

    return a.cobrancaId.localeCompare(
      b.cobrancaId
    );
  });

  return cobrancasPagas;
}

function prepararTransacao(
  DB,
  pedido,
  itens,
  cobrancasPagas
) {
  const principal = cobrancasPagas[0];

  /*
   * Todas as instrucoes deste batch precisam
   * ter sucesso para a transacao ser confirmada.
   *
   * O UPDATE usa NOT NULL como protecao contra
   * uma segunda confirmacao concorrente.
   *
   * pagamentos_processados possui UNIQUE
   * para pedido_id e cobranca_pagbank.
   */

  const comandos = [];

  comandos.push(
    DB.prepare(`
      UPDATE pedidos
      SET
        status = CASE
          WHEN status = 'PENDENTE'
          THEN 'PAGO'
          ELSE NULL
        END,
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(pedido.id)
  );

  comandos.push(
    DB.prepare(`
      INSERT INTO pagamentos_processados
      (
        pedido_id,
        ordem_pagbank,
        cobranca_pagbank,
        valor
      )
      VALUES (?, ?, ?, ?)
    `).bind(
      pedido.id,
      principal.ordemId,
      principal.cobrancaId,
      principal.valor
    )
  );

  /*
   * Registra todas as cobrancas.
   * A primeira paga e a principal.
   * As demais ficam como duplicadas.
   */

  for (const cobranca of cobrancasPagas) {
    const conciliacao =
      cobranca.cobrancaId === principal.cobrancaId
        ? "PRINCIPAL"
        : "DUPLICADA";

    comandos.push(
      DB.prepare(`
        INSERT INTO cobrancas_pagbank
        (
          pedido_id,
          ordem_pagbank,
          cobranca_pagbank,
          valor,
          status,
          metodo,
          conciliacao
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        pedido.id,
        cobranca.ordemId,
        cobranca.cobrancaId,
        cobranca.valor,
        "PAID",
        cobranca.metodo,
        conciliacao
      )
    );
  }

  /*
   * Baixa o estoque.
   *
   * Se a combinacao produto/tamanho nao existir,
   * o INSERT tentara criar quantidade negativa.
   * O CHECK(quantidade >= 0) devera impedir.
   *
   * Se o estoque for insuficiente, o mesmo CHECK
   * devera provocar rollback do batch.
   */

  for (const item of itens) {
    comandos.push(
      DB.prepare(`
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
            estoque.quantidade +
            excluded.quantidade,
          atualizado_em = CURRENT_TIMESTAMP
      `).bind(
        item.produto_id,
        item.tamanho,
        -item.quantidade
      )
    );
  }

  return {
    comandos,
    principal
  };
}

export async function onRequestPost({
  request,
  env
}) {
  /*
   * 1. Verificar configuracao.
   */

  if (
    !env.DB ||
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  /*
   * 2. Autenticacao administrativa.
   */

  const chave = request.headers.get(
    "x-admin-key"
  );

  if (
    !compararSeguro(
      chave,
      env.CONSULTA_ADMIN_KEY
    )
  ) {
    return responder({
      erro: "Nao autorizado"
    }, 401);
  }

  /*
   * 3. Ler JSON.
   */

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return responder({
      erro: "JSON invalido"
    }, 400);
  }

  const pedidoId = entrada?.pedidoId;

  if (
    !Number.isSafeInteger(pedidoId) ||
    pedidoId < 1
  ) {
    return responder({
      erro: "Pedido invalido"
    }, 400);
  }

  /*
   * 4. Buscar pedido local.
   */

  let pedido;

  try {
    pedido = await buscarPedido(
      env.DB,
      pedidoId
    );
  } catch {
    return responder({
      erro: "Falha ao consultar pedido"
    }, 503);
  }

  if (!pedido) {
    return responder({
      erro: "Pedido nao encontrado"
    }, 404);
  }

  /*
   * 5. Verificar status.
   */

  if (pedido.status === "PAGO") {
    return responder({
      ambiente: "SANDBOX",
      pedidoId,
      status: "PAGO",
      jaProcessado: true,
      pagamentoConfirmado: true,
      estoqueAlterado: false,
      mensagem:
        "Pedido ja confirmado anteriormente"
    });
  }

  if (pedido.status !== "PENDENTE") {
    return responder({
      erro: "Status nao permite confirmacao"
    }, 409);
  }

  /*
   * 6. Validar dados locais.
   */

  if (
    !identificadorValido(
      pedido.checkout_id,
      "CHEC"
    ) ||
    typeof pedido.referencia !== "string" ||
    !Number.isSafeInteger(
      pedido.valor_total
    ) ||
    pedido.valor_total <= 0
  ) {
    return responder({
      erro: "Dados locais invalidos"
    }, 409);
  }

  /*
   * 7. Consultar checkout no PagBank.
   */

  let checkout;

  try {
    checkout = await consultarPagBank(
      "/checkouts/" +
        encodeURIComponent(
          pedido.checkout_id
        ),
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    console.error(
      "Falha no checkout",
      erro
    );

    return responder({
      erro:
        "Falha ao consultar checkout PagBank"
    }, 502);
  }

  /*
   * 8. Conferir checkout.
   */

  if (
    checkout.id !== pedido.checkout_id ||
    checkout.reference_id !==
      pedido.referencia
  ) {
    return responder({
      erro:
        "Checkout nao corresponde ao pedido"
    }, 409);
  }

  /*
   * 9. Consultar todas as ordens
   * e identificar cobrancas pagas.
   */

  let cobrancasPagas;

  try {
    cobrancasPagas =
      await consultarCobrancas(
        checkout,
        pedido,
        env.PAGBANK_TOKEN
      );
  } catch (erro) {
    console.error(
      "Falha na conciliacao",
      erro
    );

    return responder({
      erro:
        "Nao foi possivel validar as cobrancas",
      mensagem:
        "Revisao necessaria antes da confirmacao"
    }, 409);
  }

  /*
   * 10. Verificar se houve pagamento.
   */

  if (cobrancasPagas.length === 0) {
    return responder({
      ambiente: "SANDBOX",
      pedidoId,
      status: "PENDENTE",
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem:
        "Nenhuma cobranca paga encontrada"
    }, 409);
  }

  /*
   * 11. Buscar itens do pedido.
   */

  let itens;

  try {
    itens = await buscarItens(
      env.DB,
      pedidoId
    );
  } catch {
    return responder({
      erro:
        "Falha ao consultar itens do pedido"
    }, 503);
  }

  /*
   * 12. Validar total dos itens.
   */

  if (
    !validarItens(
      itens,
      pedido.valor_total
    )
  ) {
    return responder({
      erro:
        "Itens invalidos ou valor divergente"
    }, 409);
  }

  /*
   * 13. Preparar transacao.
   */

  const {
    comandos,
    principal
  } = prepararTransacao(
    env.DB,
    pedido,
    itens,
    cobrancasPagas
  );

  /*
   * 14. Executar transacao atomica.
   */

  try {
    await env.DB.batch(comandos);
  } catch (erro) {
    console.error(
      "CONFIRMACAO FALHOU",
      {
        pedidoId,
        erro:
          erro instanceof Error
            ? erro.message
            : "Erro desconhecido"
      }
    );

    return responder({
      erro:
        "Nao foi possivel confirmar o pedido",
      pedidoId,
      mensagem:
        "Transacao nao concluida. Verifique o D1 antes de repetir."
    }, 409);
  }

  /*
   * 15. Resposta de sucesso.
   */

  return responder({
    ambiente: "SANDBOX",
    pedidoId,
    referencia: pedido.referencia,
    status: "PAGO",
    pagamentoConfirmado: true,
    estoqueAlterado: true,
    ordemId: principal.ordemId,
    cobrancaId: principal.cobrancaId,
    valorPago: principal.valor,
    quantidadeCobrancas:
      cobrancasPagas.length,
    cobrancasDuplicadas:
      cobrancasPagas.length - 1,
    revisaoNecessaria:
      cobrancasPagas.length > 1,
    mensagem:
      "Pedido confirmado uma vez. Cobrancas excedentes registradas para revisao."
  });
}

export function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido"
  }, 405);
}
