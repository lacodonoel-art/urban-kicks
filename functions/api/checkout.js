
const PRODUTOS = {
  6: {
    nome: "Nike Shox — Marrom Escuro",
    valor: 48990,
    tamanhos: ["43"]
  },
  2: {
    nome: "Nike TN — Edição Iridescente",
    valor: 44990,
    tamanhos: ["44"]
  }
};

const responder = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN) {
    return responder(
      { erro: "Token PagBank não configurado" },
      503
    );
  }

  let pedido;

  try {
    pedido = await request.json();
  } catch {
    return responder({ erro: "JSON inválido" }, 400);
  }

  if (!Array.isArray(pedido.items) ||
      pedido.items.length === 0 ||
      pedido.items.length > 20) {
    return responder({ erro: "Carrinho inválido" }, 400);
  }

  const itens = [];

  for (const item of pedido.items) {
    const produto = PRODUTOS[item.id];

    if (!produto ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 5 ||
        !produto.tamanhos.includes(String(item.size))) {
      return responder(
        { erro: "Produto, tamanho ou quantidade inválida" },
        400
      );
    }

    itens.push({
      reference_id: String(item.id) + "-" + item.size,
      name: produto.nome + " - Tamanho " + item.size,
      quantity: item.quantity,
      unit_amount: produto.valor
    });
  }

  const referencia = "UK-" + crypto.randomUUID();

  try {
    const resposta = await fetch(
      "https://sandbox.api.pagseguro.com/checkouts",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.PAGBANK_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          reference_id: referencia,
          items: itens,
          payment_methods: [
            { type: "PIX" },
            { type: "CREDIT_CARD" }
          ],
          return_url: "https://urban-kicks.pages.dev/"
        })
      }
    );

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      return responder({
        erro: "PagBank recusou a criação do checkout",
        statusPagBank: resposta.status,
        detalhes: dados.error_messages || dados.message || null
      }, 502);
    }

    const link = dados.links?.find(
      item => item.rel === "PAY"
    )?.href;

    if (!link || !link.startsWith("https://")) {
      return responder(
        { erro: "Link de pagamento não recebido" },
        502
      );
    }

    return responder({
      checkoutUrl: link,
      referencia
    });

  } catch {
    return responder(
      { erro: "Falha de comunicação com PagBank" },
      502
    );
  }
}
