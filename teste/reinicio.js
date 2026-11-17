// ============================================================================
// SERVIDOR REINICIANDO COM A LIVE NO AR (deploy)
// ----------------------------------------------------------------------------
// O `liveOnline` do live.js é de memória e volta false no restart; o banco
// lembra que a live estava no ar. Três saídas:
//   - volta em menos de 3 min: é a mesma live, continua de onde estava;
//   - volta depois disso: a de antes vai pro histórico até a última batida,
//     e começa outra;
//   - não volta (encerrou com o servidor fora): fecha na última batida, em vez
//     de ficar "ao vivo" pra sempre somando horas na campanha.
//
// Roda com:  node --test teste/reinicio.js
// ============================================================================
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-reinicio-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;

const dbFabrica = require(path.join(__dirname, '..', 'db.js'));

const MIN = 60 * 1000;
let numero = 0;

test.beforeEach(() => {
  mock.method(console, 'log', () => {});
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
});
test.afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// live no ar há 30 min, com 100 diamantes, e a última batida agora
function liveNoAr() {
  const dono = 'reinicio' + (++numero);
  const db = dbFabrica.paraDono(dono);
  db.markLiveOnline();
  const comecou = Date.now();
  db.addGift('fa', 'Fã', 'Rosa', 100, null);
  for (let i = 0; i < 60; i++) { mock.timers.tick(30000); db.heartbeat(); }
  return { dono, db, comecou, ultimaBatida: Date.now() };
}

// o processo morre e sobe de novo: a instância nova lê do banco
function reiniciar(dono, db) {
  db.fechar();
  return dbFabrica.paraDono(dono);
}

test('volta rápido: é a mesma live, com o começo e os diamantes de antes', () => {
  const { dono, db, comecou } = liveNoAr();
  mock.timers.tick(1 * MIN);
  const db2 = reiniciar(dono, db);
  db2.markLiveOnline();
  const atual = db2.numerosDaLiveAtual();
  assert.equal(atual.comecouEm, comecou);
  assert.equal(atual.diamantes, 100);
  assert.equal(db2.getSessions().length, 0);
});

test('volta depois de 3 min: a de antes vai pro histórico até a última batida', () => {
  const { dono, db, comecou, ultimaBatida } = liveNoAr();
  mock.timers.tick(10 * MIN);
  const db2 = reiniciar(dono, db);
  db2.markLiveOnline();

  const [antes] = db2.getSessions();
  assert.equal(antes.startedAt, comecou);
  assert.equal(antes.endedAt, ultimaBatida);
  assert.equal(antes.totalDiamonds, 100);

  const atual = db2.numerosDaLiveAtual();
  assert.equal(atual.comecouEm, Date.now(), 'a nova começa agora');
  assert.equal(atual.diamantes, 0);
});

test('não volta: fecha na última batida em vez de ficar ao vivo pra sempre', () => {
  const { dono, db, comecou, ultimaBatida } = liveNoAr();
  const db2 = reiniciar(dono, db);

  mock.timers.tick(1 * MIN);
  assert.equal(db2.fecharSessaoParada(), false, 'ainda pode voltar');

  mock.timers.tick(5 * MIN);
  assert.equal(db2.fecharSessaoParada(), true);
  assert.equal(db2.numerosDaLiveAtual(), null);
  const [sessao] = db2.getSessions();
  assert.equal(sessao.startedAt, comecou);
  assert.equal(sessao.endedAt, ultimaBatida);
  assert.equal(sessao.durationSeconds, 30 * 60);
  assert.equal(db2.fecharSessaoParada(), false, 'só fecha uma vez');
});

test('live acompanhada não é fechada pelo vigia', () => {
  const { db } = liveNoAr();
  mock.timers.tick(30000);
  assert.equal(db.fecharSessaoParada(), false);
  assert.ok(db.numerosDaLiveAtual());
});
