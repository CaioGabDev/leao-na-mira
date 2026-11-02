// ============================================================================
// A CONTA DA CAMPANHA — calcularPontuacao e companhia
// ----------------------------------------------------------------------------
// As bordas são onde a regra mora: 499 diamantes não valem nada e 500 valem um
// bloco; 59 minutos de live não valem nada e 60 valem uma hora.
//
// Roda com:  node --test teste/pontuacao.js
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { calcularPontuacao, somarLivesNoPeriodo, ordenarRanking } =
  require(path.join(__dirname, '..', 'pontuacao.js'));

// regras explícitas: o teste não pode mudar de resultado porque alguém mexeu
// no campanha.config.js
const REGRAS = { PONTOS_POR_HORA: 10, DIAMANTES_POR_BLOCO: 500, PONTOS_POR_BLOCO: 30, PONTOS_POR_INDICACAO: 20 };
const diamantes = d => calcularPontuacao({ diamantes: d }, REGRAS).pontosDiamantes;
const minutos = m => calcularPontuacao({ segundosDeLive: m * 60 }, REGRAS).pontosHoras;

test('diamantes: só bloco fechado de 500 conta', () => {
  assert.equal(diamantes(0), 0);
  assert.equal(diamantes(499), 0);
  assert.equal(diamantes(500), 30);
  assert.equal(diamantes(999), 30);
  assert.equal(diamantes(1000), 60);
});

test('live: só hora completa conta', () => {
  assert.equal(minutos(59), 0);
  assert.equal(minutos(60), 10);
  assert.equal(minutos(119), 10);
  assert.equal(minutos(120), 20);
});

test('indicação vale 20 por amigo', () => {
  assert.equal(calcularPontuacao({ indicacoes: 0 }, REGRAS).pontosIndicacoes, 0);
  assert.equal(calcularPontuacao({ indicacoes: 3 }, REGRAS).pontosIndicacoes, 60);
});

test('total soma as três partes', () => {
  const r = calcularPontuacao({ segundosDeLive: 2 * 3600 + 59 * 60, diamantes: 1499, indicacoes: 1 }, REGRAS);
  assert.deepEqual(r, { horas: 2, pontosHoras: 20, pontosDiamantes: 60, pontosIndicacoes: 20, total: 100 });
});

test('entrada torta conta como zero', () => {
  assert.equal(calcularPontuacao({}, REGRAS).total, 0);
  assert.equal(calcularPontuacao({ segundosDeLive: -50, diamantes: 'x', indicacoes: null }, REGRAS).total, 0);
});

test('lives: corta a duração nas bordas do período', () => {
  const H = 3600 * 1000;
  const inicio = 10 * H, fim = 20 * H;
  const r = somarLivesNoPeriodo([
    { startedAt: 8 * H, endedAt: 11 * H, totalDiamonds: 100 },    // 1h dentro
    { startedAt: 12 * H, endedAt: 13 * H, totalDiamonds: 200 },   // 1h dentro
    { startedAt: 19 * H, endedAt: 22 * H, totalDiamonds: 300 },   // 1h dentro
    { startedAt: 1 * H, endedAt: 2 * H, totalDiamonds: 999 },     // fora
    { startedAt: 12 * H }                                        // sem fim: pula
  ], inicio, fim);
  assert.deepEqual(r, { segundos: 3 * 3600, diamantes: 600, lives: 3 });
});

test('desempate: mais diamantes, depois mais horas', () => {
  const r = ordenarRanking([
    { arroba: 'a', total: 50, diamantes: 100, segundos: 10 },
    { arroba: 'b', total: 50, diamantes: 900, segundos: 1 },
    { arroba: 'c', total: 50, diamantes: 100, segundos: 99 },
    { arroba: 'd', total: 80, diamantes: 0, segundos: 0 }
  ]);
  assert.deepEqual(r.map(l => l.arroba), ['d', 'b', 'c', 'a']);
  assert.deepEqual(r.map(l => l.posicao), [1, 2, 3, 4]);
});
