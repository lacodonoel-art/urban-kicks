
/*
 * URBAN KICKS
 * WEBHOOK MERCADO PAGO - AMBIENTE DE TESTE
 * Cloudflare Pages Functions + D1
 *
 * POST /api/webhook-mercadopago
 *
 * Valida assinatura HMAC-SHA256.
 * Consulta a order na API oficial.
 * Confere referencia, valor e pagamento.
 * Registra pagamento e desconta estoque
 * em uma operacao atomica no D1.
 */

const API = "https://api.mercadopago.com/v1/orders/";
const LIMITE_CORPO = 100000;

function json(dados, status = 200) {
  return Response.json(dados, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function compararHex(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
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

async function validarAssinatura(request, segredo) {
  const url = new URL(request.url);

  const id = url.searchParams.get("data.id");
  const tipo = url.searchParams.get("type");
  const assinatura = request.headers.get("x-signature");
  const requestId = request.headers.get("x-request-id");

  if (
    tipo !== "order" ||
    !id ||
    !/^ORD[A-Za-z0-9_-]{10,100}$/.test(id) ||
    !assinatura ||
    !requestId ||
    requestId.length > 200
  ) {
    return null;
  }

  const partes = {};

  for (const parte of assinatura.split(",")) {
    const posicao = parte.indexOf("=");

    if (posicao > 0) {
      partes[parte.slice(0, posicao).trim()] =
        parte.slice(posicao + 1).trim();
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

  // Tolerancia de 10 minutos contra replay.
  const numeroTs = Number(ts);
  const instante = ts.length <= 10
    ? numeroTs * 1000
    : numeroTs;

  if (
    !Number.isFinite(instante) ||
    Math.abs(Date.now() - instante) > 600000
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

  const bytes = await crypto.subtle.sign(
    "HMAC",
    chave,
    new TextEncoder().encode(manifesto)
  );

  const calculado = Array.from(
    new Uint8Array(bytes)
  ).map(
    b => b.toString(16).padStart(2, "0")
  ).join("");

  if (!compararHex(calculado, v1.toLowerCase())) {
    return null;
  }

  return id;
}

function centavos(valor) {
  const texto = String(valor ?? "");

  if (!/^\d{1,12}(\.\d{1,2})?$/.test(texto)) {
    return null;
  }

  const [reais, decimais = ""] = texto.split(".");
  const resultado =
    Number(reais) * 100 +
    Number(decimais.padEnd(2, "0"));

  return Number.isSafeInteger(resultado)
    ? resultado
    : null;
}

async function consultarOrder(id, token) {
  const resposta = await fetch(
    API + encodeURIComponent(id),
    {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!resposta.ok) {
    throw new Error(
      "Consulta Mercado Pago HTTP " + resposta.status
    );
  }

  return resposta.json();
}

async function buscarItens(DB, pedido) {
  const consulta = await DB.prepare(`
    SELECT
      produto_id,
      CAST(tamanho AS TEXT) AS tamanho,
      SUM(quantidade) AS quantidade,
      SUM(quantidade * preco_unitario) AS subtotal
    FROM pedido_itens
    WHERE pedido_id = ?
    GROUP BY produto_id, CAST(tamanho AS TEXT)
  `).bind(pedido.id).all();

  const itens = consulta.results || [];

  if (!itens.length) {
    throw new Error("Pedido sem itens");
  }

  let total = 0;

  for (const item of itens) {
    if (
      !Number.isSafeInteger(item.produto_id) ||
      item.produto_id < 1 ||
      !/^(3[4-9]|4[0-4])$/.test(item.tamanho) ||
      !Number.isSafeInteger(item.quantidade) ||
      item.quantidade < 1 ||
      !Number.isSafeInteger(item.subtotal) ||
      item.subtotal < 1
    ) {
      throw new Error("Item do pedido invalido");
    }

    total += item.subtotal;
  }

  if (total !== pedido.valor_total) {
    throw new Error("Total dos itens divergente");
  }

  return itens;
}

export async function onRequestPost({ request, env }) {
  if (
    !env.DB ||
    !env.MERCADOPAGO_ACCESS_TOKEN ||
    !env.MERCADOPAGO_WEBHOOK_SECRET
  ) {
    return json({
      erro: "Configuracao incompleta"
    }, 503);
  }

  const tamanho = Number(
    request.headers.get("content-length") || 0
  );

  if (
    !Number.isFinite(tamanho) ||
    tamanho > LIMITE_CORPO
  ) {
    return json({
      erro: "Notificacao muito grande"
    }, 413);
  }

  let corpo;

  try {
    corpo = await request.text();
  } catch {
    return json({
      erro: "Falha ao ler notificacao"
    }, 400);
  }

  if (
    !corpo ||
    new TextEncoder().encode(corpo).length > LIMITE_CORPO
  ) {
    return json({
      erro: "Corpo invalido"
    }, 400);
  }

  let orderId;

  try {
    orderId = await validarAssinatura(
      request,
      env.MERCADOPAGO_WEBHOOK_SECRET
    );
  } catch {
    return json({
      erro: "Falha na verificacao da assinatura"
    }, 503);
  }

  if (!orderId) {
    return json({
      erro: "Assinatura invalida ou expirada"
    }, 401);
  }

  let evento;

  try {
    evento = JSON.parse(corpo);
  } catch {
    return json({
      erro: "JSON invalido"
    }, 400);
  }

  if (
    evento?.type !== "order" ||
    evento?.live_mode !== false ||
    evento?.data?.id !== orderId
  ) {
    return json({
      erro: "Evento de teste invalido"
    }, 400);
  }

  let order;

  try {
    order = await consultarOrder(
      orderId,
      env.MERCADOPAGO_ACCESS_TOKEN
    );
  } catch (erro) {
    console.error("MP_CONSULTA", String(erro));

    return json({
      erro: "Falha ao consultar order"
    }, 503);
  }

  if (
    order?.id !== orderId ||
    typeof order.external_reference !== "string"
  ) {
    return json({
      erro: "Order inconsistente"
    }, 409);
  }

  let pedido;

  try {
    pedido = await env.DB.prepare(`
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
        AND ambiente = 'TESTE_MP'
      LIMIT 1
    `).bind(
      order.external_reference,
      orderId
    ).first();
  } catch (erro) {
    console.error("MP_BUSCAR_PEDIDO", String(erro));

    return json({
      erro: "Falha ao localizar pedido"
    }, 503);
  }

  if (!pedido) {
    return json({
      erro: "Pedido de teste nao encontrado"
    }, 404);
  }

  if (pedido.status === "PAGO") {
    return json({
      recebido: true,
      pedidoId: pedido.id,
      status: "PAGO",
      jaProcessado: true,
      estoqueAlterado: false
    });
  }

  if (pedido.status !== "PENDENTE") {
    return json({
      recebido: true,
      pedidoId: pedido.id,
      status: pedido.status,
      processado: false
    });
  }

  const pagamentos = order?.transactions?.payments;

  if (
    order.status !== "processed" ||
    order.status_detail !== "accredited"
  ) {
    return json({
      recebido: true,
      pedidoId: pedido.id,
      pagamentoConfirmado: false,
      estoqueAlterado: false
    });
  }

  // Apenas uma transacao paga e aceita
  // automaticamente nesta integracao.
  if (
    !Array.isArray(pagamentos) ||
    pagamentos.length !== 1
  ) {
    return json({
      erro: "Transacoes exigem revisao manual",
      processado: false
    }, 409);
  }

  const pagamento = pagamentos[0];

  if (
    pagamento?.status !== "processed" ||
    pagamento?.status_detail !== "accredited" ||
    typeof pagamento.id !== "string" ||
    !/^PAY[A-Za-z0-9_-]{10,100}$/.test(pagamento.id)
  ) {
    return json({
      erro: "Pagamento nao validado",
      processado: false
    }, 409);
  }

  if (
    !Number.isSafeInteger(pedido.valor_total) ||
    pedido.valor_total <= 0 ||
    order.currency_id !== "BRL" ||
    centavos(order.total_amount) !== pedido.valor_total ||
    centavos(order.total_paid_amount) !== pedido.valor_total ||
    centavos(pagamento.amount) !== pedido.valor_total ||
    centavos(pagamento.paid_amount) !== pedido.valor_total
  ) {
    return json({
      erro: "Valor ou moeda divergente",
      processado: false
    }, 409);
  }

  const metodo =
    pagamento.payment_method?.type || "desconhecido";

  let itens;

  try {
    itens = await buscarItens(env.DB, pedido);
  } catch (erro) {
    console.error("MP_ITENS", String(erro));

    return json({
      erro: "Itens do pedido inconsistentes"
    }, 409);
  }

  const comandos = [];

  // UNIQUE(pedido_id) na tabela de pagamentos
  // protege contra confirmacao duplicada.
  comandos.push(env.DB.prepare(`
    INSERT INTO pagamentos_mercadopago (
      pedido_id,
      order_id,
      pagamento_id,
      valor,
      moeda,
      status,
      metodo
    )
    VALUES (?, ?, ?, ?, 'BRL', 'PAGO', ?)
  `).bind(
    pedido.id,
    orderId,
    pagamento.id,
    pedido.valor_total,
    metodo
  ));

  // Falha a transacao se o pedido ja mudou
  // de estado antes da atualizacao.
  comandos.push(env.DB.prepare(`
    UPDATE pedidos
    SET status = CASE
          WHEN status = 'PENDENTE' THEN 'PAGO'
          ELSE NULL
        END,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE id = ?
      AND ambiente = 'TESTE_MP'
  `).bind(pedido.id));

  for (const item of itens) {
    // Nao permite estoque negativo.
    comandos.push(env.DB.prepare(`
      UPDATE estoque
      SET quantidade = CASE
            WHEN quantidade >= ?
            THEN quantidade - ?
            ELSE NULL
          END,
          atualizado_em = CURRENT_TIMESTAMP
      WHERE produto_id = ?
        AND CAST(tamanho AS TEXT) = ?
    `).bind(
      item.quantidade,
      item.quantidade,
      item.produto_id,
      item.tamanho
    ));

    // Falha se nao existir a numeracao.
    comandos.push(env.DB.prepare(`
      INSERT INTO estoque (
        produto_id,
        tamanho,
        quantidade
      )
      SELECT NULL, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM estoque
        WHERE produto_id = ?
          AND CAST(tamanho AS TEXT) = ?
      )
    `).bind(
      item.produto_id,
      item.tamanho
    ));
  }

  try {
    // D1.batch executa em transacao.
    // Se um comando falhar, ocorre rollback.
    await env.DB.batch(comandos);
  } catch (erro) {
    console.error(
      "MP_CONFIRMACAO_D1",
      erro instanceof Error
        ? erro.message
        : String(erro)
    );

    return json({
      erro: "Confirmacao inconclusa",
      pedidoId: pedido.id,
      mensagem:
        "Verifique o D1 antes de repetir."
    }, 503);
  }

  console.log("MP_PEDIDO_CONFIRMADO", {
    pedidoId: pedido.id,
    referencia: pedido.referencia,
    orderId
  });

  return json({
    recebido: true,
    pedidoId: pedido.id,
    referencia: pedido.referencia,
    status: "PAGO",
    pagamentoConfirmado: true,
    estoqueAlterado: true,
    produtosAtualizados: itens.map(item => ({
      produtoId: item.produto_id,
      tamanho: item.tamanho,
      quantidadeDescontada: item.quantidade
    }))
  });
}

export function onRequestGet() {
  return json({
    erro: "Metodo nao permitido. Utilize POST."
  }, 405);
}
