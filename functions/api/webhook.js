
```javascript
// Urban Kicks — Webhook PagBank Sandbox
// Valida a autenticidade das notificações.
// Ainda não altera estoque nem registra pedidos em banco de dados.

const API = 'https://sandbox.api.pagseguro.com';

function responder(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function bytesBase64(valor) {
  const binario = atob(valor);
  return Uint8Array.from(binario, c => c.charCodeAt(0));
}

async function validarAssinaturaAntiga(corpo, assinatura, token) {
  if (!/^[a-f0-9]{64}$/i.test(assinatura)) return false;

  const texto = `${token}-${corpo}`;
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(texto)
  );

  const calculado = [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Comparação sem saída antecipada.
  let diferenca = 0;
  const recebido = assinatura.toLowerCase();

  for (let i = 0; i < calculado.length; i++) {
    diferenca |= calculado.charCodeAt(i) ^
      recebido.charCodeAt(i);
  }

  return diferenca === 0;
}

async function validarAssinaturaNova(corpo, assinaturas, token) {
  const resposta = await fetch(
    `${API}/public-keys?type=webhook`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    }
  );

  if (!resposta.ok) {
    throw new Error('Chave pública indisponível');
  }

  const dados = await resposta.json();

  if (!dados.public_key) {
    throw new Error('Chave pública ausente');
  }

  const chave = await crypto.subtle.importKey(
    'spki',
    bytesBase64(dados.public_key),
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    false,
    ['verify']
  );

  const mensagem = new TextEncoder().encode(corpo);

  for (const assinatura of assinaturas) {
    try {
      // Assinatura DER recebida do PagBank.
      // Converte para o formato IEEE P1363 do Web Crypto.
      const der = bytesBase64(assinatura);
      const p1363 = derParaP1363(der);

      const valida = await crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: 'SHA-256'
        },
        chave,
        p1363,
        mensagem
      );

      if (valida) return true;
    } catch {
      // Tenta a próxima assinatura.
    }
  }

  return false;
}

function derParaP1363(der) {
  let pos = 0;

  function tamanho() {
    let n = der[pos++];

    if (n < 128) return n;

    const bytes = n & 0x7f;

    if (bytes < 1 || bytes > 2) {
      throw new Error('DER inválido');
    }

    n = 0;

    for (let i = 0; i < bytes; i++) {
      n = (n << 8) | der[pos++];
    }

    return n;
  }

  if (der[pos++] !== 0x30) {
    throw new Error('DER inválido');
  }

  const comprimento = tamanho();

  if (pos + comprimento !== der.length) {
    throw new Error('DER inválido');
  }

  function inteiro() {
    if (der[pos++] !== 0x02) {
      throw new Error('Inteiro DER inválido');
    }

    const n = tamanho();
    const valor = der.slice(pos, pos + n);
    pos += n;

    if (!n || n > 33 || valor.length !== n) {
      throw new Error('Inteiro DER inválido');
    }

    let inicio = 0;

    while (
      inicio < valor.length - 1 &&
      valor[inicio] === 0
    ) {
      inicio++;
    }

    const numero = valor.slice(inicio);

    if (numero.length > 32) {
      throw new Error('Inteiro grande demais');
    }

    const saida = new Uint8Array(32);
    saida.set(numero, 32 - numero.length);

    return saida;
  }

  const r = inteiro();
  const s = inteiro();

  if (pos !== der.length) {
    throw new Error('DER com dados extras');
  }

  const resultado = new Uint8Array(64);
  resultado.set(r, 0);
  resultado.set(s, 32);

  return resultado;
}

export async function onRequestPost({ request, env }) {
  if (!env.PAGBANK_TOKEN) {
    return responder(
      { erro: 'Token PagBank não configurado' },
      503
    );
  }

  const corpo = await request.text();

  if (!corpo || corpo.length > 200000) {
    return responder({ erro: 'Corpo inválido' }, 400);
  }

  const assinaturaNova =
    request.headers.get('x-payload-signature');

  const assinaturaAntiga =
    request.headers.get('x-authenticity-token');

  if (!assinaturaNova && !assinaturaAntiga) {
    return responder(
      { erro: 'Assinatura ausente' },
      401
    );
  }

  let autentico = false;

  try {
    if (assinaturaNova) {
      const assinaturas = assinaturaNova
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      autentico = await validarAssinaturaNova(
        corpo,
        assinaturas,
        env.PAGBANK_TOKEN
      );
    } else {
      autentico = await validarAssinaturaAntiga(
        corpo,
        assinaturaAntiga,
        env.PAGBANK_TOKEN
      );
    }
  } catch {
    return responder(
      { erro: 'Não foi possível validar a assinatura' },
      503
    );
  }

  if (!autentico) {
    return responder(
      { erro: 'Assinatura inválida' },
      401
    );
  }

  let evento;

  try {
    evento = JSON.parse(corpo);
  } catch {
    return responder({ erro: 'JSON inválido' }, 400);
  }

  const status = evento.status || null;

  const estados = [
    'PAID',
    'AUTHORIZED',
    'WAITING',
    'IN_ANALYSIS',
    'DECLINED',
    'CANCELED',
    'EXPIRED'
  ];

  if (status && !estados.includes(status)) {
    return responder({
      recebido: true,
      processado: false,
      motivo: 'Status não tratado'
    });
  }

  // Nesta etapa, somente confirmamos que o evento
  // passou pela validação de autenticidade.
  //
  // Na próxima etapa, adicionaremos:
  // - banco de dados D1;
  // - identificação do pedido;
  // - prevenção de processamento duplicado;
  // - confirmação do valor;
  // - atualização segura do estoque.

  return responder({
    recebido: true,
    autenticado: true,
    status,
    processado: false,
    mensagem: 'Aguardando integração com banco de dados'
  });
}

export function onRequestGet() {
  return responder(
    { erro: 'Método não permitido' },
    405
  );
}
```
