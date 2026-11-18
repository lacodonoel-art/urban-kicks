
/*
 * URBAN KICKS
 * Mercado Pago - Checkout PIX
 * Cloudflare Pages Functions + D1
 *
 * POST /api/checkout-mercadopago
 *
 * Ambiente de teste.
 * Nao altera os arquivos do PagBank.
 * Nao desconta estoque antes da confirmacao.
 */

const MP_API = "https://api.mercadopago.com/v1/orders";

const TURNSTILE_API =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const PRODUTOS = {
  1: { nome: "New Balance — Cinza Urbano", valor: 39990 },
  2: { nome: "Nike TN — Edição Iridescente", valor: 44990 },
  3: { nome: "Nike Air Max Plus — Preto e Prata", valor: 42990 },
  4: { nome: "Nike Shox — Total Black", valor: 49990 },
  5: { nome: "Nike Air Max Plus — Blue Gradient", valor: 44990 },
  6: { nome: "Nike Shox — Marrom Escuro", valor: 48990 },
  7: { nome: "Nike P-6000 — Branco", valor: 37990 },
  8: { nome: "Nike P-6000 — Branco Lateral", valor: 37990 }
};

function responder(dados, status = 200) {
  return Response.json(dados, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

async function validarTurnstile(token, request, env) {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 2048
  ) {
    return false;
  }

  const formulario = new FormData();

  formulario.append("secret", env.TURNSTILE_SECRET_KEY);
  formulario.append("response", token);

  const ip = request.headers.get("CF-Connecting-IP");

  if (ip) {
    formulario.append("remoteip", ip);
  }

  try {
    const resposta = await fetch(TURNSTILE_API, {
      method: "POST",
      body: formulario,
      signal: AbortSignal.timeout(10000)
    });

    if (!resposta.ok) {
      return false;
    }

    const dados = await resposta.json();

    return (
      dados.success === true &&
      dados.hostname === "urban-kicks.pages.dev"
    );
  } catch (erro) {
    console.error(
      "TURNSTILE_ERRO",
      String(erro)
    );

    return false;
  }
}

async function verificarEstoque(DB, produtos) {
  for (const item of produtos) {
    const registro = await DB.prepare(`
      SELECT quantidade
      FROM estoque
      WHERE produto_id = ?
        AND CAST(tamanho AS TEXT) = ?
    `).bind(
      item.id,
      item.tamanho
    ).first();

    if (
      !registro ||
      !Number.isSafeInteger(Number(registro.quantidade)) ||
      Number(registro.quantidade) < item.quantidade
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

function validarOrderId(id) {
  return (
    typeof id === "string" &&
    id.length >= 1 &&
    id.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

export async function onRequestPost({ request, env }) {
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
    !Array.isArray(entrada.items) ||
    entrada.items.length < 1 ||
    entrada.items.length > 20
  ) {
    return responder({
      erro: "Carrinho invalido"
    }, 400);
  }

  const seguro = await validarTurnstile(
    entrada.turnstileToken,
    request,
    env
  );

  if (!seguro) {
    return responder({
      erro: "Verificacao de seguranca invalida"
    }, 403);
  }

  const email = String(
    entrada.email || ""
  ).trim();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return responder({
      erro: "Informe um e-mail valido"
    }, 400);
  }

  const agrupados = new Map();

  for (const item of entrada.items) {
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
      return responder({
        erro: "Produto, tamanho ou quantidade invalida"
      }, 400);
    }

    const chave = id + "-" + tamanho;

    const acumulado =
      (agrupados.get(chave)?.quantidade || 0) +
      quantidade;

    if (acumulado > 5) {
      return responder({
        erro: "Limite de 5 unidades por tamanho"
      }, 400);
    }

    agrupados.set(chave, {
      id,
      tamanho,
      quantidade: acumulado
    });
  }

  const produtos = [
    ...agrupados.values()
  ];

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
      "MP_ESTOQUE_ERRO",
      String(erro)
    );

    return responder({
      erro: "Nao foi possivel consultar estoque"
    }, 503);
  }

  const totalCentavos = produtos.reduce(
    (total, item) => {
      return (
        total +
        PRODUTOS[item.id].valor * item.quantidade
      );
    },
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

  const valor = (
    totalCentavos / 100
  ).toFixed(2);

  const referencia =
    "UK-MP-" + crypto.randomUUID();

  /*
   * Registra pedido e itens no D1.
   * Nenhuma unidade e descontada aqui.
   */

  try {
    const comandos = [
      env.DB.prepare(`
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
          'TESTE_MP'
        )
      `).bind(
        referencia,
        totalCentavos
      )
    ];

    for (const item of produtos) {
      comandos.push(
        env.DB.prepare(`
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
            AND ambiente = 'TESTE_MP'
        `).bind(
          item.id,
          PRODUTOS[item.id].nome,
          item.tamanho,
          item.quantidade,
          PRODUTOS[item.id].valor,
          referencia
        )
      );
    }

    await env.DB.batch(comandos);
  } catch (erro) {
    console.error(
      "MP_D1_PREPARAR",
      String(erro)
    );

    return responder({
      erro: "Falha ao registrar pedido"
    }, 503);
  }

  /*
   * Cria a Order PIX no Mercado Pago.
   */

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
    const resposta = await fetch(MP_API, {
      method: "POST",
      headers: {
        Authorization:
          "Bearer " +
          env.MERCADOPAGO_ACCESS_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Idempotency-Key":
          crypto.randomUUID()
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(20000)
    });

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
        erro: "Mercado Pago recusou o pagamento",
        referencia,
        statusMercadoPago: resposta.status
      }, 502);
    }
  } catch (erro) {
    console.error(
      "MP_ORDER_REDE",
      String(erro)
    );

    return responder({
      erro: "Falha de comunicacao com Mercado Pago",
      referencia,
      mensagem:
        "Verifique o pedido antes de tentar novamente."
    }, 502);
  }

  /*
   * Validacao corrigida:
   * nao exige prefixo ORD.
   */

  const orderId = ordem?.id;

  if (!validarOrderId(orderId)) {
    console.error(
      "MP_ORDER_ID_INVALIDO",
      JSON.stringify({
        tipo: typeof orderId
      })
    );

    return responder({
      erro: "Identificador da order invalido",
      referencia
    }, 502);
  }

  /*
   * Salva o identificador da Order no D1.
   */

  try {
    const salvo = await env.DB.prepare(`
      UPDATE pedidos
      SET
        checkout_id = ?,
        status = 'PENDENTE',
        atualizado_em = CURRENT_TIMESTAMP
      WHERE referencia = ?
        AND ambiente = 'TESTE_MP'
        AND status = 'PREPARANDO'
        AND checkout_id IS NULL
    `).bind(
      orderId,
      referencia
    ).run();

    if (salvo.meta?.changes !== 1) {
      throw new Error(
        "Pedido nao atualizado"
      );
    }
  } catch (erro) {
    console.error(
      "MP_D1_SALVAR",
      String(erro)
    );

    return responder({
      erro:
        "Order criada, mas nao registrada corretamente",
      referencia,
      mensagem:
        "Nao efetue o pagamento. Contate a loja."
    }, 503);
  }

  /*
   * Extrai os dados do PIX.
   */

  const pagamento =
    ordem?.transactions?.payments?.[0];

  const metodo =
    pagamento?.payment_method || {};

  const copiaECola =
    typeof metodo.qr_code === "string"
      ? metodo.qr_code
      : null;

  const qrCodeBase64 =
    typeof metodo.qr_code_base64 === "string"
      ? metodo.qr_code_base64
      : null;

  const ticketUrl =
    typeof metodo.ticket_url === "string" &&
    metodo.ticket_url.startsWith(
      "https://www.mercadopago.com.br/"
    )
      ? metodo.ticket_url
      : null;

  return responder({
    referencia,
    orderId,
    ambiente: "TESTE_MP",
    status: "PENDENTE",
    statusMercadoPago:
      ordem.status || null,
    valorTotal: totalCentavos,
    pix: {
      copiaECola,
      qrCodeBase64,
      ticketUrl
    },
    mensagem:
      "Pagamento ainda nao confirmado. Aguarde a conciliacao."
  });
}

export function onRequestGet() {
  return responder({
    erro:
      "Metodo nao permitido. Utilize POST."
  }, 405);
}
