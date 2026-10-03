// PROVA DE POSSE DO @.
//
// O problema: até aqui, quem tinha a chave de ativação virava dono dos dados de
// uma live — e nada ligava essa pessoa ao streamer. Uma chave vazada, um print
// no grupo errado, e alguém cadastra a live de outro. Do lado jurídico é pior
// ainda: não existia nenhum papel dizendo que o streamer autorizou.
//
// A solução que não depende de OAuth do TikTok (que exige app aprovado): o
// streamer põe um código na própria bio e a gente lê. Quem consegue escrever na
// bio de um @ é dono daquele @ — é a mesma prova que o Google e o Cloudflare
// usam pra domínio, com o TXT no DNS.
//
// A bio vem no HTML público do perfil, sem login e sem assinatura:
//
//   __UNIVERSAL_DATA_FOR_REHYDRATION__
//     -> __DEFAULT_SCOPE__['webapp.user-detail'].userInfo.user
//        { uniqueId, nickname, signature, id }
//
// O `uniqueId` de volta é o que impede um redirecionamento silencioso levar a
// gente a conferir o perfil errado, e o `id` é o userId do TikTok — o mesmo que
// aparece no linkMicBattle, o que deixa o @ amarrado a um id de verdade.
const crypto = require('crypto');

// Sem I, L, O, 0 e 1: alguém vai copiar isto de uma tela pra bio, no celular.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIXO = 'RANKING-';
const TAMANHO = 6;

const VALIDADE_MS = 30 * 60 * 1000;     // o cadastro acontece numa sentada só
const ESPERA_ENTRE_TENTATIVAS_MS = 8000; // não martelar o TikTok
const TEMPO_LIMITE_MS = 12000;

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
// o celular recebe uma página diferente (233KB contra 420KB) pela mesma URL:
// é outro caminho de renderização, e por isso é uma porta de verdade
const UA_CELULAR = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
                 + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 '
                 + 'Mobile/15E148 Safari/604.1';

// desafios abertos, por @. Fica em memória de propósito: é um código de 30
// minutos usado numa sessão só, e persistir isso seria guardar segredo à toa.
const abertos = new Map();
const ultimaTentativa = new Map();

const normalizar = dono => String(dono || '').trim().replace(/^@/, '').toLowerCase();

function sortear(quantos) {
  const bytes = crypto.randomBytes(quantos);
  let saida = '';
  for (let i = 0; i < quantos; i++) saida += ALFABETO[bytes[i] % ALFABETO.length];
  return saida;
}

// Abre (ou devolve) o desafio de um @. Pedir de novo NÃO troca o código: a
// pessoa já colou ele na bio, e trocar faria a conferência falhar por culpa
// nossa.
function desafiar(dono) {
  const chave = normalizar(dono);
  if (!chave) return null;
  const agora = Date.now();
  const atual = abertos.get(chave);
  if (atual && atual.expiraEm > agora) return { ...atual };

  const novo = {
    dono: chave,
    codigo: PREFIXO + sortear(TAMANHO),
    criadoEm: agora,
    expiraEm: agora + VALIDADE_MS
  };
  abertos.set(chave, novo);
  return { ...novo };
}

function doDono(dono) {
  const atual = abertos.get(normalizar(dono));
  if (!atual) return null;
  if (atual.expiraEm <= Date.now()) { abertos.delete(atual.dono); return null; }
  return atual;
}

// ---------- AS PORTAS ----------
// Mais de uma de propósito. Em 02/10 o TikTok barrou a leitura do perfil no
// meio de um teste (limite por IP) — com uma porta só, o cadastro inteiro
// pararia naquele dia. Cada porta é um caminho diferente; quando uma fecha, as
// outras continuam.

async function baixar(url, ua, buscar) {
  const parar = new AbortController();
  const relogio = setTimeout(() => parar.abort(), TEMPO_LIMITE_MS);
  try {
    const r = await buscar(url, {
      headers: {
        'user-agent': ua,
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        referer: 'https://www.tiktok.com/'
      },
      signal: parar.signal
    });
    if (!r.ok) return { erro: `o TikTok respondeu ${r.status}` };
    return { texto: await r.text() };
  } catch (e) {
    const porTempo = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    return { erro: porTempo ? 'o TikTok demorou demais' : 'não consegui abrir o perfil' };
  } finally {
    clearTimeout(relogio);
  }
}

// PORTA 1 — a melhor. JSON de 12KB, e é a rota que o próprio conector usa pra
// descobrir a sala de um @. Contrato de dados, não formato de tela: não
// depende de raspar um <script> de dentro de 420KB de HTML.
async function pelaApiLive(chave, buscar) {
  const url = 'https://www.tiktok.com/api-live/user/room/'
            + '?aid=1988&sourceType=54&uniqueId=' + encodeURIComponent(chave);
  const r = await baixar(url, UA_PC, buscar);
  if (r.erro) return { ok: false, motivo: r.erro };

  let dados;
  try { dados = JSON.parse(r.texto); }
  catch (e) { return { ok: false, motivo: 'a resposta não veio em JSON' }; }

  // "esse @ não existe" é resposta, não bloqueio: para a cascata aqui em vez
  // de bater nas outras portas à toa
  if (dados && /not_?found/i.test(String(dados.message || ''))) {
    return { ok: false, definitivo: true, motivo: 'esse @ não existe no TikTok' };
  }
  const u = dados && dados.data && dados.data.user;
  if (!u || !u.uniqueId) return { ok: false, motivo: 'a resposta veio sem o perfil' };

  return {
    ok: true,
    dono: normalizar(u.uniqueId),
    userId: String(u.id || ''),
    nickname: String(u.nickname || ''),
    bio: String(u.signature || '')
  };
}

// PORTAS 2 e 3 — o HTML do perfil. As duas têm a mesma estrutura, então um
// parser só serve; o que muda é o user-agent, e com ele a página que vem.
async function peloHtml(chave, buscar, ua) {
  const r = await baixar('https://www.tiktok.com/@' + encodeURIComponent(chave), ua, buscar);
  if (r.erro) return { ok: false, motivo: r.erro };

  const bloco = r.texto.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  // Sem o bloco: foi o TikTok que barrou (checagem de bot, limite por IP). A
  // página de "@ não existe" VEM com o bloco, com o erro dentro.
  if (!bloco) return { ok: false, motivo: 'a página veio sem os dados do perfil' };

  let dados;
  try { dados = JSON.parse(bloco[1]); }
  catch (e) { return { ok: false, motivo: 'os dados do perfil vieram quebrados' }; }

  const u = dados?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user;
  if (!u) return { ok: false, definitivo: true, motivo: 'esse @ não existe ou está sem perfil público' };

  return {
    ok: true,
    dono: normalizar(u.uniqueId),
    userId: String(u.id || ''),
    nickname: String(u.nickname || ''),
    bio: String(u.signature || '')
  };
}

const PORTAS = [
  { nome: 'api-live', abrir: (c, b) => pelaApiLive(c, b) },
  { nome: 'html', abrir: (c, b) => peloHtml(c, b, UA_PC) },
  { nome: 'html-celular', abrir: (c, b) => peloHtml(c, b, UA_CELULAR) }
];

// O perfil público, por qualquer porta que abrir. Devolve o que dá pra provar:
// o @ que o TikTok confirmou, o id numérico dele e a bio.
async function lerPerfil(dono, buscar = fetch) {
  const chave = normalizar(dono);
  if (!chave) return { ok: false, motivo: 'sem @ pra conferir' };

  const tentativas = [];
  for (const porta of PORTAS) {
    let r;
    try { r = await porta.abrir(chave, buscar); }
    catch (e) { r = { ok: false, motivo: (e && e.message) || 'estourou' }; }

    if (r.ok) {
      // O @ que voltou TEM que ser o que eu pedi. Sem isto, um redirecionamento
      // levaria a conferência pro perfil errado sem ninguém notar.
      if (r.dono && r.dono !== chave) {
        return { ok: false, definitivo: true,
                 motivo: `o TikTok devolveu o perfil de @${r.dono}` };
      }
      return { ...r, dono: chave, porta: porta.nome, tentativas };
    }

    tentativas.push(porta.nome + ': ' + r.motivo);
    // resposta definitiva (o @ não existe, ou veio outro perfil): não adianta
    // bater nas outras portas
    if (r.definitivo) return { ok: false, motivo: r.motivo, tentativas };
  }

  // todas fechadas: é bloqueio, e não culpa de quem digitou o @
  return {
    ok: false,
    barrado: true,
    motivo: 'o TikTok não deixou ler o perfil agora. Espere alguns minutos e tente de novo.',
    tentativas
  };
}

// A conferência. Só diz "sim" quando o código aparece na bio DAQUELE @.
async function conferir(dono, buscar = fetch) {
  const chave = normalizar(dono);
  const desafio = doDono(chave);
  if (!desafio) {
    return { ok: false, motivo: 'o código venceu — peça um novo', expirou: true };
  }

  const agora = Date.now();
  const ultima = ultimaTentativa.get(chave) || 0;
  const falta = ESPERA_ENTRE_TENTATIVAS_MS - (agora - ultima);
  if (falta > 0) {
    return { ok: false, motivo: `espere ${Math.ceil(falta / 1000)}s antes de conferir de novo`,
             esperar: Math.ceil(falta / 1000) };
  }
  ultimaTentativa.set(chave, agora);

  const perfil = await lerPerfil(chave, buscar);
  if (!perfil.ok) {
    return { ok: false, motivo: perfil.motivo, barrado: perfil.barrado,
             tentativas: perfil.tentativas };
  }

  // comparação frouxa de propósito: o TikTok às vezes devolve a bio com espaço
  // e quebra de linha diferentes do que a pessoa digitou
  const limpo = t => String(t || '').replace(/\s+/g, '').toUpperCase();
  if (!limpo(perfil.bio).includes(limpo(desafio.codigo))) {
    return {
      ok: false,
      motivo: 'não achei o código na bio. Salve a bio no TikTok e tente de novo.',
      bioLida: perfil.bio.slice(0, 200)
    };
  }

  abertos.delete(chave);
  ultimaTentativa.delete(chave);
  return {
    ok: true,
    dono: chave,
    userId: perfil.userId,
    nickname: perfil.nickname,
    codigo: desafio.codigo,
    // por qual porta a leitura passou: se uma morrer, é assim que se descobre
    porta: perfil.porta,
    provadoEm: Date.now()
  };
}

// pros testes e pra quem quiser limpar na mão
function esquecer(dono) {
  const chave = normalizar(dono);
  abertos.delete(chave);
  ultimaTentativa.delete(chave);
}

module.exports = {
  desafiar, conferir, lerPerfil, esquecer, normalizar, PORTAS,
  VALIDADE_MS, ESPERA_ENTRE_TENTATIVAS_MS, PREFIXO
};
