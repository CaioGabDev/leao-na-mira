// ============================================================================
// AJUSTES DA CAMPANHA — o que o administrador decide pela tela
// ----------------------------------------------------------------------------
// Uma tabela de chave -> JSON no mesmo dados.db, do mesmo jeito do
// indicacoes.js. Hoje guarda o período (periodo.js) e a lista de snipers
// (snipers.js).
// ============================================================================
const banco = require('./banco');

let preparado = null;
function bd() {
  const b = banco.abrir();
  if (preparado !== b) {
    b.exec(`CREATE TABLE IF NOT EXISTS campanha_ajustes (
      chave TEXT NOT NULL PRIMARY KEY,
      dados TEXT NOT NULL
    ) WITHOUT ROWID`);
    preparado = b;
  }
  return b;
}

// null quando não há nada salvo
function ler(chave) {
  const l = bd().prepare('SELECT dados FROM campanha_ajustes WHERE chave = ?').get(chave);
  return l ? JSON.parse(l.dados) : null;
}

function gravar(chave, valor) {
  bd().prepare('INSERT OR REPLACE INTO campanha_ajustes (chave, dados) VALUES (?, ?)')
    .run(chave, JSON.stringify(valor));
}

function apagar(chave) {
  bd().prepare('DELETE FROM campanha_ajustes WHERE chave = ?').run(chave);
}

module.exports = { ler, gravar, apagar };
