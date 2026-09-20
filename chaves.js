// ============================================================================
// CHAVES DE ATIVAÇÃO
// ----------------------------------------------------------------------------
// O jeito antigo de entregar acesso era o administrador inventar um usuário e
// uma senha e mandar por fora — WhatsApp, Instagram, sei lá. Três problemas:
// a senha trafega em texto por onde não devia, quem recebe quase nunca troca,
// e o administrador fica sabendo a senha do cliente pra sempre.
//
// Com chave, o administrador só decide DE QUAL LIVE aquele acesso é. O nome de
// usuário e a senha são escolhidos pela própria pessoa, na hora de ativar, e
// nunca passam pela mão de ninguém.
//
// A chave é de uso único e vence. Depois de ativada ela vira um registro do
// que aconteceu (quem ativou, quando) — não é apagada, pra o painel conseguir
// mostrar o histórico.
// ============================================================================
const fs = require('fs');
const crypto = require('crypto');

// Mesmo disco persistente do users.json (Railway apaga o resto no deploy).
const ARQUIVO = process.env.RAILWAY_ENVIRONMENT ? '/data/chaves.json' : 'chaves.json';

// Sem I, L, O, 0 e 1: a pessoa vai ler isso de um print ou de uma mensagem e
// digitar na mão. Ambiguidade aqui vira "a chave não funciona" no suporte.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BLOCOS = 3;
const POR_BLOCO = 4;

const VALIDADE_PADRAO_DIAS = 7;
const VALIDADE_MAXIMA_DIAS = 90;

function carregar() {
  if (!fs.existsSync(ARQUIVO)) return [];
  try {
    const lido = JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8'));
    return Array.isArray(lido) ? lido : [];
  } catch (e) {
    console.error('Erro ao ler chaves.json:', e.message);
    return [];
  }
}

function gravar(lista) {
  // 0600 como o users.json: a chave em texto vale um cadastro até ser usada
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2), { mode: 0o600 });
}

// Sorteio sem viés: `% ALFABETO.length` daria peso a mais pras primeiras
// letras, porque 256 não divide 31. Então byte que cairia na sobra é descartado.
function sortear(quantos) {
  const limite = Math.floor(256 / ALFABETO.length) * ALFABETO.length;
  let saida = '';
  while (saida.length < quantos) {
    for (const b of crypto.randomBytes(quantos * 2)) {
      if (b >= limite) continue;
      saida += ALFABETO[b % ALFABETO.length];
      if (saida.length === quantos) break;
    }
  }
  return saida;
}

function novaChave() {
  const bruta = sortear(BLOCOS * POR_BLOCO);
  return bruta.match(new RegExp('.{1,' + POR_BLOCO + '}', 'g')).join('-');
}

// A pessoa vai digitar com espaço, sem traço, em minúscula, com o traço no
// lugar errado. Tudo isso é a mesma chave.
function normalizar(bruta) {
  const limpa = String(bruta || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (limpa.length !== BLOCOS * POR_BLOCO) return null;
  if ([...limpa].some(c => !ALFABETO.includes(c))) return null;
  return limpa.match(new RegExp('.{1,' + POR_BLOCO + '}', 'g')).join('-');
}

function diasValidos(dias) {
  const n = Math.floor(Number(dias));
  if (!Number.isFinite(n) || n <= 0) return VALIDADE_PADRAO_DIAS;
  return Math.min(n, VALIDADE_MAXIMA_DIAS);
}

// Gera uma chave amarrada a UMA live. `dono` é o @ que o cliente vai
// acompanhar — quem ativa não escolhe isso, e é esse o ponto.
function gerar({ dono, criadaPor, validadeDias, observacao } = {}) {
  const alvo = String(dono || '').trim().toLowerCase();
  if (!alvo) throw new Error('A chave precisa de uma live (@) pra apontar.');

  const lista = carregar();
  let chave;
  do { chave = novaChave(); } while (lista.some(c => c.chave === chave));

  const agora = Date.now();
  const registro = {
    chave,
    dono: alvo,
    criadaEm: agora,
    criadaPor: String(criadaPor || '') || null,
    expiraEm: agora + diasValidos(validadeDias) * 24 * 60 * 60 * 1000,
    observacao: String(observacao || '').slice(0, 120) || null,
    usadaEm: null,
    usadaPor: null
  };
  lista.push(registro);
  gravar(lista);
  return registro;
}

function buscar(bruta) {
  const chave = normalizar(bruta);
  if (!chave) return null;
  return carregar().find(c => c.chave === chave) || null;
}

// Por que a chave não serve — em texto que dá pra mostrar pra pessoa.
// Devolve sempre o mesmo formato pra quem chama não ter que adivinhar.
function conferir(bruta) {
  const chave = normalizar(bruta);
  if (!chave) return { ok: false, motivo: 'Essa chave não tem o formato certo.' };

  const registro = carregar().find(c => c.chave === chave);
  if (!registro) return { ok: false, motivo: 'Chave não encontrada.' };
  if (registro.usadaEm) {
    return { ok: false, motivo: 'Essa chave já foi usada.', usadaPor: registro.usadaPor };
  }
  if (registro.revogadaEm) return { ok: false, motivo: 'Essa chave foi cancelada.' };
  if (Date.now() > registro.expiraEm) return { ok: false, motivo: 'Essa chave venceu.' };

  return { ok: true, chave, dono: registro.dono, expiraEm: registro.expiraEm };
}

// Marca como usada. Confere DE NOVO na hora de gravar: entre o conferir() e o
// usar() cabe outro pedido, e uma chave de uso único que vira duas contas
// deixa de ser de uso único.
function usar(bruta, username) {
  const chave = normalizar(bruta);
  if (!chave) return { ok: false, motivo: 'Essa chave não tem o formato certo.' };

  const lista = carregar();
  const registro = lista.find(c => c.chave === chave);
  if (!registro) return { ok: false, motivo: 'Chave não encontrada.' };
  if (registro.usadaEm) return { ok: false, motivo: 'Essa chave já foi usada.' };
  if (registro.revogadaEm) return { ok: false, motivo: 'Essa chave foi cancelada.' };
  if (Date.now() > registro.expiraEm) return { ok: false, motivo: 'Essa chave venceu.' };

  registro.usadaEm = Date.now();
  registro.usadaPor = String(username || '') || null;
  gravar(lista);
  return { ok: true, dono: registro.dono };
}

// Cancelar não apaga: o painel continua mostrando que existiu e o que houve.
function revogar(bruta) {
  const chave = normalizar(bruta);
  if (!chave) return false;
  const lista = carregar();
  const registro = lista.find(c => c.chave === chave);
  if (!registro || registro.usadaEm) return false;
  registro.revogadaEm = Date.now();
  gravar(lista);
  return true;
}

// Some com o registro de vez. Só pra limpar a tela do que já passou.
function apagar(bruta) {
  const chave = normalizar(bruta);
  if (!chave) return false;
  const lista = carregar();
  const restante = lista.filter(c => c.chave !== chave);
  if (restante.length === lista.length) return false;
  gravar(restante);
  return true;
}

// O estado que a tela mostra, calculado num lugar só.
function situacao(registro) {
  if (registro.usadaEm) return 'usada';
  if (registro.revogadaEm) return 'cancelada';
  if (Date.now() > registro.expiraEm) return 'vencida';
  return 'aberta';
}

function listar() {
  return carregar()
    .map(c => ({ ...c, situacao: situacao(c) }))
    // aberta primeiro (é o que o administrador precisa copiar), depois a mais nova
    .sort((a, b) => {
      const peso = s => (s === 'aberta' ? 0 : 1);
      return peso(a.situacao) - peso(b.situacao) || b.criadaEm - a.criadaEm;
    });
}

module.exports = {
  ARQUIVO, ALFABETO, VALIDADE_PADRAO_DIAS, VALIDADE_MAXIMA_DIAS,
  gerar, conferir, usar, revogar, apagar, listar, buscar, normalizar, carregar, gravar
};
