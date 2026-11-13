
/*
 * URBAN KICKS
 * CHECKOUT DE PRODUCAO PROTEGIDO
 *
 * Cloudflare Pages Functions + D1
 *
 * POST /api/checkout-producao
 *
 * Header:
 * x-checkout-test-key
 *
 * Body:
 * {
 *   "items": [
 *     {"id": 1, "size": "40", "quantity": 1}
 *   ]
 * }
 *
 * Uso exclusivo para teste administrativo.
 */

const SITE_URL = "https://urban-kicks.pages.dev";

const PAGBANK_API =
  "https://api.pagseguro.com/checkouts";

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

function chaveIgual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !a.length ||
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

function linkValido(link) {
  if (typeof link !== "string") {
    return false;
  }

  try {
    const url = new URL(link);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return false;
    }

    return [
      "pagamento.pagbank.com.br",
      "pagamento.pagseguro.uol.com.br"
    ].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function consultarEstoque(DB, produtos) {
  for (const item of produtos) {
    const estoque = await DB.prepare(`
      SELECT quantidade
      FROM estoque
      WHERE produto_id = ?
        AND CAST(tamanho AS TEXT) = ?
    `).bind(
      item.id,
      item.tamanho
    ).first();

    if (
      !estoque ||
      !Number.isSafeInteger(estoque.quantidade) ||
      estoque.quantidade < item.quantidade
    ) {
      return {
        disponivel: false,
        produtoId: item.id,
        tamanho: item.tamanho
      };
    }
  }

  return { disponivel: true };
}

export async function onRequestPost({
  request,
  env
}) {
  // Bloqueia qualquer acesso sem configuracao.
  if (
    !env.DB ||
    !env.PAGBANK_TOKEN_PRODUCAO ||
    !env.CHECKOUT_TESTE_KEY
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  // Autenticacao administrativa obrigatoria.
  if (!chaveIgual(
    request.headers.get("x-checkout-test-key"),
    env.CHECKOUT_TESTE_KEY
  )) {
    return responder({
      erro: "Nao autorizado"
    }, 401);
  }

  // Nao permite carrinhos muito grandes.
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

  const agrupados = new Map();

  for (const item of entrada.items) {
    const id = item?.id;
    const tamanho = String(item?.size ?? "");
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
        erro: "Produto ou quantidade invalida"
      }, 400);
    }

    const chave = id + "-" + tamanho;

    const acumulado =
      (agrupados.get(chave)?.quantidade || 0) +
      quantidade;

    if (acumulado > 5) {
      return responder({
        erro: "Limite por produto e tamanho excedido"
      }, 400);
    }

    agrupados.set(chave, {
      id,
      tamanho,
      quantidade: acumulado
    });
  }

  const produtos = [...agrupados.values()];

  try {
    const disponibilidade = await consultarEstoque(
      env.DB,
      produtos
    );

    if (!disponibilidade.disponivel) {
      return responder({
        erro: "Estoque insuficiente",
        produtoId: disponibilidade.produtoId,
        tamanho: disponibilidade.tamanho
      }, 409);
    }
  } catch (erro) {
    console.error(
      "ERRO_ESTOQUE_PRODUCAO",
      erro instanceof Error ? erro.message : String(erro)
    );

    return responder({
      erro: "Falha na verificacao do estoque"
    }, 503);
  }

  const itens = produtos.map(item => ({
    reference_id: item.id + "-" + item.tamanho,
    name:
      PRODUTOS[item.id].nome +
      " - Tamanho " +
      item.tamanho,
    quantity: item.quantidade,
    unit_amount: PRODUTOS[item.id].valor
  }));

  const valorTotal = produtos.reduce(
    (total, item) =>
      total +
      PRODUTOS[item.id].valor * item.quantidade,
    0
  );

  if (
    !Number.isSafeInteger(valorTotal) ||
    valorTotal <= 0
  ) {
    return responder({
      erro: "Valor invalido"
    }, 400);
  }

  const referencia = "UK-" + crypto.randomUUID();

  /*
   * Registra primeiro o pedido como
   * PREPARANDO. Isso permite rastrear
   * falhas posteriores na API PagBank.
   *
   * O conciliador so consulta pedidos
   * PENDENTE com checkout_id.
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
          'PRODUCAO'
        )
      `).bind(
        referencia,
        valorTotal
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
            id, ?, ?, ?, ?, ?
          FROM pedidos
          WHERE referencia = ?
            AND ambiente = 'PRODUCAO'
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
      "ERRO_PREPARAR_PEDIDO",
      erro instanceof Error ? erro.message : String(erro)
    );

    return responder({
      erro: "Falha ao preparar pedido no D1"
    }, 503);
  }

  /*
   * Cria checkout real.
   * Nao retorna link se nao conseguir
   * salvar o checkout_id no D1.
   */
  let dados;

  try {
    const resposta = await fetch(PAGBANK_API, {
      method: "POST",
      headers: {
        Authorization:
          "Bearer " + env.PAGBANK_TOKEN_PRODUCAO,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-idempotency-key": referencia
      },
      body: JSON.stringify({
        reference_id: referencia,
        items: itens,
        payment_methods: [
          { type: "PIX" },
          { type: "CREDIT_CARD" }
        ],
        return_url: SITE_URL + "/",
        payment_notification_urls: [
          SITE_URL + "/api/webhook"
        ],
        notification_urls: [
          SITE_URL + "/api/webhook"
        ]
      }),
      signal: AbortSignal.timeout(20000)
    });

    dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      console.error(
        "PAGBANK_PRODUCAO_HTTP",
        resposta.status
      );

      return responder({
        erro: "PagBank recusou o checkout real",
        referencia,
        statusPagBank: resposta.status
      }, 502);
    }
  } catch (erro) {
    console.error(
      "ERRO_PAGBANK_PRODUCAO",
      erro instanceof Error ? erro.message : String(erro)
    );

    return responder({
      erro: "Falha na comunicacao com PagBank",
      referencia,
      mensagem:
        "Nao repita a operacao sem verificar o pedido."
    }, 502);
  }

  const checkoutId = dados.id;

  if (
    typeof checkoutId !== "string" ||
    !/^CHEC_[A-F0-9-]{36}$/i.test(checkoutId)
  ) {
    return responder({
      erro: "Checkout real sem identificador valido",
      referencia
    }, 502);
  }

  // Preserva o checkout_id mesmo quando o link de pagamento
  // estiver ausente ou invalido. O pedido continua PREPARANDO
  // e NAO sera selecionado pelo conciliador automatico.
  try {
    const salvo = await env.DB.prepare(`
      UPDATE pedidos
      SET checkout_id = ?, atualizado_em = CURRENT_TIMESTAMP
      WHERE referencia = ?
        AND ambiente = 'PRODUCAO'
        AND status = 'PREPARANDO'
        AND checkout_id IS NULL
    `).bind(checkoutId, referencia).run();

    if (salvo.meta?.changes !== 1) {
      throw new Error('Falha ao registrar checkout_id');
    }
  } catch (erro) {
    console.error('ERRO_SALVAR_CHECKOUT_ID',
      erro instanceof Error ? erro.message : String(erro));
    return responder({
      erro: 'Checkout criado, mas identificador nao registrado',
      referencia,
      mensagem: 'Nao efetue pagamento. Necessaria revisao manual.'
    }, 503);
  }

  const link = Array.isArray(dados.links)
    ? dados.links.find(
        item => item.rel === "PAY"
      )?.href
    : null;

  if (!linkValido(link)) {
    return responder({
      erro: "Link de pagamento real nao validado",
      referencia,
      checkoutId
    }, 502);
  }

  /*
   * Ativa o pedido para conciliacao.
   * O checkout so e devolvido depois
   * que o banco confirma a gravacao.
   */
  try {
    const resultado = await env.DB.prepare(`
      UPDATE pedidos
      SET
        status = 'PENDENTE',
        atualizado_em = CURRENT_TIMESTAMP
      WHERE referencia = ?
        AND ambiente = 'PRODUCAO'
        AND status = 'PREPARANDO'
        AND checkout_id = ?
    `).bind(
      referencia,
      checkoutId
    ).run();

    if (resultado.meta?.changes !== 1) {
      throw new Error(
        "Pedido nao atualizado"
      );
    }
  } catch (erro) {
    console.error(
      "ERRO_ATIVAR_PEDIDO",
      erro instanceof Error ? erro.message : String(erro)
    );

    return responder({
      erro:
        "Checkout criado, mas nao foi possivel ativar o pedido",
      referencia,
      checkoutId,
      mensagem:
        "Nao efetue o pagamento. Verifique o D1."
    }, 503);
  }

  console.log(
    "CHECKOUT_REAL_TESTE_CRIADO",
    {
      referencia,
      checkoutId,
      valorTotal
    }
  );

  return responder({
    checkoutUrl: link,
    referencia,
    checkoutId,
    ambiente: "PRODUCAO",
    status: "PENDENTE",
    valorTotal,
    mensagem:
      "Checkout real criado para teste administrativo."
  });
}

export function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido. Utilize POST."
  }, 405);
}
