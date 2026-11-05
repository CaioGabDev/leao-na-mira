// ============================================================================
// PONTOS MANUAIS — o que o administrador lança à mão
// ----------------------------------------------------------------------------
// Live que o sistema não acompanhou não existe pra conta, e os pontos dela não
// voltam sozinhos. Aqui o administrador compensa isso.
//
// Cada lançamento é uma linha própria, com motivo e autor, em vez de mexer nos
// diamantes ou nas horas: assim sempre dá pra saber de onde veio cada ponto, e
// um lançamento errado se desfaz removendo a linha.
//
// Mora no mesmo dados.db, do mesmo jeito do indicacoes.js.
// ============================================================================
const crypto = require('crypto');
const banco = require('./banco');
const campanha = require('./campanha.config');
const snipers = require('./snipers');

// o teto pega dedo escorregando, não limita a regra: o total de uma campanha
// inteira costuma ficar bem abaixo disto
const MAXIMO_POR_LANCAMENTO = 100000;
const MOTIVO_MINIMO = 3;
const MOTIVO_MAXIMO = 200;

let preparado = null;
function bd() {
  const b = banco.abrir();
  if (preparado !== b) {
    b.exec(`CREATE TABLE IF NOT EXISTS pontos_manuais (
      id    TEXT NOT NULL PRIMARY KEY,
      dados TEXT NOT NULL
    ) WITHOUT ROWID`);
    preparado = b;
  }
  return b;
}

function listar() {
  const saida = [];
  for (const l of bd().prepare('SELECT dados FROM pontos_manuais').all()) {
    try { saida.push(JSON.parse(l.dados)); } catch (e) { /* linha torta: pula */ }
  }
  return saida.sort((a, b) => b.criadoEm - a.criadoEm);
}

function buscar(id) {
  const l = bd().prepare('SELECT dados FROM pontos_manuais WHERE id = ?').get(String(id));
  try { return l ? JSON.parse(l.dados) : null; } catch (e) { return null; }
}

function criar(corpo, autor) {
  const arroba = campanha.normalizar(corpo && corpo.arroba);
  const pontos = Number(corpo && corpo.pontos);
  const motivo = String((corpo && corpo.motivo) || '').trim();

  if (!snipers.inclui(arroba)) return { erro: `@${arroba} não é sniper da campanha.` };
  if (!Number.isInteger(pontos) || pontos < 1) return { erro: 'Os pontos precisam ser um número inteiro maior que zero.' };
  if (pontos > MAXIMO_POR_LANCAMENTO) return { erro: `O máximo por lançamento é ${MAXIMO_POR_LANCAMENTO} pontos.` };
  if (motivo.length < MOTIVO_MINIMO) return { erro: 'Escreva o motivo: é o que explica esses pontos depois.' };
  if (motivo.length > MOTIVO_MAXIMO) return { erro: `O motivo pode ter até ${MOTIVO_MAXIMO} caracteres.` };

  const item = { id: crypto.randomUUID(), arroba, pontos, motivo, criadoEm: Date.now(), autor: String(autor || '') };
  bd().prepare('INSERT INTO pontos_manuais (id, dados) VALUES (?, ?)').run(item.id, JSON.stringify(item));
  return { lancamento: item };
}

function remover(id) {
  const r = bd().prepare('DELETE FROM pontos_manuais WHERE id = ?').run(String(id));
  return Number(r.changes || 0) > 0;
}

// Devolve quantos pontos saíram, pro log do zerar.
function removerDoSniper(arroba) {
  const dele = listar().filter(p => p.arroba === arroba);
  dele.forEach(p => remover(p.id));
  return dele.reduce((soma, p) => soma + p.pontos, 0);
}

// sniper -> soma dos pontos lançados
function somaPorSniper() {
  const conta = new Map();
  for (const p of listar()) conta.set(p.arroba, (conta.get(p.arroba) || 0) + p.pontos);
  return conta;
}

module.exports = { listar, buscar, criar, remover, removerDoSniper, somaPorSniper };
