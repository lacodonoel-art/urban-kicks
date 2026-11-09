
/*
 * URBAN KICKS
 * Confirmacao de pagamento - PagBank Sandbox
 * Cloudflare Pages Functions + D1
 *
 * Acesso: x-admin-key
 * Entrada: { "pedidoId": 2 }
 *
 * Registra todas as cobrancas pagas.
 * Marca uma como PRINCIPAL e as demais como DUPLICADA.
 * Confirma o pedido uma unica vez.
 * Desconta estoque em transacao atomica.
 * Nao realiza estornos.
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
  return (
    typeof valor === "string" &&
    new RegExp(
      "^" + prefixo + "_[A-F0-9-]{36}$",
      "i"
    ).test(valor)
  );
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
      "PagBank HTTP " + resposta.status
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
      SUM(quantidade * preco_unitario) AS subtotal
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
      typeof item.tamanho !== "string"
    ) {
      return false;
    }

    total += item.subtotal;
  }

  return (
    Number.isSafeInteger(total) &&
    total === valorTotal
  );
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
  const pagas = [];

  for (const resumo of ordens) {
    const ordemId = resumo?.id;

    if (
      !identificadorValido(ordemId, "ORDE") ||
      ordensVistas.has(ordemId)
    ) {
      throw new Error("Ordem invalida ou repetida");
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

      if (
        typeof cobranca.paid_at !== "string" ||
        !Number.isFinite(Date.parse(cobranca.paid_at))
      ) {
        throw new Error(
          "Data de pagamento invalida"
        );
      }

      cobrancasVistas.add(id);

      pagas.push({
        ordemId,
        cobrancaId: id,
        valor,
        metodo:
          cobranca.payment_method?.type || null,
        pagoEm: cobranca.paid_at
      });
    }
  }

  pagas.sort((a, b) => {
    const diferenca =
      Date.parse(a.pagoEm) - Date.parse(b.pagoEm);

    return diferenca ||
      a.cobrancaId.localeCompare(b.cobrancaId);
  });

  return pagas;
}

/*
 * Transacao D1.
 *
 * Todas as instrucoes devem ter sucesso.
 * Se alguma gerar erro SQL, o batch faz rollback.
 *
 * O UPDATE de estoque nunca insere quantidade
 * negativa em um registro novo.
 *
 * Se o estoque nao existir ou for insuficiente,
 * uma verificacao SQL gera erro e impede a
 * confirmacao parcial.
 */

function prepararTransacao(
  DB,
  pedido,
  itens,
  cobrancasPagas
) {
  const principal = cobrancasPagas[0];
  const comandos = [];

  // 1. Confirmar apenas pedido pendente.
  // O NOT NULL impede uma segunda confirmacao.

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

  // 2. Registrar pagamento principal.
  // pedido_id e cobranca_pagbank sao UNIQUE.

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

  // 3. Registrar todas as cobrancas,
  // inclusive as duplicadas.

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

  // 4. Descontar estoque somente quando
  // houver saldo suficiente.

  for (const item of itens) {
    comandos.push(
      DB.prepare(`
        UPDATE estoque
        SET
          quantidade = quantidade - ?,
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

    /*
     * changes() verifica se o UPDATE anterior
     * modificou exatamente uma linha.
     *
     * Se nao modificou, a expressao gera NULL
     * em uma coluna NOT NULL, causando rollback.
     */

    comandos.push(
      DB.prepare(`
        INSERT INTO estoque
        (
          produto_id,
          tamanho,
          quantidade
        )
        SELECT
          NULL,
          NULL,
          NULL
        WHERE changes() <> 1
      `)
    );
  }

  return { comandos, principal };
}

export async function onRequestPost({
  request,
  env
}) {
  // Configuracao.

  if (
    !env.DB ||
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  // Autenticacao administrativa.

  const chave = request.headers.get("x-admin-key");

  if (!compararSeguro(chave, env.CONSULTA_ADMIN_KEY)) {
    return responder({
      erro: "Nao autorizado"
    }, 401);
  }

  // Entrada.

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

  // Pedido local.

  let pedido;

  try {
    pedido = await buscarPedido(env.DB, pedidoId);
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

  // Idempotencia.

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

  // Validar identificadores.

  if (
    !identificadorValido(pedido.checkout_id, "CHEC") ||
    typeof pedido.referencia !== "string" ||
    !Number.isSafeInteger(pedido.valor_total) ||
    pedido.valor_total <= 0
  ) {
    return responder({
      erro: "Dados locais invalidos"
    }, 409);
  }

  // Consultar checkout PagBank.

  let checkout;

  try {
    checkout = await consultarPagBank(
      "/checkouts/" +
        encodeURIComponent(pedido.checkout_id),
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    console.error("FALHA CHECKOUT", erro);

    return responder({
      erro: "Falha ao consultar checkout"
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

  // Consultar ordens e cobrancas.

  let cobrancasPagas;

  try {
    cobrancasPagas = await consultarCobrancas(
      checkout,
      pedido,
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    console.error("FALHA CONCILIACAO", erro);

    return responder({
      erro: "Falha ao validar cobrancas",
      mensagem: "Revisao necessaria"
    }, 409);
  }

  if (cobrancasPagas.length === 0) {
    return responder({
      pedidoId,
      status: "PENDENTE",
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem: "Nenhuma cobranca paga"
    }, 409);
  }

  // Validar itens.

  let itens;

  try {
    itens = await buscarItens(env.DB, pedidoId);
  } catch {
    return responder({
      erro: "Falha ao consultar itens"
    }, 503);
  }

  if (!validarItens(itens, pedido.valor_total)) {
    return responder({
      erro: "Itens invalidos ou valor divergente"
    }, 409);
  }

  // Preparar operacoes atomicas.

  const { comandos, principal } = prepararTransacao(
    env.DB,
    pedido,
    itens,
    cobrancasPagas
  );

  // Confirmar.

  try {
    await env.DB.batch(comandos);
  } catch (erro) {
    console.error("CONFIRMACAO FALHOU", {
      pedidoId,
      erro: erro instanceof Error
        ? erro.message
        : "Erro desconhecido"
    });

    return responder({
      erro: "Nao foi possivel confirmar o pedido",
      pedidoId,
      mensagem:
        "Transacao nao concluida. Verifique o D1 antes de repetir."
    }, 409);
  }

  // Sucesso.

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
    cobrancasDuplicadas: cobrancasPagas.length - 1,
    revisaoNecessaria: cobrancasPagas.length > 1,
    mensagem:
      "Pedido confirmado uma vez. Cobrancas excedentes registradas para revisao."
  });
}

export function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido"
  }, 405);
}
