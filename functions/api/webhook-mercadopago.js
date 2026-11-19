
/*
 * URBAN KICKS
 * Webhook Mercado Pago - PIX e Cartao
 * Cloudflare Pages Functions + D1
 *
 * Ambiente: SANDBOX
 *
 * Validacao HMAC:
 * - Identificador em minusculas
 * - Identificador original
 * - Nunca ignora assinatura invalida
 *
 * Pagamentos:
 * - Consulta a API oficial
 * - Confere pedido e valores
 * - Impede processamento duplicado
 * - Atualiza estoque em transacao D1
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
  ) {
    return null;
  }

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
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return null;
  }

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

async function validarAssinatura(
  request,
  secret,
  id
) {
  const assinatura = request.headers.get(
    "x-signature"
  );

  const requestId = request.headers.get(
    "x-request-id"
  );

  if (!assinatura || !requestId || !secret || !id) {
    console.error(
      "MP_ASSINATURA_CABECALHO_AUSENTE"
    );
    return false;
  }

  const campos = {};

  for (const parte of assinatura.split(",")) {
    const posicao = parte.indexOf("=");

    if (posicao > 0) {
      const nome = parte
        .slice(0, posicao)
        .trim();

      const valor = parte
        .slice(posicao + 1)
        .trim();

      campos[nome] = valor;
    }
  }

  const ts = campos.ts;
  const v1 = campos.v1;

  if (!/^\d{10,16}$/.test(ts || "")) {
    console.error(
      "MP_ASSINATURA_TIMESTAMP_INVALIDO"
    );
    return false;
  }

  const assinaturaRecebida = hexParaBytes(
    v1 || ""
  );

  if (!assinaturaRecebida) {
    console.error(
      "MP_ASSINATURA_FORMATO_INVALIDO"
    );
    return false;
  }

  const numeroTs = Number(ts);

  const instante =
    ts.length <= 10
      ? numeroTs * 1000
      : numeroTs;

  if (
    !Number.isFinite(instante) ||
    Math.abs(Date.now() - instante) >
      10 * 60 * 1000
  ) {
    console.error(
      "MP_ASSINATURA_HORARIO_INVALIDO"
    );
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

  /*
   * O Mercado Pago documenta o ID em
   * minusculas para a assinatura.
   *
   * Tambem testamos o ID original para
   * diagnosticar possiveis diferencas
   * no simulador.
   *
   * Nenhuma variante dispensa HMAC valido.
   */

  const identificadores = [
    {
      nome: "MINUSCULO",
      valor: id.toLowerCase()
    }
  ];

  if (id !== id.toLowerCase()) {
    identificadores.push({
      nome: "ORIGINAL",
      valor: id
    });
  }

  let assinaturaValida = false;
  let varianteValida = null;

  for (const identificador of identificadores) {
    const manifesto =
      "id:" +
      identificador.valor +
      ";request-id:" +
      requestId +
      ";ts:" +
      ts +
      ";";

    const assinaturaCalculada = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        chave,
        encoder.encode(manifesto)
      )
    );

    const corresponde = comparacaoConstante(
      assinaturaRecebida,
      assinaturaCalculada
    );

    if (corresponde) {
      assinaturaValida = true;
      varianteValida = identificador.nome;
    }
  }

  if (!assinaturaValida) {
    console.error(
      "MP_ASSINATURA_HMAC_DIVERGENTE",
      "VARIANTES_TESTADAS:",
      identificadores.map(
        item => item.nome
      ).join(",")
    );

    return false;
  }

  console.log(
    "MP_ASSINATURA_VALIDA",
    varianteValida
  );

  return true;
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

  const pagamentos =
    ordem?.transactions?.payments;

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

  if (!metodo) {
    return null;
  }

  const idPagamento = String(
    pagamento.id || ""
  );

  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(
      idPagamento
    )
  ) {
    return null;
  }

  return {
    id: idPagamento,
    metodo,
    pagamento
  };
}

async function consultarOrder(orderId, token) {
  const resposta = await fetch(
    MP_API + encodeURIComponent(orderId),
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
  return db.prepare(
    `SELECT
       id,
       referencia,
       checkout_id,
       status,
       valor_total,
       ambiente
     FROM pedidos
     WHERE checkout_id = ?
       AND ambiente = 'SANDBOX'
       AND referencia LIKE 'UK-MP-%'
     LIMIT 1`
  ).bind(orderId).first();
}

async function obterItens(db, pedidoId) {
  const resultado = await db.prepare(
    `SELECT
       produto_id,
       tamanho,
       SUM(quantidade) AS quantidade,
       SUM(
         quantidade * preco_unitario
       ) AS subtotal
     FROM pedido_itens
     WHERE pedido_id = ?
     GROUP BY produto_id, tamanho`
  ).bind(pedidoId).all();

  return resultado.results || [];
}

async function finalizarPedido(
  db,
  pedido,
  orderId,
  pagamento,
  itens
) {
  const comandos = [];

  /*
   * Guarda transacional.
   *
   * Se o pedido nao estiver pendente,
   * provoca uma falha de constraint.
   * A transacao inteira e revertida.
   */

  comandos.push(
    db.prepare(
      `INSERT INTO pedidos
        (
          referencia,
          status,
          valor_total,
          ambiente
        )
       SELECT
         NULL,
         'INVALIDO',
         0,
         'SANDBOX'
       WHERE NOT EXISTS (
         SELECT 1
         FROM pedidos
         WHERE id = ?
           AND checkout_id = ?
           AND status = 'PENDENTE'
           AND ambiente = 'SANDBOX'
       )`
    ).bind(
      pedido.id,
      orderId
    )
  );

  /*
   * Verificacao de estoque na transacao.
   */

  for (const item of itens) {
    comandos.push(
      db.prepare(
        `INSERT INTO pedidos
          (
            referencia,
            status,
            valor_total,
            ambiente
          )
         SELECT
           NULL,
           'INVALIDO',
           0,
           'SANDBOX'
         WHERE (
           SELECT COALESCE(
             SUM(quantidade),
             0
           )
           FROM estoque
           WHERE produto_id = ?
             AND tamanho = ?
         ) < ?`
      ).bind(
        item.produto_id,
        item.tamanho,
        item.quantidade
      )
    );
  }

  /*
   * Registro unico do pagamento.
   *
   * A tabela pagamentos_mercadopago
   * possui UNIQUE para pedido e order.
   */

  comandos.push(
    db.prepare(
      `INSERT INTO pagamentos_mercadopago
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
       )`
    ).bind(
      pedido.id,
      orderId,
      pagamento.id,
      pedido.valor_total,
      pagamento.metodo
    )
  );

  comandos.push(
    db.prepare(
      `UPDATE pedidos
       SET
         status = 'PAGO',
         atualizado_em = CURRENT_TIMESTAMP
       WHERE id = ?
         AND checkout_id = ?
         AND status = 'PENDENTE'
         AND ambiente = 'SANDBOX'`
    ).bind(
      pedido.id,
      orderId
    )
  );

  /*
   * Baixa de estoque.
   *
   * Exige um registro unico por
   * produto e tamanho.
   */

  for (const item of itens) {
    comandos.push(
      db.prepare(
        `UPDATE estoque
         SET
           quantidade = quantidade - ?,
           atualizado_em = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id
           FROM estoque
           WHERE produto_id = ?
             AND tamanho = ?
           ORDER BY id
           LIMIT 1
         )
         AND quantidade >= ?`
      ).bind(
        item.quantidade,
        item.produto_id,
        item.tamanho,
        item.quantidade
      )
    );
  }

  await db.batch(comandos);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (
    !env.DB ||
    !env.MERCADOPAGO_ACCESS_TOKEN ||
    !env.MERCADOPAGO_WEBHOOK_SECRET
  ) {
    console.error(
      "MP_CONFIGURACAO_INDISPONIVEL"
    );

    return responder(
      {
        erro: "Configuracao indisponivel."
      },
      503
    );
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
      !/^[a-zA-Z0-9_-]{1,128}$/.test(
        orderId
      )
    ) {
      return responder(
        {
          erro: "Identificador invalido."
        },
        400
      );
    }

    /*
     * Assinatura obrigatoria.
     */

    const assinaturaValida =
      await validarAssinatura(
        request,
        env.MERCADOPAGO_WEBHOOK_SECRET,
        orderId
      );

    if (!assinaturaValida) {
      return responder(
        {
          erro: "Assinatura invalida."
        },
        401
      );
    }

    /*
     * Confere o corpo da notificacao.
     */

    const evento = await request.json().catch(
      () => null
    );

    if (
      !evento ||
      evento.type !== "order" ||
      String(evento.data?.id || "") !==
        orderId
    ) {
      console.error(
        "MP_NOTIFICACAO_INCONSISTENTE"
      );

      return responder(
        {
          erro: "Notificacao inconsistente."
        },
        400
      );
    }

    /*
     * Somente ambiente de testes.
     */

    if (evento.live_mode !== false) {
      console.error(
        "MP_AMBIENTE_INCORRETO"
      );

      return responder(
        {
          erro: "Ambiente de pagamento incorreto."
        },
        403
      );
    }

    /*
     * Localiza o pedido no D1.
     */

    const pedido = await obterPedido(
      env.DB,
      orderId
    );

    if (!pedido) {
      console.error(
        "MP_PEDIDO_NAO_LOCALIZADO"
      );

      return responder(
        {
          erro: "Pedido nao localizado."
        },
        404
      );
    }

    /*
     * Protecao contra duplicidade.
     */

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

    /*
     * Consulta a API oficial.
     * Nunca confia apenas no webhook.
     */

    const ordem = await consultarOrder(
      orderId,
      env.MERCADOPAGO_ACCESS_TOKEN
    );

    if (!ordem) {
      return responder(
        {
          erro: "Falha ao consultar pagamento."
        },
        503
      );
    }

    if (
      String(ordem.id || "") !== orderId ||
      ordem.external_reference !==
        pedido.referencia
    ) {
      console.error(
        "MP_DIVERGENCIA_PEDIDO"
      );

      return responder(
        {
          erro: "Divergencia no pedido."
        },
        409
      );
    }

    /*
     * Confirma pagamento aprovado.
     */

    const confirmado = pagamentoAprovado(
      ordem
    );

    if (!confirmado) {
      return responder({
        recebido: true,
        processado: false,
        status: ordem.status || "pendente"
      });
    }

    /*
     * Conferencia financeira.
     */

    const totalOrder = centavos(
      ordem.total_amount
    );

    const valorPagamento = centavos(
      confirmado.pagamento.amount
    );

    const valorPago = centavos(
      confirmado.pagamento.paid_amount
    );

    if (
      totalOrder !== pedido.valor_total ||
      valorPagamento !== pedido.valor_total ||
      valorPago !== pedido.valor_total ||
      ordem.currency_id !== "BRL"
    ) {
      console.error(
        "MP_DIVERGENCIA_VALORES",
        pedido.id
      );

      return responder(
        {
          erro: "Valores do pagamento divergentes."
        },
        409
      );
    }

    /*
     * Confere os itens do pedido.
     */

    const itens = await obterItens(
      env.DB,
      pedido.id
    );

    if (!itens.length) {
      return responder(
        {
          erro: "Pedido sem itens."
        },
        409
      );
    }

    const soma = itens.reduce(
      (total, item) =>
        total + Number(item.subtotal),
      0
    );

    if (soma !== pedido.valor_total) {
      return responder(
        {
          erro: "Itens e total divergentes."
        },
        409
      );
    }

    for (const item of itens) {
      if (
        !Number.isInteger(
          Number(item.quantidade)
        ) ||
        Number(item.quantidade) <= 0
      ) {
        return responder(
          {
            erro: "Quantidade invalida."
          },
          409
        );
      }
    }

    /*
     * Verifica estoque disponivel.
     */

    for (const item of itens) {
      const estoque = await env.DB.prepare(
        `SELECT
           COUNT(*) AS registros,
           COALESCE(
             SUM(quantidade),
             0
           ) AS disponivel
         FROM estoque
         WHERE produto_id = ?
           AND tamanho = ?`
      ).bind(
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

        return responder(
          {
            erro:
              "Pagamento aprovado, mas estoque requer revisao.",
            pedidoId: pedido.id
          },
          503
        );
      }
    }

    /*
     * Finaliza pedido e estoque.
     */

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

      return responder(
        {
          erro:
            "Pedido aprovado requer conciliacao.",
          pedidoId: pedido.id
        },
        503
      );
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

    return responder(
      {
        erro: "Erro interno no webhook."
      },
      500
    );
  }
}

export async function onRequestGet() {
  return responder(
    {
      erro:
        "Metodo nao permitido. Utilize POST."
    },
    405
  );
}
