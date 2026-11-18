
/*
 * URBAN KICKS
 * MERCADO PAGO - CHECKOUT PIX
 * Cloudflare Pages Functions + D1
 *
 * Rota: POST /api/checkout-mercadopago
 *
 * Ambiente: SANDBOX
 * Pedidos identificados por UK-MP-
 *
 * Nao modifica o PagBank.
 * Nao confirma pagamentos.
 * Nao desconta estoque.
 */

const MP_API =
  "https://api.mercadopago.com/v1/orders";

const TURNSTILE_API =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const AMBIENTE = "SANDBOX";
const PREFIXO = "UK-MP-";

const PRODUTOS = {
  1: {
    nome: "New Balance — Cinza Urbano",
    valor: 39990
  },
  2: {
    nome: "Nike TN — Edição Iridescente",
    valor: 44990
  },
  3: {
    nome: "Nike Air Max Plus — Preto e Prata",
    valor: 42990
  },
  4: {
    nome: "Nike Shox — Total Black",
    valor: 49990
  },
  5: {
    nome: "Nike Air Max Plus — Blue Gradient",
    valor: 44990
  },
  6: {
    nome: "Nike Shox — Marrom Escuro",
    valor: 48990
  },
  7: {
    nome: "Nike P-6000 — Branco",
    valor: 37990
  },
  8: {
    nome: "Nike P-6000 — Branco Lateral",
    valor: 37990
  }
};

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

async function validarTurnstile(
  token,
  request,
  env
) {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 2048
  ) {
    return false;
  }

  const formulario = new FormData();

  formulario.append(
    "secret",
    env.TURNSTILE_SECRET_KEY
  );

  formulario.append(
    "response",
    token
  );

  const ip = request.headers.get(
    "CF-Connecting-IP"
  );

  if (ip) {
    formulario.append("remoteip", ip);
  }

  try {
    const resposta = await fetch(
      TURNSTILE_API,
      {
        method: "POST",
        body: formulario,
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!resposta.ok) {
      return false;
    }

    const dados = await resposta.json();

    return (
      dados.success === true &&
      dados.hostname ===
        "urban-kicks.pages.dev"
    );
  } catch (erro) {
    console.error(
      "MP_TURNSTILE",
      String(erro)
    );

    return false;
  }
}

function validarCarrinho(items) {
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > 20
  ) {
    return {
      erro: "Carrinho invalido"
    };
  }

  const agrupados = new Map();

  for (const item of items) {
    const id = item?.id;
    const tamanho = String(
      item?.size ?? ""
    );
    const quantidade = item?.quantity;

    if (
      !Number.isSafeInteger(id) ||
      !Object.prototype.hasOwnProperty.call(
        PRODUTOS,
        id
      ) ||
      !/^\d{2}$/.test(tamanho) ||
      Number(tamanho) < 34 ||
      Number(tamanho) > 44 ||
      !Number.isSafeInteger(quantidade) ||
      quantidade < 1 ||
      quantidade > 5
    ) {
      return {
        erro:
          "Produto, tamanho ou quantidade invalida"
      };
    }

    const chave = `${id}-${tamanho}`;

    const anterior =
      agrupados.get(chave)?.quantidade || 0;

    const acumulado =
      anterior + quantidade;

    if (acumulado > 5) {
      return {
        erro:
          "Limite de 5 unidades por tamanho"
      };
    }

    agrupados.set(chave, {
      id,
      tamanho,
      quantidade: acumulado
    });
  }

  return {
    produtos: [...agrupados.values()]
  };
}

async function verificarEstoque(DB, produtos) {
  for (const item of produtos) {
    const registro = await DB.prepare(`
      SELECT quantidade
      FROM estoque
      WHERE produto_id = ?
        AND tamanho = ?
    `).bind(
      item.id,
      item.tamanho
    ).first();

    const quantidade = Number(
      registro?.quantidade
    );

    if (
      !registro ||
      !Number.isSafeInteger(quantidade) ||
      quantidade < item.quantidade
    ) {
      return {
        disponivel: false,
        produtoId: item.id,
        tamanho: item.tamanho
      };
    }
  }

  return {
    disponivel: true
  };
}

async function registrarPedido(
  DB,
  referencia,
  totalCentavos,
  produtos
) {
  const comandos = [
    DB.prepare(`
      INSERT INTO pedidos (
        referencia,
        checkout_id,
        status,
        valor_total,
        ambiente
      )
      VALUES (
        ?,
        NULL,
        'PREPARANDO',
        ?,
        ?
      )
    `).bind(
      referencia,
      totalCentavos,
      AMBIENTE
    )
  ];

  for (const item of produtos) {
    comandos.push(
      DB.prepare(`
        INSERT INTO pedido_itens (
          pedido_id,
          produto_id,
          produto_nome,
          tamanho,
          quantidade,
          preco_unitario
        )
        SELECT
          id,
          ?,
          ?,
          ?,
          ?,
          ?
        FROM pedidos
        WHERE referencia = ?
          AND ambiente = ?
      `).bind(
        item.id,
        PRODUTOS[item.id].nome,
        item.tamanho,
        item.quantidade,
        PRODUTOS[item.id].valor,
        referencia,
        AMBIENTE
      )
    );
  }

  await DB.batch(comandos);
}

async function atualizarPedido(
  DB,
  referencia,
  orderId
) {
  const resultado = await DB.prepare(`
    UPDATE pedidos
    SET
      checkout_id = ?,
      status = 'PENDENTE',
      atualizado_em = CURRENT_TIMESTAMP
    WHERE referencia = ?
      AND ambiente = ?
      AND status = 'PREPARANDO'
      AND checkout_id IS NULL
  `).bind(
    orderId,
    referencia,
    AMBIENTE
  ).run();

  return resultado.meta?.changes === 1;
}

function extrairPix(ordem) {
  const pagamento =
    ordem?.transactions?.payments?.[0];

  const metodo =
    pagamento?.payment_method || {};

  const dados =
    metodo?.transaction_data || {};

  const obter = (...valores) => {
    for (const valor of valores) {
      if (
        typeof valor === "string" &&
        valor.length > 0
      ) {
        return valor;
      }
    }

    return null;
  };

  const ticket = obter(
    metodo.ticket_url,
    dados.ticket_url
  );

  let ticketUrl = null;

  if (ticket) {
    try {
      const url = new URL(ticket);

      if (
        url.protocol === "https:" &&
        (
          url.hostname ===
            "mercadopago.com.br" ||
          url.hostname.endsWith(
            ".mercadopago.com.br"
          )
        )
      ) {
        ticketUrl = url.href;
      }
    } catch {
      ticketUrl = null;
    }
  }

  return {
    copiaECola: obter(
      metodo.qr_code,
      dados.qr_code
    ),
    qrCodeBase64: obter(
      metodo.qr_code_base64,
      dados.qr_code_base64
    ),
    ticketUrl
  };
}

export async function onRequestPost({
  request,
  env
}) {
  if (
    !env.DB ||
    !env.MERCADOPAGO_ACCESS_TOKEN ||
    !env.TURNSTILE_SECRET_KEY
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return responder({
      erro: "JSON invalido"
    }, 400);
  }

  if (
    !entrada ||
    typeof entrada !== "object"
  ) {
    return responder({
      erro: "Requisicao invalida"
    }, 400);
  }

  const validacao = validarCarrinho(
    entrada.items
  );

  if (validacao.erro) {
    return responder({
      erro: validacao.erro
    }, 400);
  }

  const email =
    typeof entrada.email === "string"
      ? entrada.email.trim()
      : "";

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return responder({
      erro: "Informe um e-mail valido"
    }, 400);
  }

  const seguro = await validarTurnstile(
    entrada.turnstileToken,
    request,
    env
  );

  if (!seguro) {
    return responder({
      erro:
        "Verificacao de seguranca invalida"
    }, 403);
  }

  const produtos = validacao.produtos;

  try {
    const estoque = await verificarEstoque(
      env.DB,
      produtos
    );

    if (!estoque.disponivel) {
      return responder({
        erro: "Estoque insuficiente",
        produtoId: estoque.produtoId,
        tamanho: estoque.tamanho
      }, 409);
    }
  } catch (erro) {
    console.error(
      "MP_ESTOQUE",
      String(erro)
    );

    return responder({
      erro:
        "Nao foi possivel consultar estoque"
    }, 503);
  }

  const totalCentavos = produtos.reduce(
    (total, item) =>
      total +
      PRODUTOS[item.id].valor *
        item.quantidade,
    0
  );

  if (
    !Number.isSafeInteger(totalCentavos) ||
    totalCentavos <= 0
  ) {
    return responder({
      erro: "Valor total invalido"
    }, 400);
  }

  const valor =
    (totalCentavos / 100).toFixed(2);

  const identificador = crypto.randomUUID();

  const referencia =
    PREFIXO + identificador;

  /*
   * A chave de idempotencia e estavel
   * durante esta tentativa de checkout.
   * Nao garante deduplicacao entre
   * requisicoes diferentes.
   */

  const chaveIdempotencia =
    identificador;

  try {
    await registrarPedido(
      env.DB,
      referencia,
      totalCentavos,
      produtos
    );
  } catch (erro) {
    console.error(
      "MP_REGISTRAR_PEDIDO",
      String(erro)
    );

    return responder({
      erro: "Falha ao registrar pedido"
    }, 503);
  }

  const corpo = {
    type: "online",
    processing_mode: "automatic",
    external_reference: referencia,
    total_amount: valor,
    payer: {
      email
    },
    transactions: {
      payments: [
        {
          amount: valor,
          payment_method: {
            id: "pix",
            type: "bank_transfer"
          }
        }
      ]
    }
  };

  let ordem;

  try {
    const resposta = await fetch(
      MP_API,
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " +
            env.MERCADOPAGO_ACCESS_TOKEN,
          "Content-Type":
            "application/json",
          Accept: "application/json",
          "X-Idempotency-Key":
            chaveIdempotencia
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(20000)
      }
    );

    ordem = await resposta.json().catch(
      () => ({})
    );

    if (!resposta.ok) {
      console.error(
        "MP_ORDER_HTTP",
        JSON.stringify({
          status: resposta.status,
          codigo:
            ordem?.error ||
            ordem?.code ||
            null
        })
      );

      return responder({
        erro:
          "Mercado Pago recusou a Order",
        referencia,
        statusMercadoPago:
          resposta.status
      }, 502);
    }
  } catch (erro) {
    console.error(
      "MP_ORDER_REDE",
      String(erro)
    );

    return responder({
      erro:
        "Falha de comunicacao com Mercado Pago",
      referencia,
      mensagem:
        "Nao tente pagar novamente sem verificar o pedido."
    }, 502);
  }

  const orderId = ordem?.id;

  if (!identificadorValido(orderId)) {
    console.error(
      "MP_ORDER_ID_INVALIDO"
    );

    return responder({
      erro:
        "Identificador da Order invalido",
      referencia
    }, 502);
  }

  if (
    ordem.external_reference !==
    referencia
  ) {
    return responder({
      erro:
        "Referencia da Order divergente",
      referencia
    }, 502);
  }

  try {
    const atualizado =
      await atualizarPedido(
        env.DB,
        referencia,
        orderId
      );

    if (!atualizado) {
      throw new Error(
        "Pedido nao atualizado"
      );
    }
  } catch (erro) {
    console.error(
      "MP_SALVAR_ORDER",
      String(erro)
    );

    return responder({
      erro:
        "Order criada, mas nao registrada corretamente",
      referencia,
      mensagem:
        "Nao efetue pagamento. Contate a loja."
    }, 503);
  }

  const pix = extrairPix(ordem);

  if (
    !pix.copiaECola &&
    !pix.qrCodeBase64 &&
    !pix.ticketUrl
  ) {
    console.error(
      "MP_PIX_DADOS_AUSENTES",
      {
        referencia,
        orderId
      }
    );

    return responder({
      erro:
        "Order criada, mas dados PIX indisponiveis",
      referencia,
      orderId,
      mensagem:
        "Nao efetue pagamento. Verifique a integracao."
    }, 502);
  }

  return responder({
    referencia,
    orderId,
    ambiente: AMBIENTE,
    status: "PENDENTE",
    statusMercadoPago:
      ordem.status || null,
    valorTotal: totalCentavos,
    pix,
    mensagem:
      "Pagamento nao confirmado. Aguarde a conciliacao."
  });
}

export function onRequestGet() {
  return responder({
    erro:
      "Metodo nao permitido. Utilize POST."
  }, 405);
}
