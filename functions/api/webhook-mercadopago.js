
/*
 * URBAN KICKS
 * WEBHOOK MERCADO PAGO - PIX
 * Cloudflare Pages Functions + D1
 *
 * POST /api/webhook-mercadopago
 *
 * Ambiente: SANDBOX
 * Referencia: UK-MP-
 *
 * Verifica assinatura HMAC-SHA256.
 * Consulta a Order diretamente no Mercado Pago.
 * Confere o pagamento antes de confirmar.
 * Atualiza pedido e estoque em lote atomico.
 * Protege contra notificacoes duplicadas.
 *
 * Nao modifica os arquivos PagBank.
 *
 * IMPORTANTE:
 * Integracao em fase de testes.
 * Nao habilitar pagamentos reais sem
 * validar a resposta da Orders API.
 */

const MP_API =
  "https://api.mercadopago.com/v1/orders/";

const AMBIENTE = "SANDBOX";
const PREFIXO = "UK-MP-";

const LIMITE_CORPO = 100000;

function responder(dados, status = 200) {
  return Response.json(dados, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function identificadorValido(valor) {
  return (
    typeof valor === "string" &&
    valor.length >= 1 &&
    valor.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(valor)
  );
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
    diferenca |= (
      a.charCodeAt(i) ^
      b.charCodeAt(i)
    );
  }

  return diferenca === 0;
}

async function validarAssinatura(
  request,
  segredo
) {
  const url = new URL(request.url);

  const id =
    url.searchParams.get("data.id");

  const assinatura =
    request.headers.get("x-signature");

  const requestId =
    request.headers.get("x-request-id");

  if (
    !identificadorValido(id) ||
    !assinatura ||
    !requestId ||
    requestId.length > 200
  ) {
    return null;
  }

  const partes = {};

  for (
    const parte of assinatura.split(",")
  ) {
    const posicao = parte.indexOf("=");

    if (posicao > 0) {
      const chave = parte
        .slice(0, posicao)
        .trim();

      const valor = parte
        .slice(posicao + 1)
        .trim();

      partes[chave] = valor;
    }
  }

  const ts = partes.ts;
  const v1 = partes.v1;

  if (
    !/^\d{10,16}$/.test(ts || "") ||
    !/^[a-f0-9]{64}$/i.test(v1 || "")
  ) {
    return null;
  }

  const numeroTs = Number(ts);

  const instante =
    ts.length <= 10
      ? numeroTs * 1000
      : numeroTs;

  if (
    !Number.isFinite(instante) ||
    Math.abs(Date.now() - instante) >
      600000
  ) {
    return null;
  }

  const manifesto =
    "id:" + id.toLowerCase() + ";" +
    "request-id:" + requestId + ";" +
    "ts:" + ts + ";";

  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const resultado =
    await crypto.subtle.sign(
      "HMAC",
      chave,
      new TextEncoder().encode(
        manifesto
      )
    );

  const hexadecimal = Array.from(
    new Uint8Array(resultado)
  ).map(
    byte =>
      byte.toString(16).padStart(2, "0")
  ).join("");

  if (
    !compararSeguro(
      hexadecimal,
      v1.toLowerCase()
    )
  ) {
    return null;
  }

  return id;
}

function converterCentavos(valor) {
  if (
    typeof valor !== "string" &&
    typeof valor !== "number"
  ) {
    return null;
  }

  const texto = String(valor);

  if (
    !/^\d{1,12}(\.\d{1,2})?$/.test(
      texto
    )
  ) {
    return null;
  }

  const partes = texto.split(".");

  const reais = Number(partes[0]);

  const centavos = Number(
    (partes[1] || "").padEnd(2, "0")
  );

  const total =
    reais * 100 + centavos;

  return Number.isSafeInteger(total)
    ? total
    : null;
}

async function consultarOrder(
  orderId,
  token
) {
  const resposta = await fetch(
    MP_API + encodeURIComponent(orderId),
    {
      method: "GET",
      headers: {
        Authorization:
          "Bearer " + token,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!resposta.ok) {
    throw new Error(
      "Mercado Pago HTTP " +
      resposta.status
    );
  }

  return resposta.json();
}

async function buscarPedido(
  DB,
  referencia,
  orderId
) {
  return DB.prepare(`
    SELECT
      id,
      referencia,
      checkout_id,
      status,
      valor_total,
      ambiente
    FROM pedidos
    WHERE referencia = ?
      AND checkout_id = ?
      AND ambiente = ?
      AND referencia LIKE 'UK-MP-%'
    LIMIT 1
  `).bind(
    referencia,
    orderId,
    AMBIENTE
  ).first();
}

async function buscarItens(DB, pedido) {
  const resultado = await DB.prepare(`
    SELECT
      produto_id,
      CAST(tamanho AS TEXT) AS tamanho,
      SUM(quantidade) AS quantidade,
      SUM(
        quantidade * preco_unitario
      ) AS subtotal
    FROM pedido_itens
    WHERE pedido_id = ?
    GROUP BY
      produto_id,
      CAST(tamanho AS TEXT)
  `).bind(
    pedido.id
  ).all();

  const itens = resultado.results || [];

  if (
    itens.length < 1 ||
    itens.length > 20
  ) {
    throw new Error(
      "Quantidade de itens invalida"
    );
  }

  let total = 0;

  for (const item of itens) {
    if (
      !Number.isSafeInteger(
        item.produto_id
      ) ||
      item.produto_id < 1 ||
      !/^(3[4-9]|4[0-4])$/.test(
        item.tamanho
      ) ||
      !Number.isSafeInteger(
        item.quantidade
      ) ||
      item.quantidade < 1 ||
      item.quantidade > 5 ||
      !Number.isSafeInteger(
        item.subtotal
      ) ||
      item.subtotal <= 0
    ) {
      throw new Error(
        "Item do pedido invalido"
      );
    }

    total += item.subtotal;
  }

  if (
    !Number.isSafeInteger(total) ||
    total !== pedido.valor_total
  ) {
    throw new Error(
      "Valor dos itens divergente"
    );
  }

  return itens;
}

function pagamentoConfirmado(
  order,
  pedido
) {
  if (
    order?.status !== "processed" ||
    order?.status_detail !== "accredited"
  ) {
    return {
      confirmado: false,
      pendente: true
    };
  }

  const pagamentos =
    order?.transactions?.payments;

  if (
    !Array.isArray(pagamentos) ||
    pagamentos.length !== 1
  ) {
    return {
      confirmado: false,
      erro: "Quantidade de pagamentos invalida"
    };
  }

  const pagamento = pagamentos[0];

  const pagamentoId =
    String(pagamento?.id ?? "");

  if (
    !identificadorValido(pagamentoId) ||
    pagamento?.status !== "processed" ||
    pagamento?.status_detail !== "accredited"
  ) {
    return {
      confirmado: false,
      erro: "Pagamento nao validado"
    };
  }

  /*
   * Confirmacao conservadora:
   * campos ausentes ou divergentes
   * impedem a baixa automatica.
   */

  const valores = [
    order?.total_amount,
    order?.total_paid_amount,
    pagamento?.amount,
    pagamento?.paid_amount
  ];

  if (
    order?.currency_id !== "BRL" ||
    !Number.isSafeInteger(
      pedido.valor_total
    ) ||
    pedido.valor_total <= 0 ||
    valores.some(
      valor =>
        converterCentavos(valor) !==
        pedido.valor_total
    )
  ) {
    return {
      confirmado: false,
      erro:
        "Moeda ou valores inconsistentes"
    };
  }

  const metodo =
    pagamento?.payment_method;

  if (
    metodo?.id !== "pix" ||
    metodo?.type !== "bank_transfer"
  ) {
    return {
      confirmado: false,
      erro: "Metodo de pagamento divergente"
    };
  }

  return {
    confirmado: true,
    pagamentoId,
    metodo: "pix"
  };
}

/*
 * Guarda SQL:
 *
 * Se a condicao nao for atendida,
 * tenta inserir NULL em uma coluna
 * NOT NULL, provocando erro.
 *
 * O DB.batch do D1 executa as
 * instrucoes em transacao atomica.
 * Se uma falhar, o lote e revertido.
 */

function guarda(DB, condicao, parametros) {
  return DB.prepare(`
    INSERT INTO pedidos (
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
    WHERE NOT (${condicao})
  `).bind(...parametros);
}

async function confirmarNoBanco(
  DB,
  pedido,
  orderId,
  pagamentoId,
  itens
) {
  const comandos = [];

  /*
   * Protege contra confirmacao repetida
   * e mudanca de status concorrente.
   */

  comandos.push(
    guarda(
      DB,
      `EXISTS (
        SELECT 1
        FROM pedidos
        WHERE id = ?
          AND referencia = ?
          AND checkout_id = ?
          AND ambiente = 'SANDBOX'
          AND status = 'PENDENTE'
      )`,
      [
        pedido.id,
        pedido.referencia,
        orderId
      ]
    )
  );

  /*
   * Confere estoque de todos os itens
   * antes de qualquer desconto.
   */

  for (const item of itens) {
    comandos.push(
      guarda(
        DB,
        `EXISTS (
          SELECT 1
          FROM estoque
          WHERE produto_id = ?
            AND CAST(tamanho AS TEXT) = ?
            AND quantidade >= ?
        )`,
        [
          item.produto_id,
          item.tamanho,
          item.quantidade
        ]
      )
    );
  }

  /*
   * Registro unico do pagamento.
   * A tabela possui UNIQUE(pedido_id)
   * e UNIQUE(order_id).
   */

  comandos.push(
    DB.prepare(`
      INSERT INTO pagamentos_mercadopago (
        pedido_id,
        order_id,
        pagamento_id,
        valor,
        moeda,
        status,
        metodo
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        'BRL',
        'PAGO',
        'pix'
      )
    `).bind(
      pedido.id,
      orderId,
      pagamentoId,
      pedido.valor_total
    )
  );

  comandos.push(
    DB.prepare(`
      UPDATE pedidos
      SET
        status = 'PAGO',
        atualizado_em =
          CURRENT_TIMESTAMP
      WHERE id = ?
        AND referencia = ?
        AND checkout_id = ?
        AND ambiente = 'SANDBOX'
        AND status = 'PENDENTE'
    `).bind(
      pedido.id,
      pedido.referencia,
      orderId
    )
  );

  /*
   * Baixa estoque por produto/tamanho.
   */

  for (const item of itens) {
    comandos.push(
      DB.prepare(`
        UPDATE estoque
        SET
          quantidade =
            quantidade - ?,
          atualizado_em =
            CURRENT_TIMESTAMP
        WHERE produto_id = ?
          AND CAST(tamanho AS TEXT) = ?
          AND quantidade >= ?
      `).bind(
        item.quantidade,
        item.produto_id,
        item.tamanho,
        item.quantidade
      )
    );
  }

  await DB.batch(comandos);
}

export async function onRequestPost({
  request,
  env
}) {
  if (
    !env.DB ||
    !env.MERCADOPAGO_ACCESS_TOKEN ||
    !env.MERCADOPAGO_WEBHOOK_SECRET
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  const tamanho = Number(
    request.headers.get(
      "content-length"
    ) || 0
  );

  if (
    !Number.isFinite(tamanho) ||
    tamanho > LIMITE_CORPO
  ) {
    return responder({
      erro: "Notificacao muito grande"
    }, 413);
  }

  let corpo;

  try {
    corpo = await request.text();
  } catch {
    return responder({
      erro: "Falha ao ler notificacao"
    }, 400);
  }

  if (
    !corpo ||
    new TextEncoder()
      .encode(corpo).length >
      LIMITE_CORPO
  ) {
    return responder({
      erro: "Corpo invalido"
    }, 400);
  }

  let orderId;

  try {
    orderId = await validarAssinatura(
      request,
      env.MERCADOPAGO_WEBHOOK_SECRET
    );
  } catch (erro) {
    console.error(
      "MP_ASSINATURA",
      String(erro)
    );

    return responder({
      erro:
        "Falha ao validar assinatura"
    }, 503);
  }

  if (!orderId) {
    return responder({
      erro:
        "Assinatura invalida ou expirada"
    }, 401);
  }

  let evento;

  try {
    evento = JSON.parse(corpo);
  } catch {
    return responder({
      erro: "JSON invalido"
    }, 400);
  }

  if (
    evento?.type !== "order" ||
    evento?.live_mode !== false ||
    String(evento?.data?.id ?? "") !==
      orderId
  ) {
    return responder({
      erro:
        "Evento de teste invalido"
    }, 400);
  }

  let order;

  try {
    order = await consultarOrder(
      orderId,
      env.MERCADOPAGO_ACCESS_TOKEN
    );
  } catch (erro) {
    console.error(
      "MP_CONSULTA_ORDER",
      String(erro)
    );

    return responder({
      erro:
        "Falha ao consultar Order"
    }, 503);
  }

  const referencia =
    order?.external_reference;

  if (
    String(order?.id ?? "") !==
      orderId ||
    typeof referencia !== "string" ||
    !referencia.startsWith(PREFIXO)
  ) {
    return responder({
      erro: "Order inconsistente"
    }, 409);
  }

  let pedido;

  try {
    pedido = await buscarPedido(
      env.DB,
      referencia,
      orderId
    );
  } catch (erro) {
    console.error(
      "MP_BUSCAR_PEDIDO",
      String(erro)
    );

    return responder({
      erro:
        "Falha ao consultar pedido"
    }, 503);
  }

  if (!pedido) {
    return responder({
      erro: "Pedido nao encontrado"
    }, 404);
  }

  if (pedido.status === "PAGO") {
    return responder({
      recebido: true,
      pedidoId: pedido.id,
      status: "PAGO",
      jaProcessado: true,
      estoqueAlterado: false
    });
  }

  if (
    pedido.status !== "PENDENTE"
  ) {
    return responder({
      recebido: true,
      pedidoId: pedido.id,
      status: pedido.status,
      processado: false
    });
  }

  const validacao =
    pagamentoConfirmado(
      order,
      pedido
    );

  if (validacao.pendente) {
    return responder({
      recebido: true,
      pedidoId: pedido.id,
      status: "PENDENTE",
      pagamentoConfirmado: false,
      estoqueAlterado: false
    });
  }

  if (!validacao.confirmado) {
    console.error(
      "MP_PAGAMENTO_NAO_VALIDADO",
      validacao.erro
    );

    return responder({
      erro:
        "Pagamento exige revisao",
      motivo: validacao.erro,
      processado: false
    }, 409);
  }

  let itens;

  try {
    itens = await buscarItens(
      env.DB,
      pedido
    );
  } catch (erro) {
    console.error(
      "MP_ITENS",
      String(erro)
    );

    return responder({
      erro:
        "Itens do pedido inconsistentes"
    }, 409);
  }

  try {
    await confirmarNoBanco(
      env.DB,
      pedido,
      orderId,
      validacao.pagamentoId,
      itens
    );
  } catch (erro) {
    console.error(
      "MP_CONFIRMACAO_D1",
      String(erro)
    );

    /*
     * Uma notificacao concorrente
     * pode ter confirmado o pedido.
     * Consulta novamente antes
     * de informar falha.
     */

    try {
      const atual = await buscarPedido(
        env.DB,
        referencia,
        orderId
      );

      if (
        atual?.status === "PAGO"
      ) {
        return responder({
          recebido: true,
          pedidoId: atual.id,
          status: "PAGO",
          jaProcessado: true,
          estoqueAlterado: false
        });
      }
    } catch {
      // Mantem resposta de falha.
    }

    return responder({
      erro:
        "Confirmacao inconclusa",
      pedidoId: pedido.id,
      mensagem:
        "Verifique pagamento e estoque no D1."
    }, 503);
  }

  console.log(
    "MP_PEDIDO_CONFIRMADO",
    {
      pedidoId: pedido.id,
      referencia,
      orderId
    }
  );

  return responder({
    recebido: true,
    pedidoId: pedido.id,
    referencia,
    status: "PAGO",
    pagamentoConfirmado: true,
    estoqueAlterado: true,
    produtosAtualizados:
      itens.map(item => ({
        produtoId: item.produto_id,
        tamanho: item.tamanho,
        quantidadeDescontada:
          item.quantidade
      }))
  });
}

export function onRequestGet() {
  return responder({
    erro:
      "Metodo nao permitido. Utilize POST."
  }, 405);
}
