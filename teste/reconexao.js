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

function paginaDoPerfil(usuario) {
  const dados = { __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: usuario } } } };
  const html = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
    JSON.stringify(dados) + '</script>';
  return { ok: true, status: 200, text: async () => html };
}

const paginaDeFirewall = { ok: true, status: 200, text: async () => '<html>firewall</html>' };

// sem `perfil`, a página cai no firewall, como no bloqueio de verdade
function montar({ euler, connect, perfil, fetchIsLive } = {}) {
  const conta = { checagens: 0, conexoes: 0, perguntasAoEuler: 0, leiturasDePerfil: 0, salas: [], alertas: [] };
  const live = criarLive({
    dono: 'teste',
    db: dbDeMentira,
    emitir: () => {},
    avisar: async texto => { conta.alertas.push(texto); },
    buscar: async () => {
      conta.leiturasDePerfil++;
      return perfil ? paginaDoPerfil(perfil) : paginaDeFirewall;
    },
    criarConexao: () => ({
      on() {},
      disconnect() {},
      fetchIsLive: async () => {
        conta.checagens++;
        if (fetchIsLive) return fetchIsLive();
        throw falhaDasFontes();
      },
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

test('perfil diz ao vivo: conecta na sala dele sem perguntar ao Euler', async () => {
  const { live, conta } = montar({
    perfil: { uniqueId: 'Teste', roomId: '555' },
    euler: { code: 200, is_live: false }
  });
  live.iniciar();
  await assentar();
  assert.deepEqual(conta.salas, ['555']);
  assert.equal(conta.perguntasAoEuler, 0);
  live.parar();
});

test('perfil diz offline: não conecta nem pergunta ao Euler', async () => {
  const { live, conta } = montar({
    perfil: { uniqueId: 'teste', roomId: '' },
    euler: { code: 200, is_live: true, room_id: '777' }
  });
  live.iniciar();
  await assentar();
  assert.equal(live.estadoDaConexao().ultimaTentativa.motivo, 'offline');
  assert.equal(conta.conexoes, 0);
  assert.equal(conta.perguntasAoEuler, 0);
  live.parar();
});

test('perfil de outro @ não vale: a sala dele não é usada', async () => {
  const { live, conta } = montar({
    perfil: { uniqueId: 'outra_pessoa', roomId: '555' },
    euler: { code: 200, is_live: false }
  });
  live.iniciar();
  await assentar();
  assert.equal(conta.conexoes, 0);
  assert.equal(conta.perguntasAoEuler, 1);
  live.parar();
});

test('perfil sem o campo roomId não vira "offline"', async () => {
  const { live, conta } = montar({ perfil: { uniqueId: 'teste' } });
  live.iniciar();
  await assentar();
  const { motivo, recado } = live.estadoDaConexao().ultimaTentativa;
  assert.equal(motivo, 'erro');
  assert.match(recado, /sem o campo roomId/);
  assert.equal(conta.conexoes, 0);
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

// anda o relógio aos poucos, deixando cada tentativa terminar
async function passar(segundos) {
  for (let s = 0; s < segundos; s += 10) {
    mock.timers.tick(10000);
    await assentar();
  }
}

test('alerta: problema que dura 3 min avisa uma vez só, com o motivo', async () => {
  const { live, conta } = montar();
  live.iniciar();
  await assentar();

  await passar(150);
  assert.equal(conta.alertas.length, 0, 'antes dos 3 min não avisa');

  await passar(60);
  assert.equal(conta.alertas.length, 1);
  assert.match(conta.alertas[0], /@teste: sem conexão há 3 min/);
  assert.match(conta.alertas[0], /bloqueado no HTML/);

  await passar(60);
  assert.equal(conta.alertas.length, 1, 'não pode repetir o mesmo problema');
  live.parar();
});

test('alerta: avisa de novo quando a live conecta', async () => {
  let bloqueado = true;
  const { live, conta } = montar({
    fetchIsLive: async () => {
      if (bloqueado) throw falhaDasFontes();
      return true;
    }
  });
  live.iniciar();
  await assentar();
  await passar(210);
  assert.equal(conta.alertas.length, 1);

  bloqueado = false;
  await passar(150);
  assert.equal(conta.conexoes, 1);
  assert.equal(conta.alertas.length, 2);
  assert.match(conta.alertas[1], /@teste: conectou de novo/);
  live.parar();
});

test('alerta: offline confirmado não avisa', async () => {
  const { live, conta } = montar({ fetchIsLive: async () => false });
  live.iniciar();
  await assentar();
  await passar(240);
  assert.equal(conta.alertas.length, 0);
  live.parar();
});

test('alerta: falha que passa antes dos 3 min não avisa', async () => {
  let bloqueado = true;
  const { live, conta } = montar({
    fetchIsLive: async () => {
      if (bloqueado) throw falhaDasFontes();
      return false;
    }
  });
  live.iniciar();
  await assentar();
  await passar(60);
  bloqueado = false;
  await passar(180);
  assert.equal(conta.alertas.length, 0);
  live.parar();
});

test('alerta: conectar falhando também avisa, mesmo com a checagem dizendo ao vivo', async () => {
  const { live, conta } = montar({
    fetchIsLive: async () => true,
    connect: async () => { throw new Error('assinador caiu'); }
  });
  live.iniciar();
  await assentar();
  await passar(210);
  assert.equal(conta.alertas.length, 1);
  assert.match(conta.alertas[0], /assinador caiu/);
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
