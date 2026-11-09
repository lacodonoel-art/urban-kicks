
/*
 * URBAN KICKS - WEBHOOK PAGBANK SANDBOX
 *
 * Recebe notificacoes autenticadas do PagBank.
 * Identifica pedidos por referencia, checkout
 * ou identificador de ordem.
 *
 * Reutiliza confirmar-pagamento.js.
 *
 * Funciona com todos os produtos cadastrados
 * e numeracoes de 34 a 44.
 *
 * Nao autoriza multiplas cobrancas automaticamente.
 * Nao altera estoque diretamente.
 *
 * Assinatura SHA-256 antiga: suportada.
 * Assinatura ECDSA nova: bloqueada ate validacao.
 */

import {
  onRequestPost as confirmarPagamento
} from "./confirmar-pagamento.js";

const API = "https://sandbox.api.pagseguro.com";
const LIMITE_CORPO = 200000;

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
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
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diferenca === 0;
}

async function validarAssinatura(corpo, assinatura, token) {
  if (!/^[a-f0-9]{64}$/i.test(assinatura || "")) {
    return false;
  }

  const mensagem = token + "-" + corpo;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(mensagem)
  );

  const hexadecimal = Array.from(
    new Uint8Array(digest)
  ).map(
    byte => byte.toString(16).padStart(2, "0")
  ).join("");

  return compararSeguro(
    hexadecimal,
    assinatura.toLowerCase()
  );
}

function idValido(valor, prefixo) {
  return (
    typeof valor === "string" &&
    new RegExp(
      "^" + prefixo + "_[A-F0-9-]{36}$",
      "i"
    ).test(valor)
  );
}

async function consultarPagBank(caminho, token) {
  const resposta = await fetch(API + caminho, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!resposta.ok) {
    throw new Error(
      "Consulta PagBank HTTP " + resposta.status
    );
  }

  return resposta.json();
}

function identificarEvento(evento, request) {
  const referencia =
    typeof evento.reference_id === "string"
      ? evento.reference_id
      : null;

  const checkoutId =
    idValido(evento.checkout_id, "CHEC")
      ? evento.checkout_id
      : null;

  const ordemId =
    idValido(evento.id, "ORDE")
      ? evento.id
      : idValido(evento.order_id, "ORDE")
        ? evento.order_id
        : idValido(evento.metadata?.ps_order_id, "ORDE")
          ? evento.metadata.ps_order_id
          : null;

  const origem = request.headers.get(
    "x-product-origin"
  );

  const produtoId = request.headers.get(
    "x-product-id"
  );

  const checkoutHeader =
    origem === "CHECKOUT" &&
    idValido(produtoId, "CHEC")
      ? produtoId
      : null;

  const ordemHeader =
    origem === "ORDER" &&
    idValido(produtoId, "ORDE")
      ? produtoId
      : null;

  return {
    referencia,
    checkoutId: checkoutId || checkoutHeader,
    ordemId: ordemId || ordemHeader
  };
}

async function localizarPedido(DB, identificacao, token) {
  let {
    referencia,
    checkoutId,
    ordemId
  } = identificacao;

  /*
   * Quando o evento identifica uma ordem,
   * consultar o PagBank para obter sua
   * referencia oficial.
   *
   * Nao confiar somente nos campos enviados
   * pela notificacao.
   */

  if (ordemId) {
    const ordem = await consultarPagBank(
      "/orders/" + encodeURIComponent(ordemId),
      token
    );

    if (
      ordem.id !== ordemId ||
      typeof ordem.reference_id !== "string"
    ) {
      throw new Error(
        "Ordem PagBank sem referencia valida"
      );
    }

    if (
      referencia &&
      referencia !== ordem.reference_id
    ) {
      throw new Error(
        "Referencia do evento divergente"
      );
    }

    referencia = ordem.reference_id;
  }

  if (!referencia && !checkoutId) {
    return null;
  }

  let pedido;

  if (referencia && checkoutId) {
    pedido = await DB.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE referencia = ?
        AND checkout_id = ?
      LIMIT 1
    `).bind(referencia, checkoutId).first();

  } else if (referencia) {
    pedido = await DB.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE referencia = ?
      LIMIT 1
    `).bind(referencia).first();

  } else {
    pedido = await DB.prepare(`
      SELECT
        id,
        referencia,
        checkout_id,
        status,
        valor_total
      FROM pedidos
      WHERE checkout_id = ?
      LIMIT 1
    `).bind(checkoutId).first();
  }

  if (!pedido) {
    return null;
  }

  /*
   * Se uma ordem foi informada, conferir
   * se realmente pertence ao checkout local.
   */

  if (ordemId) {
    const checkout = await consultarPagBank(
      "/checkouts/" +
      encodeURIComponent(pedido.checkout_id),
      token
    );

    if (
      checkout.id !== pedido.checkout_id ||
      checkout.reference_id !== pedido.referencia ||
      !Array.isArray(checkout.orders) ||
      !checkout.orders.some(o => o.id === ordemId)
    ) {
      throw new Error(
        "Ordem nao pertence ao checkout local"
      );
    }
  }

  return pedido;
}

async function executarConfirmacao(pedidoId, env, url) {
  /*
   * Reutiliza a funcao administrativa existente.
   * Nao autoriza pagamentos duplicados.
   */

  const requisicao = new Request(
    new URL("/api/confirmar-pagamento", url),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": env.CONSULTA_ADMIN_KEY
      },
      body: JSON.stringify({
        pedidoId,
        autorizarConfirmacao: false
      })
    }
  );

  const resposta = await confirmarPagamento({
    request: requisicao,
    env
  });

  const dados = await resposta.json();

  return {
    statusHTTP: resposta.status,
    dados
  };
}

export async function onRequestPost({ request, env }) {
  if (
    !env.DB ||
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY
  ) {
    return responder({
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
    new TextEncoder().encode(corpo).length > LIMITE_CORPO
  ) {
    return responder({
      erro: "Corpo invalido"
    }, 400);
  }

  const assinaturaAntiga = request.headers.get(
    "x-authenticity-token"
  );

  const assinaturaNova = request.headers.get(
    "x-payload-signature"
  );

  /*
   * ECDSA ainda nao suportada.
   * Nao processar sem validar assinatura.
   */

  if (assinaturaNova) {
    console.warn("WEBHOOK", {
      etapa: "autenticacao",
      resultado: "ECDSA_NAO_SUPORTADA"
    });

    return responder({
      erro: "Assinatura ECDSA nao suportada",
      processado: false
    }, 503);
  }

  if (!assinaturaAntiga) {
    console.warn("WEBHOOK", {
      etapa: "autenticacao",
      resultado: "ASSINATURA_AUSENTE"
    });

    return responder({
      erro: "Assinatura ausente",
      processado: false
    }, 401);
  }

  let autenticado;

  try {
    autenticado = await validarAssinatura(
      corpo,
      assinaturaAntiga,
      env.PAGBANK_TOKEN
    );
  } catch {
    return responder({
      erro: "Falha ao validar assinatura"
    }, 503);
  }

  if (!autenticado) {
    console.warn("WEBHOOK", {
      etapa: "autenticacao",
      resultado: "ASSINATURA_INVALIDA"
    });

    return responder({
      erro: "Assinatura invalida",
      processado: false
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
    !evento ||
    typeof evento !== "object" ||
    Array.isArray(evento)
  ) {
    return responder({
      erro: "Evento invalido"
    }, 400);
  }

  const identificacao = identificarEvento(
    evento,
    request
  );

  console.log("WEBHOOK", {
    etapa: "evento_autenticado",
    possuiReferencia: Boolean(
      identificacao.referencia
    ),
    possuiCheckout: Boolean(
      identificacao.checkoutId
    ),
    possuiOrdem: Boolean(
      identificacao.ordemId
    )
  });

  let pedido;

  try {
    pedido = await localizarPedido(
      env.DB,
      identificacao,
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    console.error(
      "WEBHOOK LOCALIZACAO",
      erro instanceof Error ? erro.message : erro
    );

    return responder({
      erro: "Falha ao validar pedido",
      processado: false
    }, 503);
  }

  if (!pedido) {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: false,
      processado: false,
      mensagem: "Pedido nao identificado"
    }, 422);
  }

  /*
   * Evita processar pedidos ja pagos.
   */

  if (pedido.status === "PAGO") {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: "PAGO",
      jaProcessado: true,
      estoqueAlterado: false
    });
  }

  if (pedido.status !== "PENDENTE") {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: pedido.status,
      processado: false
    }, 409);
  }

  let resultado;

  try {
    resultado = await executarConfirmacao(
      pedido.id,
      env,
      request.url
    );
  } catch (erro) {
    console.error(
      "WEBHOOK CONFIRMACAO",
      erro instanceof Error ? erro.message : erro
    );

    return responder({
      erro: "Falha ao executar confirmacao",
      pedidoId: pedido.id
    }, 503);
  }

  const dados = resultado.dados;

  if (
    resultado.statusHTTP === 200 &&
    dados.pagamentoConfirmado === true
  ) {
    console.log("WEBHOOK", {
      etapa: "pagamento_confirmado",
      pedidoId: pedido.id
    });

    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: "PAGO",
      pagamentoConfirmado: true,
      estoqueAlterado: true,
      mensagem:
        "Pagamento confirmado automaticamente"
    });
  }

  if (
    resultado.statusHTTP === 200 &&
    dados.jaProcessado === true
  ) {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: "PAGO",
      jaProcessado: true,
      estoqueAlterado: false
    });
  }

  if (
    dados.revisaoManual === true &&
    dados.auditoriaRegistrada === true
  ) {
    console.warn("WEBHOOK", {
      etapa: "revisao_manual",
      pedidoId: pedido.id,
      quantidadeCobrancas: dados.quantidadeCobrancas
    });

    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: "PENDENTE",
      revisaoManual: true,
      auditoriaRegistrada: true,
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem:
        "Multiplas cobrancas. Revisao necessaria."
    });
  }

  if (
    dados.pagamentoConfirmado === false &&
    dados.mensagem === "Nenhuma cobranca paga"
  ) {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: "PENDENTE",
      pagamentoConfirmado: false,
      estoqueAlterado: false
    });
  }

  console.error("WEBHOOK", {
    etapa: "conciliacao_inconclusa",
    pedidoId: pedido.id,
    statusHTTP: resultado.statusHTTP
  });

  return responder({
    erro: "Conciliacao inconclusa",
    pedidoId: pedido.id,
    processado: false
  }, 503);
}

export function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido. Utilize POST."
  }, 405);
}
