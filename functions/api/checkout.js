
/*
 * URBAN KICKS
 * CHECKOUT PAGBANK
 *
 * Cloudflare Pages Functions + D1
 *
 * SANDBOX: ambiente padrao
 * PRODUCAO: ativacao controlada
 *
 * Pagamentos:
 * PIX e cartao de credito
 *
 * O estoque e verificado antes do checkout.
 * O desconto ocorre somente apos pagamento.
 */

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

const SITE_URL =
  "https://urban-kicks.pages.dev";

const AMBIENTES = {
  SANDBOX: {
    api:
      "https://sandbox.api.pagseguro.com/checkouts",
    hostPagamento:
      "pagamento.sandbox.pagbank.com.br"
  },
  PRODUCAO: {
    api:
      "https://api.pagseguro.com/checkouts"
  }
};

function responder(dados, status = 200) {
  return new Response(
    JSON.stringify(dados),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

function ambienteAtual(env) {
  return env.PAGBANK_MODO ===
    "PRODUCAO"
      ? "PRODUCAO"
      : "SANDBOX";
}

function obterToken(env, ambiente) {
  return ambiente === "PRODUCAO"
    ? env.PAGBANK_TOKEN_PRODUCAO
    : env.PAGBANK_TOKEN;
}

function linkPagamentoValido(
  endereco,
  ambiente
) {
  if (typeof endereco !== "string") {
    return false;
  }

  try {
    const url = new URL(endereco);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return false;
    }

    const host =
      url.hostname.toLowerCase();

    if (ambiente === "SANDBOX") {
      return host ===
        AMBIENTES.SANDBOX.hostPagamento;
    }

    const permitidos = [
      "pagamento.pagbank.com.br",
      "pagamento.pagseguro.uol.com.br"
    ];

    return permitidos.includes(host);

  } catch {
    return false;
  }
}

async function verificarEstoque(
  DB,
  produtos
) {
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
      !Number.isSafeInteger(
        estoque.quantidade
      ) ||
      estoque.quantidade <
        item.quantity
    ) {
      return {
        disponivel: false,
        produtoId: item.id,
        tamanho: item.tamanho,
        quantidadeDisponivel:
          Math.max(
            0,
            Number(
              estoque?.quantidade || 0
            )
          )
      };
    }
  }

  return {
    disponivel: true
  };
}

export async function onRequestPost({
  request,
  env
}) {
  if (!env.DB) {
    return responder({
      erro: "Banco D1 nao configurado"
    }, 503);
  }

  const ambiente = ambienteAtual(env);

  /*
   * A producao exige ativacao explicita.
   * Uma configuracao ausente ou incorreta
   * mantem o checkout no Sandbox.
   */
  if (
    ambiente === "PRODUCAO" &&
    env.PAGBANK_PRODUCAO_LIBERADA !==
      "SIM"
  ) {
    return responder({
      erro:
        "Checkout de producao ainda bloqueado",
      ambiente
    }, 503);
  }

  const token = obterToken(
    env,
    ambiente
  );

  if (!token) {
    return responder({
      erro:
        "Token PagBank nao configurado",
      ambiente
    }, 503);
  }

  let pedido;

  try {
    pedido = await request.json();
  } catch {
    return responder({
      erro: "JSON invalido"
    }, 400);
  }

  if (
    !pedido ||
    !Array.isArray(pedido.items) ||
    pedido.items.length < 1 ||
    pedido.items.length > 20
  ) {
    return responder({
      erro: "Carrinho invalido"
    }, 400);
  }

  const agrupados = new Map();

  for (const item of pedido.items) {
    const id = item?.id;
    const tamanho = String(
      item?.size ?? ""
    );
    const quantidade =
      item?.quantity;

    if (
      !Number.isSafeInteger(id) ||
      !Object.prototype.hasOwnProperty.call(
        PRODUTOS,
        id
      ) ||
      !/^\d{2}$/.test(tamanho) ||
      Number(tamanho) < 34 ||
      Number(tamanho) > 44 ||
      !Number.isSafeInteger(
        quantidade
      ) ||
      quantidade < 1 ||
      quantidade > 5
    ) {
      return responder({
        erro:
          "Produto, tamanho ou quantidade invalida"
      }, 400);
    }

    const chave =
      id + "-" + tamanho;

    const total =
      (
        agrupados.get(chave)
          ?.quantity || 0
      ) + quantidade;

    if (total > 5) {
      return responder({
        erro:
          "Limite de 5 unidades por produto e tamanho"
      }, 400);
    }

    agrupados.set(chave, {
      id,
      tamanho,
      quantity: total
    });
  }

  const produtosAgrupados =
    [...agrupados.values()];

  /*
   * Verifica estoque antes de gerar
   * o checkout no PagBank.
   */
  let disponibilidade;

  try {
    disponibilidade =
      await verificarEstoque(
        env.DB,
        produtosAgrupados
      );
  } catch (erro) {
    console.error(
      "ERRO_CONSULTA_ESTOQUE",
      erro instanceof Error
        ? erro.message
        : String(erro)
    );

    return responder({
      erro:
        "Nao foi possivel consultar o estoque"
    }, 503);
  }

  if (!disponibilidade.disponivel) {
    return responder({
      erro:
        "Estoque insuficiente",
      produtoId:
        disponibilidade.produtoId,
      tamanho:
        disponibilidade.tamanho,
      quantidadeDisponivel:
        disponibilidade
          .quantidadeDisponivel
    }, 409);
  }

  const itens =
    produtosAgrupados.map(
      ({
        id,
        tamanho,
        quantity
      }) => ({
        reference_id:
          id + "-" + tamanho,
        name:
          PRODUTOS[id].nome +
          " - Tamanho " +
          tamanho,
        quantity,
        unit_amount:
          PRODUTOS[id].valor
      })
    );

  const valorTotal =
    produtosAgrupados.reduce(
      (total, item) =>
        total +
        PRODUTOS[item.id].valor *
        item.quantity,
      0
    );

  if (
    !Number.isSafeInteger(
      valorTotal
    ) ||
    valorTotal <= 0
  ) {
    return responder({
      erro:
        "Valor total invalido"
    }, 400);
  }

  const referencia =
    "UK-" + crypto.randomUUID();

  const configuracao =
    AMBIENTES[ambiente];

  let dados;

  try {
    const resposta = await fetch(
      configuracao.api,
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " + token,
          "Content-Type":
            "application/json",
          Accept:
            "application/json"
        },
        body: JSON.stringify({
          reference_id:
            referencia,
          items: itens,
          payment_methods: [
            { type: "PIX" },
            { type: "CREDIT_CARD" }
          ],
          return_url:
            SITE_URL + "/",
          payment_notification_urls: [
            SITE_URL +
              "/api/webhook"
          ],
          notification_urls: [
            SITE_URL +
              "/api/webhook"
          ]
        }),
        signal:
          AbortSignal.timeout(20000)
      }
    );

    dados = await resposta
      .json()
      .catch(() => ({}));

    if (!resposta.ok) {
      console.error(
        "PAGBANK_CHECKOUT_ERRO",
        {
          ambiente,
          http: resposta.status
        }
      );

      return responder({
        erro:
          "PagBank recusou a criacao do checkout",
        ambiente,
        statusPagBank:
          resposta.status
      }, 502);
    }

  } catch (erro) {
    console.error(
      "PAGBANK_COMUNICACAO_ERRO",
      {
        ambiente,
        mensagem:
          erro instanceof Error
            ? erro.message
            : String(erro)
      }
    );

    return responder({
      erro:
        "Falha de comunicacao com PagBank",
      ambiente
    }, 502);
  }

  const link = Array.isArray(
    dados.links
  )
    ? dados.links.find(
        item =>
          item.rel === "PAY"
      )?.href
    : null;

  if (
    !linkPagamentoValido(
      link,
      ambiente
    )
  ) {
    console.error(
      "LINK_PAGAMENTO_INVALIDO",
      {
        ambiente,
        checkoutId:
          dados.id || null
      }
    );

    return responder({
      erro:
        "Link de pagamento nao validado",
      ambiente
    }, 502);
  }

  const checkoutId = dados.id;

  if (
    typeof checkoutId !==
      "string" ||
    !/^CHEC_[A-F0-9-]{36}$/i.test(
      checkoutId
    )
  ) {
    return responder({
      erro:
        "Identificador do checkout invalido",
      ambiente
    }, 502);
  }

  /*
   * Registra o pedido e os itens
   * em transacao atomica no D1.
   *
   * O ambiente e salvo explicitamente.
   *
   * Nenhum estoque e descontado
   * neste momento.
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
          ?,
          'PENDENTE',
          ?,
          ?
        )
      `).bind(
        referencia,
        checkoutId,
        valorTotal,
        ambiente
      )
    ];

    for (
      const item of
      produtosAgrupados
    ) {
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
            AND ambiente = ?
        `).bind(
          item.id,
          PRODUTOS[item.id].nome,
          item.tamanho,
          item.quantity,
          PRODUTOS[item.id].valor,
          referencia,
          ambiente
        )
      );
    }

    await env.DB.batch(
      comandos
    );

  } catch (erro) {
    console.error(
      "ERRO_REGISTRO_PEDIDO",
      {
        referencia,
        ambiente,
        mensagem:
          erro instanceof Error
            ? erro.message
            : String(erro)
      }
    );

    return responder({
      erro:
        "Checkout criado, mas pedido nao registrado",
      referencia,
      ambiente,
      mensagem:
        "Nao efetue o pagamento. Contate o suporte da loja."
    }, 503);
  }

  console.log(
    "CHECKOUT_CRIADO",
    {
      referencia,
      ambiente,
      valorTotal,
      checkoutId
    }
  );

  return responder({
    checkoutUrl: link,
    referencia,
    checkoutId,
    ambiente,
    status: "PENDENTE"
  });
}

export function onRequestGet() {
  return responder({
    erro:
      "Metodo nao permitido. Utilize POST."
  }, 405);
}
