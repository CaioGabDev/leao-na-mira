// ============================================================================
// ZERAR PONTUAÇÃO — o botão que apaga de vez
// ----------------------------------------------------------------------------
// Roda num dados.db de uma pasta temporária, com o db de verdade e uma live de
// mentira no lugar do TikTok: o que importa aqui é o que sobra no banco.
//
// Roda com:  node --test teste/zerar.js
// ============================================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-zerar-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;
process.env.MIRA_SNIPERS = 'ana,bia';

const raiz = arquivo => path.join(__dirname, '..', arquivo);
const banco = require(raiz('banco.js'));
const dbFabrica = require(raiz('db.js'));
const indicacoes = require(raiz('indicacoes.js'));
const periodo = require(raiz('periodo.js'));
const criarCampanha = require(raiz('campanha.js'));

const AGORA = Date.now();
periodo.salvar({ inicio: AGORA - 24 * 3600 * 1000, fim: AGORA + 24 * 3600 * 1000 }, 'chefe');

// o mesmo acerto do live.js: quem está no ar se reapresenta ao banco
function clienteDe(dono, noAr) {
  const db = dbFabrica.paraDono(dono);
  const live = {
    estadoDaConexao: () => ({ online: noAr, ultimaTentativa: null }),
    sessaoReiniciada: () => { if (noAr) db.markLiveOnline(); return noAr; }
  };
  return { db, live };
}

function campanhaCom({ noAr = false, quebrado = null } = {}) {
  const abrir = dono => {
    if (dono === quebrado) throw new Error('banco fora');
    return clienteDe(dono, noAr);
  };
  return criarCampanha({ clientes: { abrir } });
}

function fazerLive(dono, diamantes) {
  const db = dbFabrica.paraDono(dono);
  db.markLiveOnline();
  db.addGift('fa', 'Fã', 'Rosa', diamantes, null);
  // o histórico recusa live de menos de 10s, e aqui não dá pra esperar
  const real = Date.now;
  Date.now = () => real() + 60 * 1000;
  db.markLiveOffline();
  Date.now = real;
  db.saveToDisk();
}

const emDisco = dono => banco.carregar(dono);

beforeEach(() => {
  ['ana', 'bia'].forEach(d => {
    dbFabrica.paraDono(d).resetAll();
    indicacoes.removerDoIndicador(d);
  });
});

test('zerar: apaga lives, diamantes e indicações só daquela pessoa', () => {
  fazerLive('ana', 700);
  fazerLive('bia', 300);
  indicacoes.criar({ indicador: 'ana', indicado: 'amigo_da_ana', oficial: true }, 'chefe');
  indicacoes.criar({ indicador: 'bia', indicado: 'amigo_da_bia', oficial: true }, 'chefe');
  const campanha = campanhaCom();

  const apagado = campanha.zerar('ana');
  assert.equal(apagado.diamantes, 700);
  assert.equal(apagado.lives, 1);
  assert.equal(apagado.indicacoes, 1);

  assert.equal(emDisco('ana').sessions.length, 0);
  assert.equal(emDisco('ana').global.totalDiamonds, 0);
  assert.equal(emDisco('bia').sessions.length, 1);
  assert.equal(emDisco('bia').global.totalDiamonds, 300);
  assert.deepEqual(indicacoes.listar().map(i => i.indicador), ['bia']);

  const { ranking } = campanha.getRanking();
  assert.equal(ranking.find(l => l.arroba === 'ana').total, 0);
  assert.ok(ranking.find(l => l.arroba === 'bia').total > 0);
});

test('zerar: ser indicado por outro continua sendo ponto do outro', () => {
  indicacoes.criar({ indicador: 'bia', indicado: 'ana', oficial: true }, 'chefe');
  campanhaCom().zerar('ana');
  assert.deepEqual(indicacoes.listar().map(i => i.indicado), ['ana']);
});

test('zerar: a curva da live some do banco, a foto e o nome ficam', () => {
  const db = dbFabrica.paraDono('ana');
  db.setPerfilDoStreamer({ avatar: 'https://foto', nome: 'Ana' });
  fazerLive('ana', 10);
  assert.ok(banco.contarAmostras('ana') > 0);

  campanhaCom().zerar('ana');

  assert.equal(banco.contarAmostras('ana'), 0);
  assert.deepEqual(
    { avatar: db.getPerfilDoStreamer().avatar, nome: db.getPerfilDoStreamer().nome },
    { avatar: 'https://foto', nome: 'Ana' });
  assert.equal(emDisco('ana').global.perfilStreamer.nome, 'Ana');
});

test('zerar com a live no ar: ela segue contando, do zero', () => {
  const db = dbFabrica.paraDono('ana');
  db.markLiveOnline();
  db.addGift('fa', 'Fã', 'Rosa', 500, null);

  campanhaCom({ noAr: true }).zerar('ana');

  assert.equal(db.numerosDaLiveAtual().diamantes, 0);
  db.addGift('fa', 'Fã', 'Rosa', 40, null);
  assert.equal(db.numerosDaLiveAtual().diamantes, 40);
  db.markLiveOffline();
});

test('zerar todos: passa por toda a lista', () => {
  fazerLive('ana', 700);
  fazerLive('bia', 300);
  indicacoes.criar({ indicador: 'bia', indicado: 'amigo', oficial: true }, 'chefe');

  const r = campanhaCom().zerarTodos();

  assert.deepEqual(r.apagados.map(a => a.arroba), ['ana', 'bia']);
  assert.deepEqual(r.falhas, []);
  assert.equal(emDisco('ana').global.totalDiamonds, 0);
  assert.equal(emDisco('bia').global.totalDiamonds, 0);
  assert.deepEqual(indicacoes.listar(), []);
});

test('zerar todos: quem está fora da lista não é tocado', () => {
  fazerLive('saiu_antes', 900);
  campanhaCom().zerarTodos();
  assert.equal(emDisco('saiu_antes').global.totalDiamonds, 900);
});

test('zerar todos: um erro não deixa os outros pela metade', () => {
  fazerLive('ana', 700);
  fazerLive('bia', 300);
  const original = console.error;
  console.error = () => {};
  const r = campanhaCom({ quebrado: 'ana' }).zerarTodos();
  console.error = original;

  assert.deepEqual(r.falhas, ['ana']);
  assert.deepEqual(r.apagados.map(a => a.arroba), ['bia']);
  assert.equal(emDisco('ana').global.totalDiamonds, 700);
  assert.equal(emDisco('bia').global.totalDiamonds, 0);
});
