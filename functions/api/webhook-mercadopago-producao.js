
/*
 * URBAN KICKS
 * Webhook Mercado Pago - Producao
 * PIX + Cartao de credito
 * Cloudflare Pages Functions + D1
 *
 * IMPORTANTE:
 * Manter URBAN_KICKS_PRODUCAO_HABILITADA = NAO
 * ate concluir os testes.
 */

const MP_API = "https://api.mercadopago.com/v1/orders/";

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function centavos(valor) {
  if (
    typeof valor !== "string" &&
    typeof valor !== "number"
  ) return null;

  const texto = String(valor);

  if (!/^\d{1,12}(\.\d{1,2})?$/.test(texto)) {
    return null;
  }

  const partes = texto.split(".");
  const inteiro = Number(partes[0]);
  const decimal = Number(
    (partes[1] || "").padEnd(2, "0")
  );

  const resultado = inteiro * 100 + decimal;

  return Number.isSafeInteger(resultado)
    ? resultado
    : null;
}

function hexParaBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;

  const bytes = new Uint8Array(32);

  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(
      hex.slice(i * 2, i * 2 + 2),
      16
    );
  }

  return bytes;
}

function comparacaoConstante(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  let diferenca = 0;

  for (let i = 0; i < a.length; i++) {
    diferenca |= a[i] ^ b[i];
  }

  return diferenca === 0;
}

async function validarAssinatura(request, secret, id) {
  const assinatura = request.headers.get("x-signature");
  const requestId = request.headers.get("x-request-id");

  if (!assinatura || !requestId || !secret || !id) {
    return false;
  }

  const campos = {};

  for (const parte of assinatura.split(",")) {
    const posicao = parte.indexOf("=");

    if (posicao > 0) {
      const nome = parte.slice(0, posicao).trim();
      const valor = parte.slice(posicao + 1).trim();
      campos[nome] = valor;
    }
  }

  const ts = campos.ts;
  const v1 = campos.v1;

  if (!/^\d{10,16}$/.test(ts || "")) {
    return false;
  }

  const recebida = hexParaBytes(v1 || "");

  if (!recebida) return false;

  const numeroTs = Number(ts);
  const instante =
    ts.length <= 10 ? numeroTs * 1000 : numeroTs;

  if (
    !Number.isFinite(instante) ||
    Math.abs(Date.now() - instante) > 600000
  ) {
    return false;
  }

  const encoder = new TextEncoder();

  const chave = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const ids = [id.toLowerCase()];

  if (id !== id.toLowerCase()) {
    ids.push(id);
  }

  for (const identificador of ids) {
    const manifesto =
      "id:" + identificador +
      ";request-id:" + requestId +
      ";ts:" + ts + ";";

    const calculada = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        chave,
        encoder.encode(manifesto)
      )
    );

    if (comparacaoConstante(recebida, calculada)) {
      return true;
    }
  }

  return false;
}

function identificarMetodo(pagamento) {
  const metodo = pagamento?.payment_method || {};

  if (
    metodo.id === "pix" &&
    metodo.type === "bank_transfer"
  ) {
    return "pix";
  }

  if (
    metodo.type === "credit_card" &&
    typeof metodo.id === "string" &&
    metodo.id.length > 0
  ) {
    return "credit_card";
  }

  return null;
}

function pagamentoAprovado(ordem) {
  if (
    ordem?.status !== "processed" ||
    ordem?.status_detail !== "accredited"
  ) {
    return null;
  }

  const pagamentos = ordem?.transactions?.payments;

  if (
    !Array.isArray(pagamentos) ||
    pagamentos.length !== 1
  ) {
    return null;
  }

  const pagamento = pagamentos[0];

  if (
    pagamento.status !== "processed" ||
    pagamento.status_detail !== "accredited"
  ) {
    return null;
  }

  const metodo = identificarMetodo(pagamento);

  if (!metodo) return null;

  const id = String(pagamento.id || "");

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    return null;
  }

  return {
    id,
    metodo,
    pagamento
  };
}

async function consultarOrdem(id, token) {
  const resposta = await fetch(
    MP_API + encodeURIComponent(id),
    {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      }
    }
  );

  if (!resposta.ok) {
    console.error(
      "MP_CONSULTA_FALHOU",
      resposta.status
    );
    return null;
  }

  return resposta.json();
}

async function obterPedido(db, orderId) {
  return db.prepare(`
    SELECT
      id,
      referencia,
      checkout_id,
      status,
      valor_total,
      ambiente
    FROM pedidos
    WHERE checkout_id = ?
      AND ambiente = 'PRODUCAO'
      AND referencia LIKE 'UK-MP-%'
    LIMIT 1
  `).bind(orderId).first();
}

async function obterItens(db, pedidoId) {
  const resultado = await db.prepare(`
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

/*
 * Finalizacao transacional.
 *
 * db.batch executa as instrucoes em transacao.
 *
 * Os comandos de guarda usam uma violacao
 * intencional de NOT NULL para cancelar
 * toda a transacao quando a condicao falha.
 *
 * Isso depende da estrutura D1 conferida:
 * pedidos.referencia e NOT NULL.
 * estoque.quantidade tem CHECK >= 0.
 * estoque tem UNIQUE(produto_id, tamanho).
 */

async function finalizarPedido(
  db,
  pedido,
  orderId,
  pagamento,
  itens
) {
  const comandos = [];

  // Guarda: somente pedido pendente.
  comandos.push(
    db.prepare(`
      INSERT INTO pedidos
        (referencia, status, valor_total, ambiente)
      SELECT NULL, 'INVALIDO', 0, 'PRODUCAO'
      WHERE NOT EXISTS (
        SELECT 1 FROM pedidos
        WHERE id = ?
          AND checkout_id = ?
          AND status = 'PENDENTE'
          AND ambiente = 'PRODUCAO'
      )
    `).bind(pedido.id, orderId)
  );

  // Guarda: todos os itens precisam ter
  // exatamente um registro de estoque.
  for (const item of itens) {
    comandos.push(
      db.prepare(`
        INSERT INTO pedidos
          (referencia, status, valor_total, ambiente)
        SELECT NULL, 'INVALIDO', 0, 'PRODUCAO'
        WHERE (
          SELECT COUNT(*)
          FROM estoque
          WHERE produto_id = ?
            AND tamanho = ?
            AND quantidade >= ?
        ) <> 1
      `).bind(
        item.produto_id,
        item.tamanho,
        item.quantidade
      )
    );
  }

  // Registro unico do pagamento.
  comandos.push(
    db.prepare(`
      INSERT INTO pagamentos_mercadopago
        (
          pedido_id,
          order_id,
          pagamento_id,
          valor,
          moeda,
          status,
          metodo
        )
      VALUES (
        ?, ?, ?, ?,
        'BRL',
        'APROVADO',
        ?
      )
    `).bind(
      pedido.id,
      orderId,
      pagamento.id,
      pedido.valor_total,
      pagamento.metodo
    )
  );

  // Baixa de estoque.
  // CHECK(quantidade >= 0) cancela
  // a transacao se houver falta de estoque.
  for (const item of itens) {
    comandos.push(
      db.prepare(`
        UPDATE estoque
        SET
          quantidade = quantidade - ?,
          atualizado_em = CURRENT_TIMESTAMP
        WHERE produto_id = ?
          AND tamanho = ?
      `).bind(
        item.quantidade,
        item.produto_id,
        item.tamanho
      )
    );
  }

  // Pedido pago somente na mesma transacao.
  comandos.push(
    db.prepare(`
      UPDATE pedidos
      SET
        status = 'PAGO',
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = ?
        AND checkout_id = ?
        AND status = 'PENDENTE'
        AND ambiente = 'PRODUCAO'
    `).bind(pedido.id, orderId)
  );

  await db.batch(comandos);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Bloqueio de seguranca.
  if (
    env.URBAN_KICKS_PRODUCAO_HABILITADA !== "SIM"
  ) {
    return responder({
      erro: "Webhook de producao ainda nao habilitado."
    }, 503);
  }

  if (
    !env.DB ||
    !env.MERCADOPAGO_ACCESS_TOKEN_PRODUCAO ||
    !env.MERCADOPAGO_WEBHOOK_SECRET_PRODUCAO
  ) {
    console.error("MP_CONFIGURACAO_INDISPONIVEL");

    return responder({
      erro: "Configuracao indisponivel."
    }, 503);
  }

  try {
    const url = new URL(request.url);

    const orderId =
      url.searchParams.get("data.id") ||
      url.searchParams.get("data_id");

    const tipo = url.searchParams.get("type");

    if (tipo !== "order") {
      return responder({
        recebido: true,
        ignorado: true
      });
    }

    if (
      !orderId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)
    ) {
      return responder({
        erro: "Identificador invalido."
      }, 400);
    }

    const assinaturaValida = await validarAssinatura(
      request,
      env.MERCADOPAGO_WEBHOOK_SECRET_PRODUCAO,
      orderId
    );

    if (!assinaturaValida) {
      return responder({
        erro: "Assinatura invalida."
      }, 401);
    }

    const evento = await request.json().catch(
      () => null
    );

    if (
      !evento ||
      evento.type !== "order" ||
      String(evento.data?.id || "") !== orderId
    ) {
      return responder({
        erro: "Notificacao inconsistente."
      }, 400);
    }

    if (evento.live_mode !== true) {
      return responder({
        erro: "Ambiente de pagamento incorreto."
      }, 403);
    }

    const pedido = await obterPedido(
      env.DB,
      orderId
    );

    if (!pedido) {
      return responder({
        erro: "Pedido nao localizado."
      }, 404);
    }

    if (pedido.status === "PAGO") {
      return responder({
        recebido: true,
        processado: true,
        duplicado: true
      });
    }

    if (pedido.status !== "PENDENTE") {
      return responder({
        recebido: true,
        processado: false,
        status: pedido.status
      });
    }

    const ordem = await consultarOrdem(
      orderId,
      env.MERCADOPAGO_ACCESS_TOKEN_PRODUCAO
    );

    if (!ordem) {
      return responder({
        erro: "Falha ao consultar pagamento."
      }, 503);
    }

    if (
      String(ordem.id || "") !== orderId ||
      ordem.external_reference !== pedido.referencia
    ) {
      return responder({
        erro: "Divergencia no pedido."
      }, 409);
    }

    const confirmado = pagamentoAprovado(ordem);

    if (!confirmado) {
      return responder({
        recebido: true,
        processado: false,
        status: ordem.status || "pendente"
      });
    }

    // Conferencia dos valores.
    const totalOrdem = centavos(
      ordem.total_amount
    );

    const valorPagamento = centavos(
      confirmado.pagamento.amount
    );

    const valorPago = centavos(
      confirmado.pagamento.paid_amount
    );

    const moeda =
      ordem.currency_id ??
      evento.data?.currency_id ??
      null;

    if (
      totalOrdem === null ||
      totalOrdem !== pedido.valor_total ||
      valorPagamento !== pedido.valor_total ||
      valorPago !== pedido.valor_total ||
      moeda !== "BRL"
    ) {
      console.error(
        "MP_DIVERGENCIA_VALORES",
        pedido.id
      );

      return responder({
        erro: "Valores do pagamento divergentes."
      }, 409);
    }

    // Conferencia dos itens.
    const itens = await obterItens(
      env.DB,
      pedido.id
    );

    if (!itens.length) {
      return responder({
        erro: "Pedido sem itens."
      }, 409);
    }

    let soma = 0;

    for (const item of itens) {
      const quantidade = Number(item.quantidade);
      const subtotal = Number(item.subtotal);

      if (
        !Number.isSafeInteger(quantidade) ||
        quantidade <= 0 ||
        !Number.isSafeInteger(subtotal) ||
        subtotal < 0
      ) {
        return responder({
          erro: "Itens invalidos."
        }, 409);
      }

      soma += subtotal;
    }

    if (soma !== pedido.valor_total) {
      return responder({
        erro: "Itens e total divergentes."
      }, 409);
    }

    // Verificacao previa de estoque.
    for (const item of itens) {
      const estoque = await env.DB.prepare(`
        SELECT
          COUNT(*) AS registros,
          COALESCE(SUM(quantidade), 0) AS disponivel
        FROM estoque
        WHERE produto_id = ?
          AND tamanho = ?
      `).bind(
        item.produto_id,
        item.tamanho
      ).first();

      if (
        Number(estoque?.registros) !== 1 ||
        Number(estoque?.disponivel) <
          Number(item.quantidade)
      ) {
        console.error(
          "MP_ESTOQUE_INDISPONIVEL",
          pedido.id
        );

        return responder({
          erro: "Pagamento aprovado requer conciliacao.",
          pedidoId: pedido.id
        }, 503);
      }
    }

    // Finalizacao atomica no D1.
    try {
      await finalizarPedido(
        env.DB,
        pedido,
        orderId,
        confirmado,
        itens
      );
    } catch (erro) {
      console.error(
        "MP_FINALIZACAO_FALHOU",
        pedido.id,
        erro?.message || "Erro D1"
      );

      const atual = await obterPedido(
        env.DB,
        orderId
      );

      if (atual?.status === "PAGO") {
        return responder({
          recebido: true,
          processado: true,
          duplicado: true
        });
      }

      return responder({
        erro: "Pedido aprovado requer conciliacao.",
        pedidoId: pedido.id
      }, 503);
    }

    console.log(
      "MP_PAGAMENTO_CONFIRMADO",
      pedido.id,
      confirmado.metodo
    );

    return responder({
      recebido: true,
      processado: true,
      pedidoId: pedido.id,
      status: "PAGO",
      metodo: confirmado.metodo
    });

  } catch (erro) {
    console.error(
      "MP_WEBHOOK_ERRO",
      erro?.message || "Erro inesperado"
    );

    return responder({
      erro: "Erro interno no webhook."
    }, 500);
  }
}

export async function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido. Utilize POST."
  }, 405);
}
