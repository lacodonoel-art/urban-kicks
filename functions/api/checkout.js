
const PRODUTOS = {
  "nike-shox-marrom-43": {
    nome: "Nike Shox - Marrom Escuro - 43",
    valor: 48990
  }
};

export async function onRequestPost({ request, env }) {
  const json = (dados, status = 200) =>
    new Response(JSON.stringify(dados), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });

  if (!env.PAGBANK_TOKEN) {
    return json({ erro: "Token PagBank não configurado" }, 503);
  }

  let pedido;
  try {
    pedido = await request.json();
  } catch {
    return json({ erro: "JSON inválido" }, 400);
  }

  const produto = PRODUTOS[pedido.produtoId];
  const quantidade = pedido.quantidade;

  if (!produto || !Number.isInteger(quantidade) ||
      quantidade < 1 || quantidade > 5) {
    return json({ erro: "Produto ou quantidade inválida" }, 400);
  }

  const referencia = "UK-" + crypto.randomUUID();

  const resposta = await fetch(
    "https://api.pagseguro.com/checkouts",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.PAGBANK_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        reference_id: referencia,
        items: [{
          reference_id: pedido.produtoId,
          name: produto.nome,
          quantity: quantidade,
          unit_amount: produto.valor
        }],
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
    return json({
      erro: "PagBank recusou a criação do checkout",
      statusPagBank: resposta.status
    }, 502);
  }

  const link = dados.links?.find(item => item.rel === "PAY")?.href;

  if (!link || !link.startsWith("https://")) {
    return json({ erro: "Link de pagamento não recebido" }, 502);
  }

  return json({ checkoutUrl: link, referencia });
}
