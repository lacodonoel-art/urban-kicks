
/* URBAN KICKS - Checkout PagBank de produção protegido por Turnstile */

const SITE_URL = 'https://urban-kicks.pages.dev';
const PAGBANK_API = 'https://api.pagseguro.com/checkouts';
const TURNSTILE_API = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const PRODUTOS = {
  1: { nome: 'New Balance — Cinza Urbano', valor: 39990 },
  2: { nome: 'Nike TN — Edição Iridescente', valor: 44990 },
  3: { nome: 'Nike Air Max Plus — Preto e Prata', valor: 42990 },
  4: { nome: 'Nike Shox — Total Black', valor: 49990 },
  5: { nome: 'Nike Air Max Plus — Blue Gradient', valor: 44990 },
  6: { nome: 'Nike Shox — Marrom Escuro', valor: 48990 },
  7: { nome: 'Nike P-6000 — Branco', valor: 37990 },
  8: { nome: 'Nike P-6000 — Branco Lateral', valor: 37990 }
};

function responder(dados, status = 200) {
  return Response.json(dados, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function linkValido(link) {
  if (typeof link !== 'string') return false;

  try {
    const url = new URL(link);

    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        'pagamento.pagbank.com.br',
        'pagamento.pagseguro.uol.com.br'
      ].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function validarTurnstile(token, request, env) {
  if (
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 2048
  ) {
    return { valido: false, motivo: 'Token ausente' };
  }

  const dados = new FormData();
  dados.append('secret', env.TURNSTILE_SECRET_KEY);
  dados.append('response', token);

  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) dados.append('remoteip', ip);

  let resposta;

  try {
    resposta = await fetch(TURNSTILE_API, {
      method: 'POST',
      body: dados,
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { valido: false, indisponivel: true };
  }

  if (!resposta.ok) {
    return { valido: false, indisponivel: true };
  }

  const resultado = await resposta.json().catch(() => null);

  if (
    !resultado ||
    resultado.success !== true ||
    resultado.hostname !== 'urban-kicks.pages.dev'
  ) {
    return { valido: false };
  }

  return { valido: true };
}

async function consultarEstoque(DB, produtos) {
  for (const item of produtos) {
    const estoque = await DB.prepare(`
      SELECT quantidade FROM estoque
      WHERE produto_id = ?
        AND CAST(tamanho AS TEXT) = ?
    `).bind(item.id, item.tamanho).first();

    const quantidade = Number(estoque?.quantidade);

    if (
      !estoque ||
      !Number.isSafeInteger(quantidade) ||
      quantidade < item.quantidade
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

// Registra somente informações de diagnóstico.
// Não registra tokens, dados de cartão ou dados pessoais.
function registrarErroPagBank(status, dados) {
  const mensagens = Array.isArray(dados?.error_messages)
    ? dados.error_messages.map(item => ({
        code: typeof item?.code === 'string'
          ? item.code.slice(0, 100)
          : null,
        description: typeof item?.description === 'string'
          ? item.description.slice(0, 300)
          : null,
        parameter_name: typeof item?.parameter_name === 'string'
          ? item.parameter_name.slice(0, 100)
          : null
      }))
    : null;

  console.error('PAGBANK_PRODUCAO_HTTP', {
    status,
    codigo: typeof dados?.error === 'string'
      ? dados.error.slice(0, 100)
      : typeof dados?.code === 'string'
        ? dados.code.slice(0, 100)
        : null,
    mensagens
  });
}

export async function onRequestPost({ request, env }) {
  if (
    !env.DB ||
    !env.PAGBANK_TOKEN_PRODUCAO ||
    !env.TURNSTILE_SECRET_KEY
  ) {
    return responder({ erro: 'Configuracao incompleta' }, 503);
  }

  let entrada;

  try {
    entrada = await request.json();
  } catch {
    return responder({ erro: 'JSON invalido' }, 400);
  }

  if (
    !entrada ||
    !Array.isArray(entrada.items) ||
    entrada.items.length < 1 ||
    entrada.items.length > 20
  ) {
    return responder({ erro: 'Carrinho invalido' }, 400);
  }

  const verificacao = await validarTurnstile(
    entrada.turnstileToken,
    request,
    env
  );

  if (!verificacao.valido) {
    return responder({
      erro: verificacao.indisponivel
        ? 'Servico de verificacao indisponivel'
        : 'Verificacao de seguranca invalida ou expirada'
    }, verificacao.indisponivel ? 503 : 403);
  }

  const agrupados = new Map();

  for (const item of entrada.items) {
    const id = item?.id;
    const tamanho = String(item?.size ?? '');
    const quantidade = item?.quantity;

    if (
      !Number.isSafeInteger(id) ||
      !Object.prototype.hasOwnProperty.call(PRODUTOS, id) ||
      !/^\d{2}$/.test(tamanho) ||
      Number(tamanho) < 34 ||
      Number(tamanho) > 44 ||
      !Number.isSafeInteger(quantidade) ||
      quantidade < 1 ||
      quantidade > 5
    ) {
      return responder({
        erro: 'Produto, tamanho ou quantidade invalida'
      }, 400);
    }

    const chave = id + '-' + tamanho;

    const acumulado =
      (agrupados.get(chave)?.quantidade || 0) + quantidade;

    if (acumulado > 5) {
      return responder({
        erro: 'Limite por produto e tamanho excedido'
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
        erro: 'Estoque insuficiente',
        produtoId: disponibilidade.produtoId,
        tamanho: disponibilidade.tamanho
      }, 409);
    }
  } catch (erro) {
    console.error('ERRO_ESTOQUE_PRODUCAO', String(erro));

    return responder({
      erro: 'Falha na verificacao do estoque'
    }, 503);
  }

  const itens = produtos.map(item => ({
    reference_id: item.id + '-' + item.tamanho,
    name: PRODUTOS[item.id].nome +
      ' - Tamanho ' + item.tamanho,
    quantity: item.quantidade,
    unit_amount: PRODUTOS[item.id].valor
  }));

  const valorTotal = produtos.reduce(
    (total, item) =>
      total + PRODUTOS[item.id].valor * item.quantidade,
    0
  );

  if (
    !Number.isSafeInteger(valorTotal) ||
    valorTotal <= 0
  ) {
    return responder({ erro: 'Valor invalido' }, 400);
  }

  const referencia = 'UK-' + crypto.randomUUID();

  try {
    const comandos = [
      env.DB.prepare(`
        INSERT INTO pedidos
          (referencia, checkout_id, status, valor_total, ambiente)
        VALUES (?, NULL, 'PREPARANDO', ?, 'PRODUCAO')
      `).bind(referencia, valorTotal)
    ];

    for (const item of produtos) {
      comandos.push(
        env.DB.prepare(`
          INSERT INTO pedido_itens
          (
            pedido_id,
            produto_id,
            produto_nome,
            tamanho,
            quantidade,
            preco_unitario
          )
          SELECT id, ?, ?, ?, ?, ?
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
    console.error('ERRO_PREPARAR_PEDIDO', String(erro));

    return responder({
      erro: 'Falha ao preparar pedido no D1'
    }, 503);
  }

  let dadosPagBank;

  try {
    const resposta = await fetch(PAGBANK_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.PAGBANK_TOKEN_PRODUCAO,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-idempotency-key': referencia
      },
      body: JSON.stringify({
        reference_id: referencia,
        items: itens,
        payment_methods: [
          { type: 'PIX' },
          { type: 'CREDIT_CARD' }
        ],
        return_url: SITE_URL + '/',
        payment_notification_urls: [
          SITE_URL + '/api/webhook'
        ],
        notification_urls: [
          SITE_URL + '/api/webhook'
        ]
      }),
      signal: AbortSignal.timeout(20000)
    });

    dadosPagBank = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      registrarErroPagBank(resposta.status, dadosPagBank);

      return responder({
        erro: 'PagBank recusou o checkout real',
        referencia,
        statusPagBank: resposta.status
      }, 502);
    }
  } catch (erro) {
    console.error(
      'ERRO_PAGBANK_PRODUCAO',
      String(erro)
    );

    return responder({
      erro: 'Falha na comunicacao com PagBank',
      referencia,
      mensagem: 'Verifique o pedido antes de tentar novamente.'
    }, 502);
  }

  const checkoutId = dadosPagBank?.id;

  if (
    typeof checkoutId !== 'string' ||
    !/^CHEC_[A-F0-9-]{36}$/i.test(checkoutId)
  ) {
    return responder({
      erro: 'Checkout real sem identificador valido',
      referencia
    }, 502);
  }

  try {
    const salvo = await env.DB.prepare(`
      UPDATE pedidos
      SET checkout_id = ?,
          atualizado_em = CURRENT_TIMESTAMP
      WHERE referencia = ?
        AND ambiente = 'PRODUCAO'
        AND status = 'PREPARANDO'
        AND checkout_id IS NULL
    `).bind(checkoutId, referencia).run();

    if (salvo.meta?.changes !== 1) {
      throw new Error('Checkout nao registrado');
    }
  } catch (erro) {
    console.error(
      'ERRO_SALVAR_CHECKOUT_ID',
      String(erro)
    );

    return responder({
      erro: 'Checkout criado, mas nao registrado',
      referencia,
      mensagem: 'Nao efetue pagamento. Revisao necessaria.'
    }, 503);
  }

  const link = Array.isArray(dadosPagBank.links)
    ? dadosPagBank.links.find(
        item => item.rel === 'PAY'
      )?.href
    : null;

  if (!linkValido(link)) {
    return responder({
      erro: 'Link de pagamento real nao validado',
      referencia,
      checkoutId
    }, 502);
  }

  try {
    const resultado = await env.DB.prepare(`
      UPDATE pedidos
      SET status = 'PENDENTE',
          atualizado_em = CURRENT_TIMESTAMP
      WHERE referencia = ?
        AND ambiente = 'PRODUCAO'
        AND status = 'PREPARANDO'
        AND checkout_id = ?
    `).bind(referencia, checkoutId).run();

    if (resultado.meta?.changes !== 1) {
      throw new Error('Pedido nao ativado');
    }
  } catch (erro) {
    console.error(
      'ERRO_ATIVAR_PEDIDO',
      String(erro)
    );

    return responder({
      erro: 'Checkout criado, mas pedido nao ativado',
      referencia,
      checkoutId,
      mensagem: 'Nao efetue pagamento. Verifique o D1.'
    }, 503);
  }

  console.log('CHECKOUT_PRODUCAO_CRIADO', {
    referencia,
    checkoutId,
    valorTotal
  });

  return responder({
    checkoutUrl: link,
    referencia,
    checkoutId,
    ambiente: 'PRODUCAO',
    status: 'PENDENTE',
    valorTotal
  });
}

export function onRequestGet() {
  return responder({
    erro: 'Metodo nao permitido. Utilize POST.'
  }, 405);
}
