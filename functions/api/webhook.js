
// Urban Kicks - Webhook PagBank Sandbox
// Recebe notificacoes e verifica a autenticidade.
// Nao confirma pedidos nem altera estoque nesta etapa.

const API = 'https://sandbox.api.pagseguro.com';

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
}

function compararSeguro(a, b) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
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
  if (
    typeof assinatura !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(assinatura)
  ) {
    return false;
  }

  const mensagem = token + '-' + corpo;

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(mensagem)
  );

  return compararSeguro(
    hex(digest),
    assinatura.toLowerCase()
  );
}

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN) {
    return responder({
      erro: 'Token PagBank nao configurado'
    }, 503);
  }

  const tamanhoMaximo = 200000;

  const tamanhoInformado = Number(
    request.headers.get('content-length')
  );

  if (tamanhoInformado > tamanhoMaximo) {
    return responder({
      erro: 'Notificacao muito grande'
    }, 413);
  }

  let corpo;

  try {
    corpo = await request.text();
  } catch (erro) {
    return responder({
      erro: 'Nao foi possivel ler a notificacao'
    }, 400);
  }

  if (!corpo || corpo.length > tamanhoMaximo) {
    return responder({
      erro: 'Corpo da notificacao invalido'
    }, 400);
  }

  const assinatura = request.headers.get(
    'x-authenticity-token'
  );

  if (!assinatura) {
    return responder({
      erro: 'Assinatura ausente'
    }, 401);
  }

  let autenticado = false;

  try {
    autenticado = await validarAssinatura(
      corpo,
      assinatura,
      env.PAGBANK_TOKEN
    );
  } catch (erro) {
    return responder({
      erro: 'Falha na verificacao da assinatura'
    }, 503);
  }

  if (!autenticado) {
    return responder({
      erro: 'Assinatura invalida'
    }, 401);
  }

  let evento;

  try {
    evento = JSON.parse(corpo);
  } catch (erro) {
    return responder({
      erro: 'JSON invalido'
    }, 400);
  }

  if (
    !evento ||
    typeof evento !== 'object' ||
    Array.isArray(evento)
  ) {
    return responder({
      erro: 'Evento invalido'
    }, 400);
  }

  const status = evento.status || null;

  // A notificacao foi autenticada.
  // Ainda nao registra pedidos pagos.
  // Ainda nao altera estoque.
  //
  // Proximas etapas:
  // 1. Criar banco Cloudflare D1.
  // 2. Registrar os pedidos.
  // 3. Conferir valores e status dos pagamentos.
  // 4. Evitar processamento duplicado.
  // 5. Atualizar estoque com seguranca.

  return responder({
    recebido: true,
    autenticado: true,
    processado: false,
    status: status,
    mensagem: 'Notificacao recebida para testes'
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido'
  }, 405);
}
