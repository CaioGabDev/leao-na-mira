// ============================================================================
// PONTOS MANUAIS — o que foi lançado antes das correções
// ----------------------------------------------------------------------------
// Compensar live perdida agora é corrigir diamantes e minutos (correcoes.js),
// e não se lança mais ponto. O que já foi lançado continua contando até o
// administrador remover: apagar sozinho tiraria ponto de quem foi compensado.
// ============================================================================
const banco = require('./banco');

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

module.exports = { listar, buscar, remover, removerDoSniper, somaPorSniper };
