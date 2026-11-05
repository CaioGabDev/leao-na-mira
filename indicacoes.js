// ============================================================================
// INDICAÇÕES DA CAMPANHA — quem indicou quem
// ----------------------------------------------------------------------------
// O TikTok não sabe quem indicou quem nem quem entrou na MIRA: isso é o
// administrador que informa. Mora no mesmo dados.db, numa tabela própria, com
// o mesmo jeito do banco.js (o objeto inteiro em JSON numa coluna).
//
// Só conta ponto a indicação marcada como `oficial`: o indicado entrou
// oficialmente na MIRA e fez a primeira live.
// ============================================================================
const crypto = require('crypto');
const banco = require('./banco');
const campanha = require('./campanha.config');
const snipers = require('./snipers');

// mesmo formato de @ que o TikTok aceita
const ARROBA_VALIDO = /^[a-z0-9._]{2,24}$/;

let preparado = null;
function bd() {
  const b = banco.abrir();
  if (preparado !== b) {
    b.exec(`CREATE TABLE IF NOT EXISTS indicacoes (
      id    TEXT NOT NULL PRIMARY KEY,
      dados TEXT NOT NULL
    ) WITHOUT ROWID`);
    preparado = b;
  }
  return b;
}

function listar() {
  const saida = [];
  for (const l of bd().prepare('SELECT dados FROM indicacoes').all()) {
    try { saida.push(JSON.parse(l.dados)); } catch (e) { /* linha torta: pula */ }
  }
  return saida.sort((a, b) => b.criadoEm - a.criadoEm);
}

function buscar(id) {
  const l = bd().prepare('SELECT dados FROM indicacoes WHERE id = ?').get(String(id));
  try { return l ? JSON.parse(l.dados) : null; } catch (e) { return null; }
}

function gravar(item) {
  bd().prepare('INSERT OR REPLACE INTO indicacoes (id, dados) VALUES (?, ?)').run(item.id, JSON.stringify(item));
}

// Devolve o texto do erro, ou null se está tudo certo. `idAtual` é a própria
// indicação numa edição — senão ela bateria com ela mesma na checagem de repetido.
function validar({ indicador, indicado }, idAtual) {
  if (!ARROBA_VALIDO.test(indicador)) return 'O @ de quem indicou é inválido.';
  if (!ARROBA_VALIDO.test(indicado)) return 'O @ do indicado é inválido.';
  if (!snipers.inclui(indicador)) return `@${indicador} não é sniper da campanha.`;
  if (indicador === indicado) return 'Ninguém indica a si mesmo.';
  // o mesmo amigo não vale ponto duas vezes, nem pra dois snipers
  const repetida = listar().find(i => i.indicado === indicado && i.id !== idAtual);
  if (repetida) return `@${indicado} já foi indicado por @${repetida.indicador}.`;
  return null;
}

function limpar(corpo) {
  return {
    indicador: campanha.normalizar(corpo && corpo.indicador),
    indicado: campanha.normalizar(corpo && corpo.indicado),
    oficial: !!(corpo && corpo.oficial)
  };
}

function criar(corpo, autor) {
  const campos = limpar(corpo);
  const erro = validar(campos);
  if (erro) return { erro };
  const agora = Date.now();
  const item = { id: crypto.randomUUID(), ...campos, criadoEm: agora, atualizadoEm: agora, autor: String(autor || '') };
  gravar(item);
  return { indicacao: item };
}

function atualizar(id, corpo, autor) {
  const atual = buscar(id);
  if (!atual) return { erro: 'Indicação não encontrada.', status: 404 };
  const campos = limpar({ ...atual, ...corpo });
  const erro = validar(campos, atual.id);
  if (erro) return { erro };
  const item = { ...atual, ...campos, atualizadoEm: Date.now(), autor: String(autor || '') };
  gravar(item);
  return { indicacao: item };
}

function remover(id) {
  const r = bd().prepare('DELETE FROM indicacoes WHERE id = ?').run(String(id));
  return Number(r.changes || 0) > 0;
}

// Só as feitas por este sniper: ter sido indicado por outro é ponto do outro.
function removerDoIndicador(arroba) {
  const dele = listar().filter(i => i.indicador === arroba);
  dele.forEach(i => remover(i.id));
  return dele.length;
}

// sniper -> quantas indicações oficiais ele tem
function oficiaisPorIndicador() {
  const conta = new Map();
  for (const i of listar()) {
    if (i.oficial) conta.set(i.indicador, (conta.get(i.indicador) || 0) + 1);
  }
  return conta;
}

module.exports = { listar, buscar, criar, atualizar, remover, removerDoIndicador, oficiaisPorIndicador };
