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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

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

// O perfil público. Devolve o que dá pra provar: o @ que o TikTok confirmou, o
// id numérico dele e a bio.
async function lerPerfil(dono, buscar = fetch) {
  const chave = normalizar(dono);
  if (!chave) return { ok: false, motivo: 'sem @ pra conferir' };

  const parar = new AbortController();
  const relogio = setTimeout(() => parar.abort(), TEMPO_LIMITE_MS);
  let html;
  try {
    const r = await buscar('https://www.tiktok.com/@' + encodeURIComponent(chave), {
      headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      signal: parar.signal
    });
    if (!r.ok) return { ok: false, motivo: `o TikTok respondeu ${r.status}` };
    html = await r.text();
  } catch (e) {
    const porTempo = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    return { ok: false, motivo: porTempo ? 'o TikTok demorou demais' : 'não consegui abrir o perfil' };
  } finally {
    clearTimeout(relogio);
  }

  const bloco = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  // Sem o bloco: foi o TikTok que barrou (checagem de bot, limite por IP). A
  // página de "@ não existe" VEM com o bloco, com o erro dentro — então a
  // ausência dele não é culpa de quem digitou, e dizer "esse @ não existe"
  // aqui jogaria a pessoa contra a parede no meio do cadastro.
  if (!bloco) {
    return { ok: false, barrado: true,
             motivo: 'o TikTok não deixou ler o perfil agora. '
                   + 'Espere alguns minutos e tente de novo.' };
  }

  let dados;
  try { dados = JSON.parse(bloco[1]); }
  catch (e) { return { ok: false, motivo: 'os dados do perfil vieram quebrados' }; }

  const user = dados?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user;
  if (!user) return { ok: false, motivo: 'esse @ não existe ou está sem perfil público' };

  // O @ que voltou TEM que ser o que eu pedi. Sem isto, um redirecionamento
  // levaria a conferência pro perfil errado sem ninguém notar.
  const voltou = normalizar(user.uniqueId);
  if (voltou && voltou !== chave) {
    return { ok: false, motivo: `o TikTok devolveu o perfil de @${voltou}` };
  }

  return {
    ok: true,
    dono: chave,
    userId: String(user.id || ''),
    nickname: String(user.nickname || ''),
    bio: String(user.signature || '')
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
  if (!perfil.ok) return { ok: false, motivo: perfil.motivo };

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
  desafiar, conferir, lerPerfil, esquecer, normalizar,
  VALIDADE_MS, ESPERA_ENTRE_TENTATIVAS_MS, PREFIXO
};
