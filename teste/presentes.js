// ============================================================================
// PRESENTES NO FIM DA LIVE
// ----------------------------------------------------------------------------
// Caso real: o streamer tinha 300 diamantes, ganhou presente no último minuto,
// fechou a live com 500 e o site ficou nos 300. Presente em combo só contava no
// aviso de fim do combo, e a lib desliga assim que a live encerra.
//
// Roda num dados.db de uma pasta temporária, com o db de verdade: o que importa
// é o que a sessão guardou, porque é isso que vira ponto.
//
// Roda com:  node --test teste/presentes.js
// ============================================================================
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-presentes-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;

const raiz = arquivo => path.join(__dirname, '..', arquivo);
const dbFabrica = require(raiz('db.js'));
const criarLive = require(raiz('live.js'));

const assentar = () => new Promise(resolve => setImmediate(resolve));

let numero = 0;
async function liveNoAr() {
  const db = dbFabrica.paraDono('streamer' + (++numero));
  const conexoes = [];
  const live = criarLive({
    dono: 'streamer' + numero,
    db,
    emitir: () => {},
    avisar: async () => {},
    criarConexao: () => {
      const ouvintes = {};
      const conexao = {
        on(evento, fn) { (ouvintes[evento] = ouvintes[evento] || []).push(fn); },
        emitir(evento, dados) { (ouvintes[evento] || []).forEach(fn => fn(dados)); },
        disconnect() {},
        connect: async () => ({ roomId: '1', roomInfo: null })
      };
      conexoes.push(conexao);
      return conexao;
    }
  });
  live.iniciar();
  await assentar();
  // uma live com menos de 10s não entra no histórico
  mock.timers.tick(20000);
  await assentar();
  return { db, live, conexao: () => conexoes[conexoes.length - 1] };
}

function presente({ quem = 'fa', nome = 'Rosa', diamantes = 100, tipo = 2, repeticoes = 1, fim = 0, grupo = 'g1' } = {}) {
  return {
    user: { uniqueId: quem, nickname: quem },
    giftId: 1,
    groupId: grupo,
    repeatCount: repeticoes,
    repeatEnd: fim,
    gift: { name: nome, type: tipo, diamondCount: diamantes }
  };
}

const combo = campos => presente({ tipo: 1, ...campos });
const diamantesDaLive = db => db.numerosDaLiveAtual().diamantes;

test.beforeEach(() => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  // a tradução do nome do presente sai pra internet
  mock.method(globalThis, 'fetch', async () => ({ json: async () => ({}) }));
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
});
test.afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test('presente comum conta na hora', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', presente({ diamantes: 300 }));
  assert.equal(diamantesDaLive(db), 300);
  live.parar();
});

test('combo com aviso de fim conta uma vez só, pelo total', async () => {
  const { db, live, conexao } = await liveNoAr();
  for (let n = 1; n <= 4; n++) conexao().emitir('gift', combo({ repeticoes: n, diamantes: 10 }));
  assert.equal(diamantesDaLive(db), 0, 'combo em andamento ainda não fechou');
  conexao().emitir('gift', combo({ repeticoes: 5, diamantes: 10, fim: 1 }));
  assert.equal(diamantesDaLive(db), 50);
  live.parar();
});

test('o caso real: 300 diamantes, combo no fim, live fecha sem o aviso de fim', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', presente({ diamantes: 300 }));
  conexao().emitir('gift', combo({ repeticoes: 20, diamantes: 10 }));

  conexao().emitir('streamEnd', { action: 3 });
  conexao().emitir('disconnected');   // a lib desliga logo depois do streamEnd
  mock.timers.tick(3000);
  await assentar();

  const sessoes = db.getSessions();
  assert.equal(sessoes.length, 1);
  assert.equal(sessoes[0].totalDiamonds, 500);
  live.parar();
});

test('presente que chega logo depois do fim da live ainda conta', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', presente({ diamantes: 300 }));
  conexao().emitir('streamEnd', { action: 3 });
  conexao().emitir('gift', presente({ diamantes: 200 }));
  mock.timers.tick(3000);
  await assentar();
  assert.equal(db.getSessions()[0].totalDiamonds, 500);
  live.parar();
});

test('o fim da live fecha a sessão mesmo com a lib desligando antes', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', presente({ diamantes: 10 }));
  conexao().emitir('streamEnd', { action: 3 });
  conexao().emitir('disconnected');
  assert.equal(db.getSessions().length, 0, 'ainda esperando os últimos eventos');
  mock.timers.tick(3000);
  await assentar();
  assert.equal(db.getSessions().length, 1);
  assert.equal(db.numerosDaLiveAtual(), null);
  live.parar();
});

test('combo que parou sem aviso conta sozinho, com a live seguindo', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', combo({ repeticoes: 3, diamantes: 10 }));
  // aos poucos: num salto só, o vigia já acordaria enxergando o horário final
  mock.timers.tick(10000);
  assert.equal(diamantesDaLive(db), 0, 'ainda dentro dos 30s');
  for (let i = 0; i < 3; i++) mock.timers.tick(10000);
  assert.equal(diamantesDaLive(db), 30);
  live.parar();
});

test('aviso de fim atrasado não conta em dobro, só o que faltava', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', combo({ repeticoes: 3, diamantes: 10 }));
  mock.timers.tick(60000);
  assert.equal(diamantesDaLive(db), 30);

  conexao().emitir('gift', combo({ repeticoes: 3, diamantes: 10, fim: 1 }));
  assert.equal(diamantesDaLive(db), 30);
  live.parar();
});

test('combo que continua depois de contado soma só a diferença', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', combo({ repeticoes: 3, diamantes: 10 }));
  mock.timers.tick(60000);
  conexao().emitir('gift', combo({ repeticoes: 5, diamantes: 10, fim: 1 }));
  assert.equal(diamantesDaLive(db), 50);
  live.parar();
});

test('dois combos ao mesmo tempo não se misturam', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', combo({ quem: 'ana', repeticoes: 2, diamantes: 10 }));
  conexao().emitir('gift', combo({ quem: 'bia', repeticoes: 3, diamantes: 10 }));
  conexao().emitir('gift', combo({ quem: 'ana', repeticoes: 2, diamantes: 10, fim: 1 }));
  assert.equal(diamantesDaLive(db), 20);
  conexao().emitir('gift', combo({ quem: 'bia', repeticoes: 3, diamantes: 10, fim: 1 }));
  assert.equal(diamantesDaLive(db), 50);
  live.parar();
});

test('novo combo do mesmo fã não herda a contagem do anterior', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', combo({ repeticoes: 5, diamantes: 10 }));
  mock.timers.tick(60000);
  conexao().emitir('gift', combo({ repeticoes: 2, diamantes: 10, fim: 1 }));
  assert.equal(diamantesDaLive(db), 70);
  live.parar();
});

test('Foguete, Universo e GG somam diamantes na campanha', async () => {
  const { db, live, conexao } = await liveNoAr();
  conexao().emitir('gift', presente({ nome: 'Rocket', diamantes: 20000 }));
  conexao().emitir('gift', presente({ nome: 'Universe', diamantes: 34999 }));
  conexao().emitir('gift', combo({ nome: 'GG', diamantes: 1, repeticoes: 3, fim: 1 }));
  assert.equal(diamantesDaLive(db), 20000 + 34999 + 3);
  live.parar();
});
