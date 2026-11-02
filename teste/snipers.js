// ============================================================================
// A LISTA DE SNIPERS — o que o administrador adiciona e remove pela tela
// ----------------------------------------------------------------------------
// Roda num dados.db de uma pasta temporária, com MIRA_SNIPERS definido pra
// conferir a passagem da lista padrão pra lista salva.
//
// Roda com:  node --test teste/snipers.js
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-snipers-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;
process.env.MIRA_SNIPERS = '@Padrao_Um, padrao.dois';

const snipers = require(path.join(__dirname, '..', 'snipers.js'));

test('sem nada salvo, vale a lista padrão (normalizada)', () => {
  assert.deepEqual(snipers.listar(), ['padrao_um', 'padrao.dois']);
});

test('adicionar normaliza o @ e grava a lista inteira', () => {
  const r = snipers.adicionar('  @Novo_Sniper ', 'chefe');
  assert.equal(r.arroba, 'novo_sniper');
  assert.deepEqual(snipers.listar(), ['padrao_um', 'padrao.dois', 'novo_sniper']);
});

test('adicionar recusa repetido e @ inválido', () => {
  assert.match(snipers.adicionar('novo_sniper').erro, /já está/);
  assert.match(snipers.adicionar('a').erro, /inválido/);
  assert.match(snipers.adicionar('tem espaço').erro, /inválido/);
  assert.match(snipers.adicionar('').erro, /inválido/);
});

test('remover tira até quem veio da lista padrão', () => {
  assert.equal(snipers.remover('@padrao_um', 'chefe').arroba, 'padrao_um');
  assert.deepEqual(snipers.listar(), ['padrao.dois', 'novo_sniper']);
  assert.equal(snipers.inclui('padrao_um'), false);
  assert.equal(snipers.inclui('@Novo_Sniper'), true);
});

test('remover quem não está devolve 404', () => {
  const r = snipers.remover('ninguem');
  assert.ok(r.erro);
  assert.equal(r.status, 404);
});

test('lista vazia salva continua sendo a salva (não volta pra padrão)', () => {
  snipers.remover('padrao.dois');
  snipers.remover('novo_sniper');
  assert.deepEqual(snipers.listar(), []);
});
