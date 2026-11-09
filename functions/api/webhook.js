
/*
 * URBAN KICKS
 * WEBHOOK PAGBANK SANDBOX
 *
 * Cloudflare Pages Functions + D1
 *
 * Integra a notificacao autenticada com:
 * functions/api/confirmar-pagamento.js
 *
 * - Valida assinatura SHA-256 antiga
 * - Nao aceita notificacoes sem assinatura valida
 * - Nao confia apenas no status recebido
 * - Consulta novamente o PagBank pela funcao
 *   de confirmacao existente
 * - Funciona para todos os produtos e tamanhos
 * - Nao autoriza multiplas cobrancas automaticamente
 * - Nao desconta estoque diretamente
 * - Nao usa Hoppscotch para confirmar pagamentos
 *
 * IMPORTANTE:
 * Assinaturas ECDSA novas ainda nao sao suportadas.
 */

import {
  onRequestPost as confirmarPagamento
} from "./confirmar-pagamento.js";

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

function converterHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function validarAssinaturaAntiga(
  corpo,
  assinatura,
  token
) {
  if (!/^[a-f0-9]{64}$/i.test(assinatura || "")) {
    return false;
  }

  const mensagem = token + "-" + corpo;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(mensagem)
  );

  return compararSeguro(
    converterHex(digest),
    assinatura.toLowerCase()
  );
}

function identificarPedido(evento, request) {
  const referencia =
    typeof evento.reference_id === "string"
      ? evento.reference_id
      : null;

  const checkoutEvento =
    typeof evento.checkout_id === "string"
      ? evento.checkout_id
      : null;

  const origem = request.headers.get(
    "x-product-origin"
  );

  const produtoId = request.headers.get(
    "x-product-id"
  );

  const checkoutHeader =
    origem === "CHECKOUT" &&
    /^CHEC_[A-F0-9-]{36}$/i.test(produtoId || "")
      ? produtoId
      : null;

  return {
    referencia,
    checkoutId: checkoutEvento || checkoutHeader
  };
}

async function buscarPedido(DB, identificacao) {
  const { referencia, checkoutId } = identificacao;

  if (referencia && checkoutId) {
    return DB.prepare(`
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
  }

  if (referencia) {
    return DB.prepare(`
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
  }

  if (checkoutId) {
    return DB.prepare(`
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

  return null;
}

export async function onRequestPost({
  request,
  env
}) {
  if (
    !env.DB ||
    !env.PAGBANK_TOKEN ||
    !env.CONSULTA_ADMIN_KEY
  ) {
    return responder({
      erro: "Configuracao incompleta"
    }, 503);
  }

  const tamanhoInformado = Number(
    request.headers.get("content-length") || 0
  );

  if (
    !Number.isFinite(tamanhoInformado) ||
    tamanhoInformado > LIMITE_CORPO
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
   * Nunca processar uma notificacao sem
   * assinatura antiga validada.
   *
   * O formato novo exige verificacao ECDSA
   * e nao pode ser tratado como SHA-256 antigo.
   */

  if (!assinaturaAntiga) {
    if (assinaturaNova) {
      console.warn(
        "WEBHOOK: assinatura ECDSA nao suportada"
      );

      return responder({
        erro: "Formato de assinatura nao suportado",
        processado: false
      }, 503);
    }

    return responder({
      erro: "Assinatura ausente",
      processado: false
    }, 401);
  }

  let autenticado = false;

  try {
    autenticado = await validarAssinaturaAntiga(
      corpo,
      assinaturaAntiga,
      env.PAGBANK_TOKEN
    );
  } catch {
    return responder({
      erro: "Falha na validacao da assinatura"
    }, 503);
  }

  if (!autenticado) {
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

  /*
   * Identificar o pedido no D1.
   *
   * A notificacao nao determina se o
   * pagamento foi aprovado.
   *
   * A verificacao sera feita diretamente
   * na API do PagBank pela funcao existente.
   */

  const identificacao = identificarPedido(
    evento,
    request
  );

  if (
    !identificacao.referencia &&
    !identificacao.checkoutId
  ) {
    console.warn(
      "WEBHOOK: notificacao sem identificador de pedido"
    );

    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: false,
      processado: false,
      mensagem: "Identificador do pedido ausente"
    }, 422);
  }

  let pedido;

  try {
    pedido = await buscarPedido(
      env.DB,
      identificacao
    );
  } catch (erro) {
    console.error(
      "WEBHOOK: falha ao consultar D1",
      erro instanceof Error ? erro.message : erro
    );

    return responder({
      erro: "Falha ao consultar pedido"
    }, 503);
  }

  if (!pedido) {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: false,
      processado: false,
      mensagem: "Pedido nao encontrado"
    }, 404);
  }

  /*
   * Pedido ja confirmado.
   * Nao descontar estoque novamente.
   */

  if (pedido.status === "PAGO") {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: true,
      pedidoId: pedido.id,
      status: "PAGO",
      jaProcessado: true,
      estoqueAlterado: false,
      mensagem: "Pedido ja confirmado"
    });
  }

  if (pedido.status !== "PENDENTE") {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: pedido.status,
      processado: false,
      mensagem: "Pedido requer verificacao administrativa"
    }, 409);
  }

  /*
   * Chamar diretamente a funcao de
   * confirmacao que ja funciona.
   *
   * Nao fazemos uma requisicao HTTP externa.
   * Nao expomos a chave administrativa.
   *
   * autorizarConfirmacao permanece FALSE.
   * Assim, multiplas cobrancas nao sao
   * confirmadas automaticamente.
   */

  let respostaConfirmacao;

  try {
    const requisicaoInterna = new Request(
      new URL(
        "/api/confirmar-pagamento",
        request.url
      ).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": env.CONSULTA_ADMIN_KEY
        },
        body: JSON.stringify({
          pedidoId: pedido.id,
          autorizarConfirmacao: false
        })
      }
    );

    respostaConfirmacao = await confirmarPagamento({
      request: requisicaoInterna,
      env
    });
  } catch (erro) {
    console.error(
      "WEBHOOK: falha na confirmacao",
      erro instanceof Error ? erro.message : erro
    );

    return responder({
      erro: "Falha interna ao confirmar pagamento",
      pedidoId: pedido.id,
      processado: false
    }, 503);
  }

  let resultado;

  try {
    resultado = await respostaConfirmacao.json();
  } catch {
    return responder({
      erro: "Resposta de confirmacao invalida",
      pedidoId: pedido.id
    }, 503);
  }

  /*
   * Confirmacao realizada com sucesso.
   */

  if (
    respostaConfirmacao.ok &&
    resultado.pagamentoConfirmado === true
  ) {
    console.log("WEBHOOK PAGAMENTO CONFIRMADO", {
      pedidoId: pedido.id,
      status: "PAGO"
    });

    return responder({
      recebido: true,
      autenticado: true,
      pedidoEncontrado: true,
      pedidoId: pedido.id,
      status: "PAGO",
      pagamentoConfirmado: true,
      estoqueAlterado: resultado.estoqueAlterado === true,
      mensagem: "Pagamento confirmado automaticamente"
    });
  }

  /*
   * Pedido confirmado por outra requisicao
   * enquanto este webhook era processado.
   */

  if (
    respostaConfirmacao.ok &&
    resultado.jaProcessado === true
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

  /*
   * Multiplas cobrancas:
   * auditoria registrada, sem baixa de estoque.
   */

  if (
    resultado.revisaoManual === true &&
    resultado.auditoriaRegistrada === true
  ) {
    console.warn("WEBHOOK REVISAO MANUAL", {
      pedidoId: pedido.id,
      quantidadeCobrancas:
        resultado.quantidadeCobrancas
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
        "Multiplas cobrancas. Revisao administrativa necessaria."
    });
  }

  /*
   * Nenhuma cobranca paga encontrada.
   * A notificacao foi autenticada, mas
   * o pedido continua pendente.
   */

  if (
    resultado.pagamentoConfirmado === false &&
    resultado.mensagem === "Nenhuma cobranca paga"
  ) {
    return responder({
      recebido: true,
      autenticado: true,
      pedidoId: pedido.id,
      status: "PENDENTE",
      pagamentoConfirmado: false,
      estoqueAlterado: false,
      mensagem: "Pagamento ainda nao confirmado"
    });
  }

  /*
   * Outros erros devem ser investigados.
   * Nao afirmar que o pedido foi pago.
   */

  console.error("WEBHOOK CONCILIACAO INCONCLUSA", {
    pedidoId: pedido.id,
    statusConfirmacao: respostaConfirmacao.status,
    erro: resultado.erro || "Desconhecido"
  });

  return responder({
    erro: "Conciliacao inconclusa",
    pedidoId: pedido.id,
    pagamentoConfirmado: false,
    estoqueAlterado: false
  }, 503);
}

export function onRequestGet() {
  return responder({
    erro: "Metodo nao permitido. Utilize POST."
  }, 405);
}
