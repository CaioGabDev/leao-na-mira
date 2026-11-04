// ============================================================================
// OS NÚMEROS DO ADMIN — diamantes e tempo de live de cada sniper
// ----------------------------------------------------------------------------
// Roda num dados.db de uma pasta temporária, com lives de mentira no lugar do
// TikTok: nada aqui abre conexão.
//
// Roda com:  node --test teste/status.js
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-status-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;
process.env.MIRA_SNIPERS = 'fulano';

const raiz = arquivo => path.join(__dirname, '..', arquivo);
const banco = require(raiz('banco.js'));
const dbFabrica = require(raiz('db.js'));
const periodo = require(raiz('periodo.js'));
const criarCampanha = require(raiz('campanha.js'));

const H = 60 * 60 * 1000;
const INICIO = Date.parse('2026-11-01T00:00:00-03:00');

periodo.salvar({ inicio: INICIO, fim: INICIO + 24 * H }, 'chefe');

function campanhaCom(db) {
  const live = { estadoDaConexao: () => ({ online: false, ultimaTentativa: null }) };
  return criarCampanha({ clientes: { abrir: () => ({ db, live }) } });
}

function dbDeMentira({ sessoes = [], atual = null, gravacao = { em: null, erro: null } }) {
  return {
    getSessions: () => [...sessoes],
    numerosDaLiveAtual: () => atual,
    getPerfilDoStreamer: () => null,
    ultimaGravacao: () => gravacao
  };
}

test('status: separa o período do total, e o período é o que o ranking usa', () => {
  const db = dbDeMentira({
    sessoes: [
      { startedAt: INICIO + H, endedAt: INICIO + 3 * H, totalDiamonds: 700 },    // dentro
      { startedAt: INICIO - 5 * H, endedAt: INICIO - 4 * H, totalDiamonds: 100 } // antes
    ]
  });
  const [s] = campanhaCom(db).status();
  assert.deepEqual(s.numeros.noPeriodo, { segundos: 2 * 3600, diamantes: 700, lives: 1 });
  assert.deepEqual(s.numeros.tudo, { segundos: 3 * 3600, diamantes: 800, lives: 2 });
});

test('status: a live no ar já entra na conta', () => {
  const comecouEm = Date.now() - H;
  periodo.salvar({ inicio: comecouEm - H, fim: comecouEm + 24 * H }, 'chefe');
  const db = dbDeMentira({ atual: { comecouEm, diamantes: 250 } });
  const [s] = campanhaCom(db).status();
  assert.equal(s.numeros.noPeriodo.diamantes, 250);
  assert.equal(s.numeros.noPeriodo.lives, 1);
  assert.ok(s.numeros.noPeriodo.segundos >= 3600);
  periodo.salvar({ inicio: INICIO, fim: INICIO + 24 * H }, 'chefe');
});

test('status: um sniper com erro segue na lista, sem número inventado', () => {
  const campanha = criarCampanha({ clientes: { abrir: () => { throw new Error('banco fora'); } } });
  const original = console.error;
  console.error = () => {};
  const [s] = campanha.status();
  console.error = original;
  assert.equal(s.recado, 'Erro ao ler o status.');
  assert.equal(s.numeros, undefined);
});

test('ranking público não leva diamante nem horas', () => {
  const db = dbDeMentira({ sessoes: [{ startedAt: INICIO + H, endedAt: INICIO + 3 * H, totalDiamonds: 700 }] });
  const { ranking } = campanhaCom(db).getRanking();
  assert.equal(ranking.length, 1);
  assert.deepEqual(Object.keys(ranking[0]).sort(), ['aoVivo', 'arroba', 'avatar', 'nome', 'posicao', 'total']);
});

test('gravação: o que a tela mostra é o que ficou no banco, e a falha aparece', () => {
  const db = dbFabrica.paraDono('gravador');
  db.markLiveOnline();
  db.addGift('fa1', 'Fã', 'Rosa', 300, null);
  db.markLiveOffline();
  db.saveToDisk();

  assert.ok(db.ultimaGravacao().em > 0);
  assert.equal(db.ultimaGravacao().erro, null);
  assert.equal(banco.carregar('gravador').global.totalDiamonds, 300);

  const certo = banco.gravar;
  const antes = db.ultimaGravacao().em;
  banco.gravar = () => { throw new Error('disco cheio'); };
  db.addGift('fa1', 'Fã', 'Rosa', 1, null);
  assert.throws(() => db.saveToDisk(), /disco cheio/);
  assert.deepEqual(db.ultimaGravacao(), { em: antes, erro: 'disco cheio' });

  banco.gravar = certo;
  db.saveToDisk();
  assert.equal(db.ultimaGravacao().erro, null);
  assert.equal(banco.carregar('gravador').global.totalDiamonds, 301);
  db.fechar();
});
