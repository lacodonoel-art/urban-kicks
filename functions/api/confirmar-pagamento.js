
/*
 * URBAN KICKS
 * CONFIRMACAO SEGURA DE PAGAMENTOS
 *
 * Ambientes:
 * - SANDBOX
 * - PRODUCAO
 *
 * Cloudflare Pages Functions + D1
 *
 * POST /api/confirmar-pagamento
 * Header: x-admin-key
 *
 * Consulta:
 * {"pedidoId":17}
 *
 * Revisao de multiplas cobrancas:
 * {"pedidoId":17,"autorizarConfirmacao":true}
 */

const APIS = {
  SANDBOX: "https://sandbox.api.pagseguro.com",
  PRODUCAO: "https://api.pagseguro.com"
};

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function chaveIgual(a, b) {
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

function configuracaoAmbiente(env, ambiente) {
  if (ambiente === "SANDBOX") {
    return {
      api: APIS.SANDBOX,
      token: env.PAGBANK_TOKEN
    };
  }

  if (ambiente === "PRODUCAO") {
    return {
      api: APIS.PRODUCAO,
      token: env.PAGBANK_TOKEN_PRODUCAO
    };
  }

  throw new Error("Ambiente do pedido invalido");
}

async function pagbank(caminho, token, api) {
  const resposta = await fetch(api + caminho, {
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

async function buscarCobrancas(
  checkout,
  pedido,
  token,
  api
) {
  if (
    !Array.isArray(checkout.orders) ||
    checkout.orders.length === 0
  ) {
    throw new Error("Checkout sem ordens");
  }

  const ordensVistas = new Set();
  const idsVistos = new Set();
  const pagas = [];

  for (const resumo of checkout.orders) {
    const ordemId = resumo?.id;

    if (
      typeof ordemId !== "string" ||
      !/^ORDE_[A-F0-9-]{36}$/i.test(ordemId) ||
      ordensVistas.has(ordemId)
    ) {
      throw new Error(
        "Ordem invalida ou repetida"
      );
    }

    ordensVistas.add(ordemId);

    const ordem = await pagbank(
      "/orders/" + encodeURIComponent(ordemId),
      token,
      api
    );

    if (
      ordem.id !== ordemId ||
      ordem.reference_id !== pedido.referencia
    ) {
      throw new Error(
        "Ordem nao corresponde ao pedido"
      );
    }

    if (!Array.isArray(ordem.charges)) {
      throw new Error(
        "Lista de cobrancas invalida"
      );
    }

    for (const c of ordem.charges) {
      if (c.status !== "PAID") {
        continue;
      }

      if (
        typeof c.id !== "string" ||
        !/^CHAR_[A-F0-9-]{36}$/i.test(c.id) ||
        idsVistos.has(c.id)
      ) {
        throw new Error(
          "Cobranca invalida ou repetida"
        );
      }

      if (
        c.amount?.value !== pedido.valor_total ||
        (
          c.amount?.currency &&
          c.amount.currency !== "BRL"
        )
      ) {
        throw new Error(
          "Valor ou moeda divergente"
        );
      }

      idsVistos.add(c.id);

      pagas.push({
        ordemId,
        cobrancaId: c.id,
        valor: c.amount.value,
        metodo: c.payment_method?.type || null,
        pagoEm: c.paid_at || null
      });
    }
  }

  pagas.sort((a, b) => {
    const ta = Date.parse(a.pagoEm || "");
    const tb = Date.parse(b.pagoEm || "");

    return (
      (
        Number.isFinite(ta)
          ? ta
          : Infinity
      ) -
      (
        Number.isFinite(tb)
          ? tb
          : Infinity
      )
    ) || a.cobrancaId.localeCompare(b.cobrancaId);
  });

  return pagas;
}

async function buscarItens(
  DB,
  pedidoId,
  valorTotal
) {
  const resultado = await DB.prepare(`
    SELECT
      produto_id,
      CAST(tamanho AS TEXT) AS tamanho,
      SUM(quantidade) AS quantidade,
      SUM(quantidade * preco_unitario) AS subtotal
    FROM pedido_itens
    WHERE pedido_id = ?
    GROUP BY
      produto_id,
      CAST(tamanho AS TEXT)
  `).bind(pedidoId).all();

  const itens = resultado.results || [];

  if (!itens.length) {
    throw new Error("Pedido sem itens");
  }

  let total = 0;

  for (const item of itens) {
    const tamanho = Number(item.tamanho);

    if (
      !Number.isSafeInteger(item.produto_id) ||
      item.produto_id < 1 ||
      !Number.isSafeInteger(tamanho) ||
      tamanho < 34 ||
      tamanho > 44 ||
      !Number.isSafeInteger(item.quantidade) ||
      item.quantidade < 1 ||
      !Number.isSafeInteger(item.subtotal) ||
      item.subtotal < 1
    ) {
      throw new Error(
        "Item ou tamanho invalido"
      );
    }

    total += item.subtotal;
  }

  if (total !== valorTotal) {
    throw new Error(
      "Total dos itens divergente"
    );
  }

  return itens;
}

async function registrarAuditoria(
  DB,
  pedidoId,
  cobrancas
) {
  const principal = cobrancas[0];
  const comandos = [];

  for (const c of cobrancas) {
    const conciliacao =
      c.cobrancaId === principal.cobrancaId
        ? "PRINCIPAL"
        : "REVISAO_MANUAL";

    comandos.push(DB.prepare(`
      INSERT INTO cobrancas_pagbank (
        pedido_id,
        ordem_pagbank,
        cobranca_pagbank,
        valor,
        status,
        metodo,
        conciliacao
      )
      VALUES (?, ?, ?, ?, 'PAID', ?, ?)
      ON CONFLICT(cobranca_pagbank)
      DO NOTHING
    `).bind(
      pedidoId,
      c.ordemId,
      c.cobrancaId,
      c.valor,
      c.metodo,
      conciliacao
    ));
  }

  await DB.batch(comandos);

  const encontrados = await DB.prepare(`
    SELECT
      ordem_pagbank,
      cobranca_pagbank,
      valor,
      status,
      conciliacao
    FROM cobrancas_pagbank
    WHERE pedido_id = ?
  `).bind(pedidoId).all();

  const mapa = new Map(
    (encontrados.results || []).map(
      c => [c.cobranca_pagbank, c]
    )
  );

  for (const c of cobrancas) {
    const salvo = mapa.get(c.cobrancaId);

    if (
      !salvo ||
      salvo.ordem_pagbank !== c.ordemId ||
      salvo.valor !== c.valor ||
      salvo.status !== "PAID"
    ) {
      throw new Error(
        "Auditoria inconsistente"
      );
    }
  }

  return mapa;
}

function prepararConfirmacao(
  DB,
  pedido,
  itens,
  principal
) {
  const comandos = [];

  // Impede confirmacao duplicada.
  comandos.push(DB.prepare(`
    UPDATE pedidos
    SET
      status = CASE
        WHEN status = 'PENDENTE'
        THEN 'PAGO'
        ELSE NULL
      END,
      atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?
      AND ambiente = ?
  `).bind(
    pedido.id,
    pedido.ambiente
  ));

  // UNIQUE(pedido_id) impede novo pagamento
  // processado para o mesmo pedido.
  comandos.push(DB.prepare(`
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
  ));

  // Desconto por produto e tamanho.
  for (const item of itens) {
    comandos.push(DB.prepare(`
      UPDATE estoque
      SET
        quantidade = CASE
          WHEN quantidade >= ?
          THEN quantidade - ?
          ELSE NULL
        END,
        atualizado_em = CURRENT_TIMESTAMP
      WHERE produto_id = ?
        AND CAST(tamanho AS TEXT) = ?
    `).bind(
      item.quantidade,
      item.quantidade,
      item.produto_id,
      item.tamanho
    ));

    // Impede confirmacao se nao existir
    // registro do produto/tamanho no estoque.
    comandos.push(DB.prepare(`
      INSERT INTO estoque (
        produto_id,
        tamanho,
        quantidade
      )
      SELECT NULL, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM estoque
        WHERE produto_id = ?
          AND CAST(tamanho AS TEXT) = ?
      )
    `).bind(
      item.produto_id,
      item.tamanho
    ));
  }

  return comandos;
}

export async function onRequestPost({
  request,
  env
}) {
  if (
    !env.DB ||
    !env.CONSULTA_ADMIN_KEY
  ) {
    return json({
      erro: "Configuracao incompleta"
    }, 503);
  }

  if (!chaveIgual(
    request.headers.get("x-admin-key"),
    env.CONSULTA_ADMIN_KEY
  )) {
    return json({
      erro: "Nao autorizado"
    }, 401);
  }

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return json({
      erro: "JSON invalido"
    }, 400);
  }

  const pedidoId = entrada?.pedidoId;
  const autorizar =
    entrada?.autorizarConfirmacao === true;

  if (
    !Number.isSafeInteger(pedidoId) ||
    pedidoId < 1
  ) {
    return json({
      erro: "Pedido invalido"
    }, 400);
  }

  try {
    const pedido = await env.DB.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total,
        ambiente
      FROM pedidos
      WHERE id = ?
    `).bind(pedidoId).first();

    if (!pedido) {
      return json({
        erro: "Pedido nao encontrado"
      }, 404);
    }

    if (
      pedido.ambiente !== "SANDBOX" &&
      pedido.ambiente !== "PRODUCAO"
    ) {
      return json({
        erro: "Ambiente invalido"
      }, 409);
    }

    if (pedido.status === "PAGO") {
      return json({
        ambiente: pedido.ambiente,
        pedidoId,
        status: "PAGO",
        jaProcessado: true,
        estoqueAlterado: false,
        mensagem:
          "Pedido ja confirmado anteriormente"
      });
    }

    if (pedido.status !== "PENDENTE") {
      return json({
        erro:
          "Status nao permite confirmacao",
        status: pedido.status
      }, 409);
    }

    if (
      !/^CHEC_[A-F0-9-]{36}$/i.test(
        pedido.checkout_id || ""
      ) ||
      typeof pedido.referencia !== "string" ||
      !Number.isSafeInteger(
        pedido.valor_total
      ) ||
      pedido.valor_total <= 0
    ) {
      return json({
        erro: "Dados locais invalidos"
      }, 409);
    }

    const configuracao =
      configuracaoAmbiente(
        env,
        pedido.ambiente
      );

    if (!configuracao.token) {
      return json({
        erro:
          "Token do ambiente nao configurado"
      }, 503);
    }

    const checkout = await pagbank(
      "/checkouts/" +
        encodeURIComponent(
          pedido.checkout_id
        ),
      configuracao.token,
      configuracao.api
    );

    if (
      checkout.id !== pedido.checkout_id ||
      checkout.reference_id !==
        pedido.referencia
    ) {
      return json({
        erro: "Checkout divergente"
      }, 409);
    }

    const cobrancas =
      await buscarCobrancas(
        checkout,
        pedido,
        configuracao.token,
        configuracao.api
      );

    if (!cobrancas.length) {
      return json({
        ambiente: pedido.ambiente,
        pedidoId,
        status: "PENDENTE",
        pagamentoConfirmado: false,
        estoqueAlterado: false,
        mensagem:
          "Nenhuma cobranca paga"
      }, 409);
    }

    const itens = await buscarItens(
      env.DB,
      pedidoId,
      pedido.valor_total
    );

    const auditoria =
      await registrarAuditoria(
        env.DB,
        pedidoId,
        cobrancas
      );

    const multiplas =
      cobrancas.length > 1;

    // Multiplas cobrancas exigem
    // autorizacao administrativa.
    if (multiplas && !autorizar) {
      return json({
        ambiente: pedido.ambiente,
        pedidoId,
        status: "PENDENTE",
        revisaoManual: true,
        quantidadeCobrancas:
          cobrancas.length,
        cobrancasAdicionais:
          cobrancas.length - 1,
        auditoriaRegistrada: true,
        pagamentoConfirmado: false,
        estoqueAlterado: false,
        mensagem:
          "Multiplas cobrancas registradas. " +
          "Confirmacao administrativa necessaria."
      }, 409);
    }

    if (multiplas && autorizar) {
      for (const c of cobrancas) {
        if (!auditoria.has(c.cobrancaId)) {
          return json({
            erro: "Auditoria incompleta"
          }, 409);
        }
      }
    }

    const principal = cobrancas[0];

    const comandos =
      prepararConfirmacao(
        env.DB,
        pedido,
        itens,
        principal
      );

    // Transacao atomica no D1.
    await env.DB.batch(comandos);

    return json({
      ambiente: pedido.ambiente,
      pedidoId,
      referencia: pedido.referencia,
      status: "PAGO",
      pagamentoConfirmado: true,
      estoqueAlterado: true,
      quantidadeCobrancas:
        cobrancas.length,
      cobrancasAdicionais:
        cobrancas.length - 1,
      revisaoNecessaria: multiplas,
      produtosAtualizados:
        itens.map(i => ({
          produtoId: i.produto_id,
          tamanho: i.tamanho,
          quantidadeDescontada:
            i.quantidade
        })),
      mensagem:
        "Pedido confirmado uma unica vez. " +
        "Estoque atualizado por produto e tamanho."
    });

  } catch (erro) {
    console.error(
      "ERRO CONFIRMACAO PAGAMENTO",
      erro instanceof Error
        ? erro.message
        : String(erro)
    );

    return json({
      erro:
        "Nao foi possivel concluir a operacao",
      pedidoId,
      mensagem:
        "Verifique o D1 antes de repetir a confirmacao."
    }, 409);
  }
}

export function onRequestGet() {
  return json({
    erro:
      "Metodo nao permitido. Utilize POST."
  }, 405);
}
