// ============================================================================
// BANCO (SQLite)
// ----------------------------------------------------------------------------
// Aqui mora o passo 1 do multi-cliente: TODA linha carrega o `dono`. O resto do
// código continua trabalhando com o mesmo objeto de estado em memória de
// sempre — este arquivo é só o espelho dele no disco.
//
// Por que não uma coluna por campo (likes, gifts_value, ...):
// os objetos de usuário/carta ganham campo novo com frequência (powerups,
// gifterLevel, superFaEm...). Uma coluna por campo obrigaria a mudar o schema
// a cada campo novo, com risco de perder dado calado no caminho. Então cada
// linha guarda o objeto em JSON, e as colunas de verdade são as que a gente
// precisa pra separar e ordenar: dono, id e posição.
// Quando um relatório em SQL fizer falta, dá pra criar coluna gerada em cima
// do JSON sem migrar nada.
//
// Usa o `node:sqlite`, que vem dentro do Node (>= 24) — sem dependência nova e
// sem compilar nada no deploy. Por isso o package.json fixa a versão do Node.
// ============================================================================
// O SQLite vem dentro do Node a partir da versão 24. Se o deploy subir com uma
// versão mais velha, é melhor falhar aqui com um recado claro do que com um
// "Cannot find module 'node:sqlite'" no meio do log.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error(
    'Este projeto precisa do Node 24 ou mais novo (usa o SQLite embutido). ' +
    'Node em uso: ' + process.version + '. Veja o .node-version / engines do package.json.'
  );
}

const ARQUIVO = process.env.RAILWAY_ENVIRONMENT ? '/data/dados.db' : 'dados.db';

// listas ordenadas: nome da tabela -> nome do campo no estado
const LISTAS = {
  acoes:    'actions',
  tropa:    'tropa',
  sessoes:  'sessions',
  batalhas: 'battles'
};

// valores únicos por dono
const CHAVES = ['global', 'currentBattle', 'currentSessionSnapshot'];

// mapas de objeto: tabela -> campo no estado (indexados por uniqueId)
const MAPAS = {
  usuarios: 'users',
  cartas:   'cartas'
};

function estadoVazio() {
  return {
    users: {}, actions: [], tropa: [], sessions: [], battles: [],
    currentBattle: null, cartas: {}, global: null, currentSessionSnapshot: null
  };
}

function criarTabelas(bd) {
  for (const tabela of Object.keys(MAPAS)) {
    bd.exec(`CREATE TABLE IF NOT EXISTS ${tabela} (
      dono      TEXT NOT NULL,
      unique_id TEXT NOT NULL,
      dados     TEXT NOT NULL,
      PRIMARY KEY (dono, unique_id)
    ) WITHOUT ROWID`);
  }
  for (const tabela of Object.keys(LISTAS)) {
    bd.exec(`CREATE TABLE IF NOT EXISTS ${tabela} (
      dono  TEXT    NOT NULL,
      pos   INTEGER NOT NULL,
      dados TEXT    NOT NULL,
      PRIMARY KEY (dono, pos)
    ) WITHOUT ROWID`);
  }
  // A série temporal. Fora do LISTAS de propósito: ver o comentário em
  // anexarAmostras(). Chave (dono, t) porque dois pontos no mesmo instante
  // são o mesmo ponto — reconectar no meio não pode duplicar a curva.
  bd.exec(`CREATE TABLE IF NOT EXISTS amostras (
    dono  TEXT    NOT NULL,
    t     INTEGER NOT NULL,
    dados TEXT    NOT NULL,
    PRIMARY KEY (dono, t)
  ) WITHOUT ROWID`);

  bd.exec(`CREATE TABLE IF NOT EXISTS chaves (
    dono  TEXT NOT NULL,
    chave TEXT NOT NULL,
    dados TEXT NOT NULL,
    PRIMARY KEY (dono, chave)
  ) WITHOUT ROWID`);
}

// ---------- abertura ----------
// Um banco por processo. `caminho` só é passado nos testes.
let bd = null;
let caminhoAberto = null;

function abrir(caminho) {
  const alvo = caminho || ARQUIVO;
  if (bd && caminhoAberto === alvo) return bd;
  if (bd) bd.close();
  bd = new DatabaseSync(alvo);
  caminhoAberto = alvo;
  // WAL: escrita não bloqueia leitura e o arquivo não corrompe se cair no meio
  bd.exec('PRAGMA journal_mode = WAL');
  bd.exec('PRAGMA foreign_keys = ON');
  criarTabelas(bd);
  return bd;
}

function fechar() {
  if (!bd) return;
  bd.close();
  bd = null;
  caminhoAberto = null;
}

// ---------- leitura ----------

function temDados(dono) {
  const b = abrir();
  const linha = b.prepare('SELECT COUNT(*) AS n FROM chaves WHERE dono = ?').get(String(dono));
  return !!(linha && linha.n > 0);
}

function carregar(dono) {
  const b = abrir();
  const d = String(dono);
  if (!temDados(d)) return null;

  const estado = estadoVazio();

  for (const [tabela, campo] of Object.entries(MAPAS)) {
    const linhas = b.prepare(`SELECT unique_id, dados FROM ${tabela} WHERE dono = ?`).all(d);
    const alvo = {};
    for (const l of linhas) {
      try { alvo[l.unique_id] = JSON.parse(l.dados); } catch (e) { /* linha torta: pula */ }
    }
    estado[campo] = alvo;
  }

  for (const [tabela, campo] of Object.entries(LISTAS)) {
    const linhas = b.prepare(`SELECT dados FROM ${tabela} WHERE dono = ? ORDER BY pos`).all(d);
    const alvo = [];
    for (const l of linhas) {
      try { alvo.push(JSON.parse(l.dados)); } catch (e) { /* linha torta: pula */ }
    }
    estado[campo] = alvo;
  }

  const chaves = b.prepare('SELECT chave, dados FROM chaves WHERE dono = ?').all(d);
  for (const l of chaves) {
    if (!CHAVES.includes(l.chave)) continue;
    try { estado[l.chave] = JSON.parse(l.dados); } catch (e) { /* idem */ }
  }

  return estado;
}

// ---------- escrita ----------
// Espelho completo do estado daquele dono, dentro de uma transação: ou grava
// tudo, ou não grava nada. Com o tamanho real disso (dezenas de linhas) isso
// custa menos que reescrever o JSON inteiro, que era o que acontecia antes.
function gravar(dono, estado) {
  const b = abrir();
  const d = String(dono);
  const e = estado || estadoVazio();

  b.exec('BEGIN IMMEDIATE');
  try {
    for (const [tabela, campo] of Object.entries(MAPAS)) {
      b.prepare(`DELETE FROM ${tabela} WHERE dono = ?`).run(d);
      const inserir = b.prepare(`INSERT INTO ${tabela} (dono, unique_id, dados) VALUES (?, ?, ?)`);
      for (const [id, valor] of Object.entries(e[campo] || {})) {
        if (valor === undefined) continue;
        inserir.run(d, String(id), JSON.stringify(valor));
      }
    }

    for (const [tabela, campo] of Object.entries(LISTAS)) {
      b.prepare(`DELETE FROM ${tabela} WHERE dono = ?`).run(d);
      const inserir = b.prepare(`INSERT INTO ${tabela} (dono, pos, dados) VALUES (?, ?, ?)`);
      const lista = Array.isArray(e[campo]) ? e[campo] : [];
      lista.forEach((valor, i) => {
        if (valor === undefined) return;
        inserir.run(d, i, JSON.stringify(valor));
      });
    }

    b.prepare('DELETE FROM chaves WHERE dono = ?').run(d);
    const inserirChave = b.prepare('INSERT INTO chaves (dono, chave, dados) VALUES (?, ?, ?)');
    for (const chave of CHAVES) {
      // `global` sempre grava (é o que marca "este dono existe"); os outros só
      // quando têm algo, pra null não virar linha à toa
      if (e[chave] === undefined) continue;
      if (e[chave] === null && chave !== 'global') continue;
      inserirChave.run(d, chave, JSON.stringify(e[chave] === undefined ? null : e[chave]));
    }

    b.exec('COMMIT');
  } catch (err) {
    try { b.exec('ROLLBACK'); } catch (e2) { /* já caiu */ }
    throw err;
  }
}

// ---------- AMOSTRAS (série temporal) ----------
// Append-only: o gravar() lá de cima apaga e reinsere a lista inteira a cada
// 5 segundos, o que serve pra centenas de linhas e não pra dezenas de
// milhares de pontos. Aqui só entra o que é novo.

function anexarAmostras(dono, lista) {
  if (!Array.isArray(lista) || !lista.length) return 0;
  const b = abrir();
  const d = String(dono);
  // OR REPLACE: se a mesma marca de tempo voltar (um restart no mesmo minuto),
  // o ponto é atualizado em vez de estourar a chave primária
  const inserir = b.prepare('INSERT OR REPLACE INTO amostras (dono, t, dados) VALUES (?, ?, ?)');
  b.exec('BEGIN IMMEDIATE');
  try {
    for (const ponto of lista) {
      const t = Math.floor(Number(ponto && ponto.t));
      if (!Number.isFinite(t)) continue;
      const { t: _, ...resto } = ponto;
      inserir.run(d, t, JSON.stringify(resto));
    }
    b.exec('COMMIT');
  } catch (err) {
    try { b.exec('ROLLBACK'); } catch (e2) { /* já caiu */ }
    throw err;
  }
  return lista.length;
}

function lerAmostras(dono, desde, ate) {
  const b = abrir();
  const de = Number.isFinite(Number(desde)) ? Math.floor(Number(desde)) : 0;
  const ateQuando = Number.isFinite(Number(ate)) ? Math.floor(Number(ate)) : Number.MAX_SAFE_INTEGER;
  const linhas = b.prepare(
    'SELECT t, dados FROM amostras WHERE dono = ? AND t >= ? AND t <= ? ORDER BY t'
  ).all(String(dono), de, ateQuando);

  const saida = [];
  for (const l of linhas) {
    try { saida.push({ t: Number(l.t), ...JSON.parse(l.dados) }); } catch (e) { /* linha torta: pula */ }
  }
  return saida;
}

// Joga fora o que é velho demais pra interessar. Sem isto a tabela cresce pra
// sempre — e é a única que cresce sozinha, sem ninguém mandar.
function podarAmostras(dono, antesDe) {
  const corte = Math.floor(Number(antesDe));
  if (!Number.isFinite(corte)) return 0;
  const b = abrir();
  const r = b.prepare('DELETE FROM amostras WHERE dono = ? AND t < ?').run(String(dono), corte);
  return Number(r.changes || 0);
}

function contarAmostras(dono) {
  const b = abrir();
  const r = b.prepare('SELECT COUNT(*) AS n FROM amostras WHERE dono = ?').get(String(dono));
  return Number((r && r.n) || 0);
}

// Apaga tudo de um dono só — os outros clientes nem ficam sabendo.
function apagarDono(dono) {
  const b = abrir();
  const d = String(dono);
  b.exec('BEGIN IMMEDIATE');
  try {
    for (const tabela of [...Object.keys(MAPAS), ...Object.keys(LISTAS), 'chaves', 'amostras']) {
      b.prepare(`DELETE FROM ${tabela} WHERE dono = ?`).run(d);
    }
    b.exec('COMMIT');
  } catch (err) {
    try { b.exec('ROLLBACK'); } catch (e2) { /* já caiu */ }
    throw err;
  }
}

function listarDonos() {
  const b = abrir();
  return b.prepare('SELECT DISTINCT dono FROM chaves ORDER BY dono').all().map(l => l.dono);
}

module.exports = {
  ARQUIVO, LISTAS, CHAVES, MAPAS,
  abrir, fechar, carregar, gravar, temDados, apagarDono, listarDonos, estadoVazio,
  anexarAmostras, lerAmostras, podarAmostras, contarAmostras
};
