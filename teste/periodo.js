// ============================================================================
// O PERÍODO DA CAMPANHA — o que o administrador salva na tela
// ----------------------------------------------------------------------------
// Roda num dados.db de uma pasta temporária: o teste não pode encostar no
// banco de verdade.
//
// Roda com:  node --test teste/periodo.js
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-periodo-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;

const periodo = require(path.join(__dirname, '..', 'periodo.js'));
const config = require(path.join(__dirname, '..', 'campanha.config.js'));

const DIA = 24 * 60 * 60 * 1000;
const NOV = Date.parse('2026-11-10T00:00:00-03:00');

test('validar: recusa período torto', () => {
  assert.equal(periodo.validar(NOV, NOV + DIA), null);
  assert.match(periodo.validar(NaN, NOV), /início e a de fim/);
  assert.match(periodo.validar(NOV, NOV), /depois do início/);
  assert.match(periodo.validar(NOV + DIA, NOV), /depois do início/);
  assert.match(periodo.validar(NOV, NOV + 400 * DIA), /um ano/);
  assert.match(periodo.validar(0, NOV), /fora do intervalo/);
});

test('sem nada salvo, vale o padrão do config', () => {
  assert.deepEqual(periodo.get(), { inicio: config.inicio, fim: config.fim, origem: 'padrao' });
});

test('o salvo pelo admin vence o padrão, e dá pra voltar', () => {
  const r = periodo.salvar({ inicio: NOV, fim: NOV + 7 * DIA }, 'chefe');
  assert.equal(r.erro, undefined);
  const p = periodo.get();
  assert.equal(p.origem, 'admin');
  assert.equal(p.inicio, NOV);
  assert.equal(p.fim, NOV + 7 * DIA);
  assert.equal(p.autor, 'chefe');

  periodo.voltarAoPadrao();
  assert.equal(periodo.get().origem, 'padrao');
});

test('período inválido não é gravado', () => {
  const r = periodo.salvar({ inicio: NOV, fim: NOV - DIA }, 'chefe');
  assert.ok(r.erro);
  assert.equal(periodo.get().origem, 'padrao');
});

test('datas chegando como texto numérico também valem', () => {
  const r = periodo.salvar({ inicio: String(NOV), fim: String(NOV + DIA) }, 'chefe');
  assert.equal(r.erro, undefined);
  assert.equal(periodo.get().inicio, NOV);
  periodo.voltarAoPadrao();
});
