
/*
 * URBAN KICKS
 * Confirmacao de pagamento
 *
 * PagBank Sandbox
 * Cloudflare Pages Functions
 * Cloudflare D1
 *
 * POST /api/confirmar-pagamento
 *
 * Header:
 * x-admin-key: SUA_CHAVE_ADMINISTRATIVA
 *
 * Body:
 * {
 *   "pedidoId": 2
 * }
 *
 * Recursos:
 * - Autenticacao administrativa
 * - Consulta direta ao PagBank
 * - Validacao de checkout
 * - Consulta de todas as ordens
 * - Identificacao de cobrancas pagas
 * - Registro de cobrancas adicionais
 * - Confirmacao unica do pedido
 * - Desconto atomico de estoque
 * - Protecao contra processamento repetido
 * - Rollback em erros SQL
 *
 * IMPORTANTE:
 * Cobrancas adicionais sao registradas
 * para revisao manual.
 * Este codigo nao realiza estornos.
 */

const API = "https://sandbox.api.pagseguro.com";

// ==================================================
// RESPOSTAS JSON
// ==================================================

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// ==================================================
// COMPARACAO DE CHAVE ADMINISTRATIVA
// ==================================================

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

// ==================================================
// VALIDAR IDENTIFICADORES PAGBANK
// ==================================================

function identificadorValido(valor, prefixo) {
  if (typeof valor !== "string") {
    return false;
  }

  const expressao = new RegExp(
    "^" + prefixo + "_[A-Z0-9-]+$",
    "i"
  );

  return expressao.test(valor);
}

// ==================================================
// CONSULTAR API PAGBANK
// ==================================================

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

// ==================================================
// CONSULTAR PEDIDO LOCAL
// ==================================================

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

// ==================================================
// CONSULTAR ITENS DO PEDIDO
// ==================================================

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

// ==================================================
// VALIDAR ITENS E VALOR TOTAL
// ==================================================

function validarItens(itens, valorTotal) {
  if (
    !Array.isArray(itens) ||
    itens.length === 0
  ) {
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
      typeof item.tamanho !== "string" ||
      !item.tamanho.trim()
    ) {
      return false;
    }

    total += item.subtotal;

    if (!Number.isSafeInteger(total)) {
      return false;
    }
  }

  return total === valorTotal;
}

// ==================================================
// CONSULTAR TODAS AS COBRANCAS PAGAS
// ==================================================

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
  const pagas = [];

  for (const resumo of ordens) {
    const ordemId = resumo?.id;

    if (
      !identificadorValido(ordemId, "ORDE") ||
      ordensVistas.has(ordemId)
    ) {
      throw new Error(
        "Identificador de ordem invalido ou repetido"
      );
    }

    ordensVistas.add(ordemId);

    const ordem = await consultarPagBank(
      "/orders/" + encodeURIComponent(ordemId),
      token
    );

    if (ordem.id !== ordemId) {
      throw new Error(
        "Identificador da ordem divergente"
      );
    }

    if (
      ordem.reference_id !== pedido.referencia
    ) {
      throw new Error(
        "Referencia da ordem divergente"
      );
    }

    const cobrancas = Array.isArray(ordem.charges)
      ? ordem.charges
      : [];

    for (const cobranca of cobrancas) {
      if (cobranca.status !== "PAID") {
        continue;
      }

      const id = cobranca.id;
      const valor = cobranca.amount?.value;
      const moeda = cobranca.amount?.currency;

      if (
        !identificadorValido(id, "CHAR") ||
        cobrancasVistas.has(id)
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

      cobrancasVistas.add(id);

      pagas.push({
        ordemId,
        cobrancaId: id,
        valor,
        metodo:
          cobranca.payment_method?.type || null,
        pagoEm:
          cobranca.paid_at || null
      });
    }
  }

  pagas.sort((a, b) => {
    const dataA = Date.parse(a.pagoEm || "");
    const dataB = Date.parse(b.pagoEm || "");

    const tempoA = Number.isFinite(dataA)
      ? dataA
      : Number.MAX_SAFE_INTEGER;

    const tempoB = Number.isFinite(dataB)
      ? dataB
      : Number.MAX_SAFE_INTEGER;

    return (
      tempoA - tempoB ||
      a.cobrancaId.localeCompare(b.cobrancaId)
    );
  });

  return pagas;
}

// ==================================================
// PREPARAR TRANSACAO ATOMICA D1
// ==================================================

function prepararTransacao(
  DB,
  pedido,
  itens,
  cobrancasPagas
) {
  const principal = cobrancasPagas[0];
  const comandos = [];

  // ----------------------------------------------
  // 1. CONFIRMAR PEDIDO UMA UNICA VEZ
  // ----------------------------------------------
  //
  // Se status nao for PENDENTE, atribuir NULL
  // provoca erro devido ao NOT NULL.
  //
  // Isso impede confirmacao concorrente.

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

  // ----------------------------------------------
  // 2. REGISTRAR PAGAMENTO PRINCIPAL
  // ----------------------------------------------
  //
  // A tabela possui UNIQUE em pedido_id
  // e cobranca_pagbank.
  //
  // Uma segunda tentativa provoca erro SQL.

  comandos.push(
    DB.prepare(`
      INSERT INTO pagamentos_processados (
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

  // ----------------------------------------------
  // 3. REGISTRAR TODAS AS COBRANCAS PAGAS
  // ----------------------------------------------
  //
  // A primeira sera PRINCIPAL.
  // As demais ficam como DUPLICADA.
  //
  // DUPLICADA significa cobranca adicional
  // identificada para revisao.
  //
  // Nao significa pagamento estornado.

  for (const cobranca of cobrancasPagas) {
    const conciliacao =
      cobranca.cobrancaId === principal.cobrancaId
        ? "PRINCIPAL"
        : "DUPLICADA";

    comandos.push(
      DB.prepare(`
        INSERT INTO cobrancas_pagbank (
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

  // ----------------------------------------------
  // 4. DESCONTAR ESTOQUE
  // ----------------------------------------------
  //
  // A coluna quantidade e NOT NULL.
  //
  // Se quantidade disponivel for insuficiente,
  // o UPDATE tenta gravar NULL.
  //
  // Isso gera erro SQL e rollback.
  //
  // Se o estoque nao existir, o INSERT
  // de verificacao gera erro SQL.
  //
  // Todas as instrucoes fazem parte do batch.

  for (const item of itens) {
    comandos.push(
      DB.prepare(`
        UPDATE estoque
        SET
          quantidade = CASE
            WHEN quantidade >= ?
            THEN quantidade - ?
            ELSE NULL
          END,
          atualizado_em = CURRENT_TIMESTAMP
        WHERE produto_id = ?
          AND tamanho = ?
      `).bind(
        item.quantidade,
        item.quantidade,
        item.produto_id,
        item.tamanho
      )
    );

    // Verificar existencia do registro.
    // Se nao existir, INSERT com NULL
    // viola restricoes NOT NULL.

    comandos.push(
      DB.prepare(`
        INSERT INTO estoque (
          produto_id,
          tamanho,
          quantidade
        )
        SELECT
          NULL,
          NULL,
          NULL
        WHERE NOT EXISTS (
          SELECT 1
          FROM estoque
          WHERE produto_id = ?
            AND tamanho = ?
        )
      `).bind(
        item.produto_id,
        item.tamanho
      )
    );
  }

  return {
    comandos,
    principal
  };
}

// ==================================================
// ENDPOINT POST
// ==================================================

export async function onRequestPost({
  request,
  env
}) {
  // ----------------------------------------------
  // 1. VERIFICAR CONFIGURACAO
  // ----------------------------------------------

  if (
    !env.DB ||
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  // ----------------------------------------------
  // 2. AUTENTICACAO ADMINISTRATIVA
  // ----------------------------------------------

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

  // ----------------------------------------------
  // 3. LER JSON
  // ----------------------------------------------

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

  // ----------------------------------------------
  // 4. CONSULTAR PEDIDO LOCAL
  // ----------------------------------------------

  let pedido;

  try {
    pedido = await buscarPedido(
      env.DB,
      pedidoId
    );
  } catch (erro) {
    console.error(
      "FALHA CONSULTA PEDIDO",
      erro
    );

    return responder({
      erro: "Falha ao consultar pedido"
    }, 503);
  }

  if (!pedido) {
    return responder({
      erro: "Pedido nao encontrado"
    }, 404);
  }

  // ----------------------------------------------
  // 5. PROTECAO CONTRA REPETICAO
  // ----------------------------------------------

  if (pedido.status === "PAGO") {
    return responder({
      ambiente: "SANDBOX",
      pedidoId,
      status: "PAGO",
      jaProcessado: true,
      estoqueAlterado: false,
      mensagem: "Pedido ja confirmado"
    });
  }

  if (pedido.status !== "PENDENTE") {
    return responder({
      erro: "Status nao permite confirmacao"
    }, 409);
  }

  // ----------------------------------------------
  // 6. VALIDAR DADOS LOCAIS
  // ----------------------------------------------

  if (
    !identificadorValido(
      pedido.checkout_id,
      "CHEC"
    ) ||
    typeof pedido.referencia !== "string" ||
    !pedido.referencia.trim() ||
    !Number.isSafeInteger(pedido.valor_total) ||
    pedido.valor_total <= 0
  ) {
    return responder({
      erro: "Dados locais invalidos"
    }, 409);
  }

  // ----------------------------------------------
  // 7. CONSULTAR CHECKOUT PAGBANK
  // ----------------------------------------------

  let checkout;

  try {
    checkout = await consultarPagBank(
      "/checkouts/" +
        encodeURIComponent(pedido.checkout_id),
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    console.error(
      "FALHA CHECKOUT PAGBANK",
      erro
    );

    return responder({
      erro: "Falha ao consultar checkout PagBank"
    }, 502);
  }

  if (
    checkout.id !== pedido.checkout_id ||
    checkout.reference_id !== pedido.referencia
  ) {
    return responder({
      erro: "Checkout nao corresponde ao pedido"
    }, 409);
  }

  // ----------------------------------------------
  // 8. CONSULTAR ORDENS E COBRANCAS
  // ----------------------------------------------

  let cobrancasPagas;

  try {
    cobrancasPagas = await consultarCobrancas(
      checkout,
      pedido,
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    console.error(
      "FALHA CONCILIACAO PAGBANK",
      erro
    );

    return responder({
      erro: "Falha ao validar cobrancas",
      mensagem: "Revisao manual necessaria"
    }, 409);
  }

  // ----------------------------------------------
  // 9. VERIFICAR PAGAMENTO
  // ----------------------------------------------

  if (cobrancasPagas.length === 0) {
    return responder({
      ambiente: "SANDBOX",
      pedidoId,
      status: "PENDENTE",
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem: "Nenhuma cobranca paga"
    }, 409);
  }

  // ----------------------------------------------
  // 10. CONSULTAR ITENS
  // ----------------------------------------------

  let itens;

  try {
    itens = await buscarItens(
      env.DB,
      pedidoId
    );
  } catch (erro) {
    console.error(
      "FALHA CONSULTA ITENS",
      erro
    );

    return responder({
      erro: "Falha ao consultar itens"
    }, 503);
  }

  if (
    !validarItens(
      itens,
      pedido.valor_total
    )
  ) {
    return responder({
      erro: "Itens invalidos ou valor divergente"
    }, 409);
  }

  // ----------------------------------------------
  // 11. PREPARAR TRANSACAO
  // ----------------------------------------------

  const {
    comandos,
    principal
  } = prepararTransacao(
    env.DB,
    pedido,
    itens,
    cobrancasPagas
  );

  // ----------------------------------------------
  // 12. EXECUTAR TRANSACAO ATOMICA
  // ----------------------------------------------

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
      erro: "Nao foi possivel confirmar o pedido",
      pedidoId,
      mensagem:
        "Transacao nao concluida. Verifique o D1 antes de repetir."
    }, 409);
  }

  // ----------------------------------------------
  // 13. RETORNAR SUCESSO
  // ----------------------------------------------

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
    quantidadeCobrancas: cobrancasPagas.length,
    cobrancasDuplicadas:
      cobrancasPagas.length - 1,
    revisaoNecessaria:
      cobrancasPagas.length > 1,
    mensagem:
      "Pedido confirmado uma vez. Cobrancas adicionais registradas para revisao."
  });
}

// ==================================================
// BLOQUEAR GET
// ==================================================

export function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido"
  }, 405);
}
