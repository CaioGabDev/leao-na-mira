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

// menor que os 5 min do relógio de power-ups, que o db de mentira não sustenta
process.env.INTERVALO_EULER_MS = '120000';

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

function montar({ euler, connect } = {}) {
  const conta = { checagens: 0, conexoes: 0, perguntasAoEuler: 0, salas: [] };
  const live = criarLive({
    dono: 'teste',
    db: dbDeMentira,
    emitir: () => {},
    criarConexao: () => ({
      on() {},
      disconnect() {},
      fetchIsLive: async () => { conta.checagens++; throw falhaDasFontes(); },
      apiClient: euler && {
        anchors: {
          retrieveRoomId: async () => { conta.perguntasAoEuler++; return { data: euler }; }
        }
      },
      connect: connect || (async sala => {
        conta.conexoes++;
        conta.salas.push(sala);
        return { roomId: sala || '1', roomInfo: null };
      })
    })
  });
  return { live, conta };
}

// deixa as promessas da tentativa em andamento terminarem
const assentar = () => new Promise(resolve => setImmediate(resolve));

test.beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'log', () => {});
  // `now` real: o relógio simulado começa em 0, e aí a primeira pergunta ao
  // Euler pareceria estar dentro do intervalo
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
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

test('bloqueado e ao vivo: conecta na sala que o Euler passou', async () => {
  const { live, conta } = montar({ euler: { code: 200, is_live: true, room_id: '777' } });
  live.iniciar();
  await assentar();
  assert.equal(conta.perguntasAoEuler, 1);
  assert.deepEqual(conta.salas, ['777']);
  live.parar();
});

test('bloqueado e offline: não gasta assinatura e respeita o intervalo do Euler', async () => {
  const { live, conta } = montar({ euler: { code: 200, is_live: false } });
  live.iniciar();
  await assentar();
  assert.equal(live.estadoDaConexao().ultimaTentativa.motivo, 'offline');

  // 90s: passam novas checagens, mas o Euler ainda não pode ser perguntado
  for (let i = 0; i < 3; i++) { mock.timers.tick(30000); await assentar(); }
  assert.ok(conta.checagens >= 2, 'as checagens gratuitas têm que continuar');
  assert.equal(conta.perguntasAoEuler, 1);
  assert.equal(live.estadoDaConexao().ultimaTentativa.motivo, 'offline');

  // vencido o intervalo, pergunta de novo
  for (let i = 0; i < 4; i++) { mock.timers.tick(30000); await assentar(); }
  assert.equal(conta.perguntasAoEuler, 2);
  assert.equal(conta.conexoes, 0);
  live.parar();
});

test('o Euler também recusa: fica incerto, mostra o motivo e não conecta', async () => {
  const { live, conta } = montar({ euler: { code: 403, message: 'sem permissao' } });
  live.iniciar();
  await assentar();
  const { motivo, recado } = live.estadoDaConexao().ultimaTentativa;
  assert.equal(motivo, 'erro');
  assert.match(recado, /Euler: código 403: sem permissao/);
  assert.equal(conta.conexoes, 0);
  live.parar();
});

test('bloqueio ao buscar a sala não manda conferir o @', async () => {
  const { live } = montar({
    connect: async () => {
      const err = new Error('Failed to retrieve Room ID from all sources.');
      err.config = { requestErrs: [new Error('Request failed with status code 403 (Forbidden)')] };
      throw err;
    }
  });
  live.iniciar();
  await assentar();
  live.forceReconnect('pedido do administrador', { direto: true });
  mock.timers.tick(5000);
  await assentar();
  const { motivo, recado } = live.estadoDaConexao().ultimaTentativa;
  assert.equal(motivo, 'bloqueio');
  assert.doesNotMatch(recado, /Confira/);
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
