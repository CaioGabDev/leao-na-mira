// ============================================================================
// TIRAR UMA PESSOA DO RANKING
// ----------------------------------------------------------------------------
// Até esta rota existir, a única limpeza era o /api/reset — apaga tudo de todo
// mundo. Agora dá pra tirar uma pessoa só, e isso abre duas perguntas que
// valem teste:
//
//   1. O streamer A consegue apagar gente do ranking do streamer B?
//      Se conseguir, um cliente mexe nos dados de outro e ninguém descobre:
//      a pessoa some e não há registro de quem tirou.
//   2. Apagar uma pessoa mexe nos NÚMEROS DA LIVE?
//      Os totais (likes, comentários, diamantes) têm que ficar: o que ela deu,
//      deu. Já os contadores de GENTE caem um, porque tem uma pessoa a menos.
//
// Sobe o servidor de verdade numa pasta temporária e conversa por HTTP.
//
// Roda com:  node teste/ranking-remover.js
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PROJETO = path.join(__dirname, '..');
const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-rm-'));
const PORTA = 3700 + Math.floor(Math.random() * 90);

let falhas = 0;
const ok = (c, m, e) => {
  console.log((c ? '  OK  ' : '  FALHA') + '  ' + m + (e !== undefined ? '  -> ' + e : ''));
  if (!c) falhas++;
};

// ---------- contas e dados, antes de o servidor subir ----------
function prepararCaixa() {
  const cwdAntes = process.cwd();
  process.chdir(CAIXA);

  const auth = require(path.join(PROJETO, 'auth.js'));
  const termos = require(path.join(PROJETO, 'termos.js'));
  const fabrica = require(path.join(PROJETO, 'db.js'));

  // o admin primeiro: o `garantirDono` promove o único usuário a admin, então
  // um cliente criado sozinho viraria administrador
  auth.upsertUser('acasa', 'senha-da-casa-123', { admin: true });
  for (const [usuario, dono] of [['streamera', 'live-a'], ['streamerb', 'live-b']]) {
    auth.upsertUser(usuario, 'senha-123456', { dono });
    auth.registrarAceite(usuario, termos.registroDeAceite({
      dono, ip: '127.0.0.1', userAgent: 'teste',
      prova: { metodo: 'dispensada' }, declaracoes: {}
    }));
  }

  // Ids DIFERENTES nas duas lives, de proposito: com os mesmos ids dos dois
  // lados, "A nao alcancou a live de B" fica indistinguivel de "A removeu o da
  // propria live" -- e e exatamente isso que o teste precisa separar.
  for (const [dono, suf] of [['live-a', 'a'], ['live-b', 'b']]) {
    const db = fabrica.paraDono(dono);
    db.resetAll();
    db.addLikes('bot-' + suf, 'Bot Chato ' + suf, 9999, null);
    db.addFollow('bot-' + suf, 'Bot Chato ' + suf, null);
    db.addLikes('gente-' + suf, 'Pessoa de Verdade ' + suf, 120, null);
    db.addComment('gente-' + suf, 'Pessoa de Verdade ' + suf, null, 'salve');
    db.saveToDisk();
    // fecha: a instancia deixa um relogio de gravacao de pe, e logo abaixo o
    // processo volta pra pasta do projeto. Um timer desses escrevendo com o
    // cwd trocado e como dado de teste acaba na base de verdade.
    db.fechar();
  }

  process.chdir(cwdAntes);
}

function pedir(opcoes, corpo) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORTA, ...opcoes }, res => {
      const pedacos = [];
      res.on('data', d => pedacos.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        texto: Buffer.concat(pedacos).toString('utf-8'),
        json() { try { return JSON.parse(this.texto); } catch (e) { return null; } }
      }));
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

// o login so serve se devolver o cookie, entao precisa dos cabecalhos
function entrarComCookie(usuario, senha) {
  const corpo = JSON.stringify({ username: usuario, password: senha });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORTA, method: 'POST', path: '/api/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
    }, res => {
      const pedacos = [];
      res.on('data', d => pedacos.push(d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('login ' + usuario + ': ' + res.statusCode));
        const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        cookie ? resolve(cookie) : reject(new Error('login sem cookie'));
      });
    });
    req.on('error', reject);
    req.write(corpo);
    req.end();
  });
}

const comoEle = (cookie, extras) => ({ Cookie: cookie, ...(extras || {}) });

async function remover(cookie, uniqueId) {
  const corpo = JSON.stringify({ uniqueId });
  return pedir({
    method: 'POST', path: '/api/ranking/remover',
    headers: comoEle(cookie, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) })
  }, corpo);
}

const painel = async cookie => (await pedir({ method: 'GET', path: '/api/dashboard', headers: comoEle(cookie) })).json();
// o dashboard traz os NUMEROS; quem traz os apelidos e o /api/ranking -- usar o
// dashboard pra conferir presenca daria asserção que passa sem testar nada
const ranking = async cookie => (await pedir({ method: 'GET', path: '/api/ranking', headers: comoEle(cookie) })).json();

function subirServidor() {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, [path.join(PROJETO, 'server.js')], {
      cwd: CAIXA,
      env: {
        ...process.env,
        PORT: String(PORTA), TIKTOK_USERNAME: 'acasa',
        RAILWAY_ENVIRONMENT: '', SESSION_SECRET: 'segredo-de-teste',
        // sem isto o cookie de sessão sai `secure` e não volta em HTTP puro
        DEV_LOCAL: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let saida = '';
    const olhar = d => { saida += d.toString(); if (saida.includes('Servidor rodando')) resolve(filho); };
    filho.stdout.on('data', olhar);
    filho.stderr.on('data', olhar);
    filho.on('exit', c => reject(new Error('servidor morreu (' + c + '):\n' + saida.slice(-1200))));
    setTimeout(() => reject(new Error('servidor não subiu em 25s:\n' + saida.slice(-1200))), 25000);
  });
}

(async () => {
  prepararCaixa();
  const servidor = await subirServidor();
  console.log('servidor de teste na porta ' + PORTA + '\n');

  try {
    const a = await entrarComCookie('streamera', 'senha-123456');
    const b = await entrarComCookie('streamerb', 'senha-123456');

    console.log('=== o streamer tira alguem da PROPRIA live ===');
    {
      const antes = JSON.stringify(await ranking(a));
      ok(antes.includes('Bot Chato a'), 'o bot esta la antes');

      const r = await remover(a, 'bot-a');
      ok(r.status === 200, 'removeu', r.status + ' ' + r.texto.slice(0, 60));

      const depois = JSON.stringify(await ranking(a));
      ok(!depois.includes('Bot Chato a'), 'e sumiu do ranking');
      ok(depois.includes('Pessoa de Verdade a'), 'sem levar os outros junto');
    }

    console.log('\n=== E A PERGUNTA QUE IMPORTA: A apaga gente da live de B? ===');
    {
      // A manda o id de alguem de B. O escopo sai da SESSAO, nao do corpo --
      // entao o id de B simplesmente nao existe dentro da live de A.
      const r = await remover(a, 'bot-b');
      ok(r.status === 404, 'NAO: o id da live de B nao existe na live de A', r.status);

      const d = await remover(a, 'gente-b');
      ok(d.status === 404, 'nem o outro', d.status);

      const deB = JSON.stringify(await ranking(b));
      ok(deB.includes('Bot Chato b'), 'e a live de B continua inteira');
      ok(deB.includes('Pessoa de Verdade b'), 'com todo mundo dela');
    }

    console.log('\n=== os numeros da live ===');
    {
      // Decisao que precisa continuar valendo: os totais sao o que a live
      // recebeu, e apagar uma pessoa nao desfaz o que ela ja deu.
      const antes = (await painel(b)).acumulado;
      await remover(b, 'bot-b');
      const depois = (await painel(b)).acumulado;

      ok(depois.likes === antes.likes,
         'os likes totais NAO mudam', antes.likes + ' -> ' + depois.likes);
      ok(depois.comentarios === antes.comentarios,
         'os comentarios totais tambem nao', antes.comentarios + ' -> ' + depois.comentarios);
      ok(depois.pessoas === antes.pessoas - 1,
         'mas as pessoas caem uma', antes.pessoas + ' -> ' + depois.pessoas);
      ok(depois.seguidores === antes.seguidores - 1,
         'e quem seguiu tambem', antes.seguidores + ' -> ' + depois.seguidores);
    }

    console.log('\n=== entrada torta ===');
    {
      const vazio = await remover(a, '');
      ok(vazio.status === 400, 'id vazio: 400', vazio.status);

      const semNada = await pedir({
        method: 'POST', path: '/api/ranking/remover',
        headers: comoEle(a, { 'Content-Type': 'application/json', 'Content-Length': 2 })
      }, '{}');
      ok(semNada.status === 400, 'corpo sem id: 400', semNada.status);

      const proto = await remover(a, '__proto__');
      ok(proto.status === 400, '__proto__ nao passa', proto.status);

      const inexistente = await remover(a, 'nao-existe-ninguem');
      ok(inexistente.status === 404, 'quem nao esta no ranking: 404', inexistente.status);
    }

    console.log('\n=== sem login nao passa ===');
    {
      const corpo = JSON.stringify({ uniqueId: 'gente-a' });
      const r = await pedir({
        method: 'POST', path: '/api/ranking/remover',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
      }, corpo);
      ok(r.status === 401, 'POST sem sessao: 401', r.status);

      const p = await ranking(a);
      ok(JSON.stringify(p).includes('Pessoa de Verdade a'), 'e ninguem foi removido');
    }

  } catch (e) {
    falhas++;
    console.log('\n  FALHA  o teste estourou: ' + e.message);
  } finally {
    try { servidor.kill(); } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
    try { fs.rmSync(CAIXA, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(falhas ? '\n>>> ' + falhas + ' FALHA(S)' : '\n>>> TODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})();
