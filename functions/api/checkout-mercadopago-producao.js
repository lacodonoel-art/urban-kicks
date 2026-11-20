
/*
 * URBAN KICKS
 * Checkout Mercado Pago - PIX e Cartao de Credito
 * Cloudflare Pages Functions + D1
 *
 * Rota: POST /api/checkout-mercadopago-producao
 *
 * Requer:
 * env.DB
 * env.MERCADOPAGO_ACCESS_TOKEN_PRODUCAO
 * env.TURNSTILE_SECRET_KEY
 *
 * ATENCAO:
 * Este endpoint cria pagamentos.
 * A confirmacao definitiva e a baixa de estoque
 * devem acontecer no webhook validado.
 */

const MP_API = "https://api.mercadopago.com/v1/orders";
const TURNSTILE_API =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const PRODUTOS = {
  1: { nome: "New Balance - Cinza Urbano", preco: 39990 },
  2: { nome: "Nike TN - Edicao Iridescente", preco: 44990 },
  3: { nome: "Nike Air Max Plus - Preto e Prata", preco: 42990 },
  4: { nome: "Nike Shox - Total Black", preco: 49990 },
  5: { nome: "Nike Air Max Plus - Blue Gradient", preco: 44990 },
  6: { nome: "Nike Shox - Marrom Escuro", preco: 48990 },
  7: { nome: "Nike P-6000 - Branco", preco: 37990 },
  8: { nome: "Nike P-6000 - Branco Lateral", preco: 37990 }
};

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

function dinheiro(centavos) {
  return (centavos / 100).toFixed(2);
}

function emailValido(email) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function normalizarItens(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new Error("Carrinho invalido.");
  }

  const agrupados = new Map();

  for (const item of items) {
    const id = Number(item.id ?? item.produto_id);
    const tamanho = String(item.size ?? item.tamanho ?? "");
    const quantidade = Number(item.quantity ?? item.quantidade);

    if (
      !Number.isInteger(id) ||
      !PRODUTOS[id] ||
      !/^(3[4-9]|4[0-4])$/.test(tamanho) ||
      !Number.isInteger(quantidade) ||
      quantidade < 1 ||
      quantidade > 5
    ) {
      throw new Error("Produto, tamanho ou quantidade invalida.");
    }

    const chave = id + ":" + tamanho;

    const anterior = agrupados.get(chave);

    if (anterior) {
      anterior.quantidade += quantidade;

      if (anterior.quantidade > 5) {
        throw new Error("Quantidade maxima por tamanho excedida.");
      }
    } else {
      agrupados.set(chave, {
        id,
        tamanho,
        quantidade,
        nome: PRODUTOS[id].nome,
        preco: PRODUTOS[id].preco
      });
    }
  }

  return [...agrupados.values()];
}

async function validarTurnstile(token, env, ip) {
  if (
    typeof token !== "string" ||
    !token ||
    !env.TURNSTILE_SECRET_KEY
  ) {
    return false;
  }

  const form = new FormData();

  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);

  if (ip) {
    form.append("remoteip", ip);
  }

  const resposta = await fetch(TURNSTILE_API, {
    method: "POST",
    body: form
  });

  if (!resposta.ok) {
    return false;
  }

  const resultado = await resposta.json();

  return (
    resultado.success === true &&
    resultado.hostname === "urban-kicks.pages.dev"
  );
}

async function verificarEstoque(db, itens) {
  for (const item of itens) {
    const registro = await db
      .prepare(
        `SELECT COALESCE(SUM(quantidade), 0) AS disponivel
         FROM estoque
         WHERE produto_id = ? AND tamanho = ?`
      )
      .bind(item.id, item.tamanho)
      .first();

    if (Number(registro?.disponivel || 0) < item.quantidade) {
      throw new Error(
        "Estoque insuficiente para " +
        item.nome +
        " tamanho " +
        item.tamanho
      );
    }
  }
}

function prepararPagamento(dados, valor) {
  const tipo = String(
    dados.metodo ?? dados.paymentMethod ?? "pix"
  ).toLowerCase();

  if (tipo === "pix") {
    return {
      tipo: "pix",
      pagamento: {
        amount: valor,
        payment_method: {
          id: "pix",
          type: "bank_transfer"
        }
      }
    };
  }

  if (tipo === "cartao" || tipo === "credit_card") {
    const cartao = dados.cartao || {};

    const token = String(cartao.token || "");
    const bandeira = String(
      cartao.paymentMethodId || cartao.payment_method_id || ""
    ).toLowerCase();

    const parcelas = Number(
      cartao.installments ?? cartao.parcelas
    );

    if (
      !/^[a-zA-Z0-9_-]{8,256}$/.test(token) ||
      !/^[a-z0-9_-]{2,40}$/.test(bandeira) ||
      !Number.isInteger(parcelas) ||
      parcelas < 1 ||
      parcelas > 12
    ) {
      throw new Error(
        "Dados de pagamento do cartao invalidos."
      );
    }

    return {
      tipo: "credit_card",
      pagamento: {
        amount: valor,
        payment_method: {
          id: bandeira,
          type: "credit_card",
          token,
          installments: parcelas
        }
      }
    };
  }

  throw new Error("Forma de pagamento nao permitida.");
}

function extrairPix(ordem) {
  const pagamento = ordem?.transactions?.payments?.[0] || {};
  const metodo = pagamento.payment_method || {};
  const transacao = pagamento.transaction_data || {};

  return {
    copiaECola:
      metodo.qr_code ||
      transacao.qr_code ||
      null,

    qrCodeBase64:
      metodo.qr_code_base64 ||
      transacao.qr_code_base64 ||
      null,

    ticketUrl:
      metodo.ticket_url ||
      transacao.ticket_url ||
      null
  };
}

export async function onRequestPost(context) {
  if (context.env.URBAN_KICKS_PRODUCAO_HABILITADA !== "SIM") {
    return responder({ erro: "Checkout de producao ainda nao habilitado." }, 503);
  }
  const { request, env } = context;

  if (!env.DB || !env.MERCADOPAGO_ACCESS_TOKEN_PRODUCAO) {
    return responder(
      { erro: "Configuracao de pagamento indisponivel." },
      503
    );
  }

  let dados;
  let itens;
  let tipoPagamento;

  try {
    const contentType =
      request.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      return responder(
        { erro: "Envie os dados em JSON." },
        415
      );
    }

    dados = await request.json();

    if (!emailValido(dados.email)) {
      return responder(
        { erro: "Informe um e-mail valido." },
        400
      );
    }

    itens = normalizarItens(dados.items);

    const totalCentavos = itens.reduce(
      (total, item) =>
        total + item.preco * item.quantidade,
      0
    );

    if (
      !Number.isSafeInteger(totalCentavos) ||
      totalCentavos <= 0
    ) {
      return responder(
        { erro: "Valor do pedido invalido." },
        400
      );
    }

    tipoPagamento = prepararPagamento(
      dados,
      dinheiro(totalCentavos)
    );

    const ip = request.headers.get("CF-Connecting-IP");

    const turnstileValido = await validarTurnstile(
      dados.turnstileToken,
      env,
      ip
    );

    if (!turnstileValido) {
      return responder(
        { erro: "Verificacao de seguranca invalida ou expirada." },
        403
      );
    }

    await verificarEstoque(env.DB, itens);

    const referencia = "UK-MP-" + crypto.randomUUID();

    /*
     * Cria o pedido interno ANTES de chamar
     * o Mercado Pago.
     *
     * PREPARANDO nao representa pagamento aprovado.
     */

    const comandos = [
      env.DB.prepare(
        `INSERT INTO pedidos
          (referencia, checkout_id, status, valor_total, ambiente)
         VALUES (?, NULL, 'PREPARANDO', ?, 'PRODUCAO')`
      ).bind(referencia, totalCentavos)
    ];

    for (const item of itens) {
      comandos.push(
        env.DB.prepare(
          `INSERT INTO pedido_itens
           (pedido_id, produto_id, produto_nome,
            tamanho, quantidade, preco_unitario)
           SELECT id, ?, ?, ?, ?, ?
           FROM pedidos
           WHERE referencia = ?`
        ).bind(
          item.id,
          item.nome,
          item.tamanho,
          item.quantidade,
          item.preco,
          referencia
        )
      );
    }

    await env.DB.batch(comandos);

    const corpoMP = {
      type: "online",
      processing_mode: "automatic",
      external_reference: referencia,
      total_amount: dinheiro(totalCentavos),
      payer: {
        email: dados.email.trim()
      },
      transactions: {
        payments: [tipoPagamento.pagamento]
      }
    };

    /*
     * A chave de idempotencia e unica
     * para esta tentativa de criacao.
     */

    const idempotencyKey = crypto.randomUUID();

    let respostaMP;

    try {
      respostaMP = await fetch(MP_API, {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " + env.MERCADOPAGO_ACCESS_TOKEN_PRODUCAO,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify(corpoMP)
      });
    } catch (erro) {
      console.error(
        "MP_ERRO_CONEXAO",
        erro?.message || "Falha de rede"
      );

      return responder(
        {
          erro: "Nao foi possivel confirmar a criacao do pagamento.",
          referencia,
          mensagem:
            "Nao tente pagar novamente antes de verificar o pedido."
        },
        502
      );
    }

    const ordem = await respostaMP.json().catch(() => ({}));

    if (!respostaMP.ok) {
      console.error(
        "MP_ERRO_API",
        respostaMP.status,
        JSON.stringify({
          error: ordem.error || null,
          code: ordem.code || null,
          message: ordem.message || null,
          cause: ordem.cause || null
        }).slice(0, 1500),
        "referencia:", referencia
      );

      // Somente respostas 4xx definitivas podem ser classificadas como
      // rejeicao. Em 5xx/429 a API pode ter criado o pagamento: manter
      // PREPARANDO para conciliacao e impedir cobranca duplicada.
      const rejeicaoDefinitiva =
        respostaMP.status >= 400 &&
        respostaMP.status < 500 &&
        respostaMP.status !== 408 &&
        respostaMP.status !== 409 &&
        respostaMP.status !== 425 &&
        respostaMP.status !== 429;

      if (rejeicaoDefinitiva) {
        try {
          await env.DB.prepare(
            `UPDATE pedidos
             SET status = 'FALHA', atualizado_em = CURRENT_TIMESTAMP
             WHERE referencia = ? AND ambiente = 'PRODUCAO'
               AND status = 'PREPARANDO' AND checkout_id IS NULL`
          ).bind(referencia).run();
        } catch (erroAtualizacao) {
          console.error("MP_FALHA_REGISTRAR_REJEICAO", referencia,
            erroAtualizacao?.message || "Erro D1");
        }
      }

      return responder(
        {
          erro: "Mercado Pago nao concluiu a solicitacao.",
          referencia,
          codigo: respostaMP.status,
          mensagem: rejeicaoDefinitiva
            ? "Solicitacao rejeitada. Verifique os dados antes de tentar novamente."
            : "Resultado incerto. Verifique o pedido antes de tentar pagar novamente."
        },
        502
      );
    }

    const orderId = String(ordem.id || "");

    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
      console.error("MP_ORDER_ID_INVALIDO");

      return responder(
        {
          erro: "Resposta inesperada do Mercado Pago.",
          referencia
        },
        502
      );
    }

    if (
      ordem.external_reference &&
      ordem.external_reference !== referencia
    ) {
      console.error("MP_REFERENCIA_DIVERGENTE");

      return responder(
        {
          erro: "Divergencia na referencia do pagamento.",
          referencia
        },
        502
      );
    }

    /*
     * Vincula a order ao pedido interno.
     *
     * Nenhum estoque e descontado aqui.
     */

    const atualizacao = await env.DB.prepare(
      `UPDATE pedidos
       SET checkout_id = ?,
           status = 'PENDENTE',
           atualizado_em = CURRENT_TIMESTAMP
       WHERE referencia = ?
         AND ambiente = 'PRODUCAO'
         AND status = 'PREPARANDO'
         AND checkout_id IS NULL`
    ).bind(orderId, referencia).run();

    if (atualizacao.meta?.changes !== 1) {
      console.error(
        "MP_FALHA_VINCULO_PEDIDO",
        referencia,
        orderId
      );

      return responder(
        {
          erro: "Pagamento criado, mas pedido requer verificacao.",
          referencia,
          mensagem:
            "Nao repita a cobranca automaticamente."
        },
        503
      );
    }

    const statusMP = String(ordem.status || "unknown");
    const detalheMP = String(ordem.status_detail || "");

    const pagamentoRetornado =
      ordem.transactions?.payments?.[0] || {};

    const resultado = {
      referencia,
      orderId,
      ambiente: "PRODUCAO",
      metodo: tipoPagamento.tipo,
      status: "PENDENTE",
      statusMercadoPago: statusMP,
      detalheMercadoPago: detalheMP,
      valorTotal: dinheiro(totalCentavos),
      pagamentoId:
        pagamentoRetornado.id || null
    };

    if (tipoPagamento.tipo === "pix") {
      resultado.pix = extrairPix(ordem);
    }

    /*
     * Mesmo que a API retorne processed,
     * a confirmacao definitiva e feita
     * pelo backend de conciliacao/webhook.
     */

    resultado.mensagem =
      "Pagamento registrado. Aguarde confirmacao.";

    return responder(resultado, 200);

  } catch (erro) {
    console.error(
      "MP_CHECKOUT_ERRO",
      erro?.message || "Erro inesperado"
    );

    const mensagem = String(erro?.message || "");

    if (
      mensagem.includes("Carrinho invalido") ||
      mensagem.includes("Produto, tamanho") ||
      mensagem.includes("Quantidade maxima") ||
      mensagem.includes("Dados de pagamento") ||
      mensagem.includes("Forma de pagamento") ||
      mensagem.includes("Valor do pedido")
    ) {
      return responder({ erro: mensagem }, 400);
    }

    if (mensagem.includes("Estoque insuficiente")) {
      return responder({ erro: mensagem }, 409);
    }

    return responder(
      { erro: "Nao foi possivel processar o checkout." },
      500
    );
  }
}

export async function onRequestGet() {
  return responder(
    { erro: "Metodo nao permitido. Utilize POST." },
    405
  );
}
