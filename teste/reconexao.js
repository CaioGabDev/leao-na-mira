// ============================================================================
// QUANDO A CHECAGEM DE "ESTÁ AO VIVO?" FALHA
// ----------------------------------------------------------------------------
// Caso real: a live estava no ar, as fontes gratuitas falhavam no servidor e o
// botão Reconectar só repetia a checagem que estava falhando. O log também não
// dizia o motivo, que a lib guarda em `config.requestErrs`.
//
// Roda com:  node --test teste/reconexao.js
// ============================================================================
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const criarLive = require(path.join(__dirname, '..', 'live.js'));

// O motor só precisa que o db exista: nenhum evento chega nestes testes.
const dbDeMentira = new Proxy({}, { get: () => () => undefined });

function falhaDasFontes() {
  const err = new Error('Failed to retrieve live status from all sources.');
  err.config = {
    routeId: 'fetchIsLiveRoute',
    requestErrs: [new Error('bloqueado no HTML'), new Error('API Error 10222')]
  };
  return err;
}

function montar() {
  const conta = { checagens: 0, conexoes: 0 };
  const live = criarLive({
    dono: 'teste',
    db: dbDeMentira,
    emitir: () => {},
    criarConexao: () => ({
      on() {},
      disconnect() {},
      fetchIsLive: async () => { conta.checagens++; throw falhaDasFontes(); },
      connect: async () => { conta.conexoes++; return { roomId: '1', roomInfo: null }; }
    })
  });
  return { live, conta };
}

// deixa as promessas da tentativa em andamento terminarem
const assentar = () => new Promise(resolve => setImmediate(resolve));

test.beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'log', () => {});
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
test.afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test('fala com o TikTok em https, não no http que a lib usa por padrão', () => {
  const { TikTokLiveConnection } = require('tiktok-live-connector');
  const { webClient } = new TikTokLiveConnection('teste', {});
  assert.equal(webClient.getBaseUrl('www.tiktok.com'), 'https://www.tiktok.com');
  assert.equal(webClient.getBaseUrl('webcast.tiktok.com'), 'https://webcast.tiktok.com');
});

test('o painel mostra o motivo de cada fonte, não só o erro genérico', async () => {
  const { live, conta } = montar();
  live.iniciar();
  await assentar();
  assert.equal(conta.conexoes, 0);
  const { recado } = live.estadoDaConexao().ultimaTentativa;
  assert.match(recado, /bloqueado no HTML/);
  assert.match(recado, /API Error 10222/);
  live.parar();
});

test('Reconectar do administrador conecta sem refazer a checagem', async () => {
  const { live, conta } = montar();
  live.iniciar();
  await assentar();
  assert.equal(conta.checagens, 1);

  live.forceReconnect('pedido do administrador', { direto: true });
  mock.timers.tick(5000);
  await assentar();

  assert.equal(conta.checagens, 1, 'não podia ter checado de novo');
  assert.equal(conta.conexoes, 1);
  live.parar();
});

test('reconexão automática continua passando pela checagem', async () => {
  const { live, conta } = montar();
  live.iniciar();
  await assentar();

  live.forceReconnect('watchdog');
  mock.timers.tick(5000);
  await assentar();

  assert.equal(conta.checagens, 2);
  assert.equal(conta.conexoes, 0);
  live.parar();
});
