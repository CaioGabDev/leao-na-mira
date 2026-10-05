// ============================================================================
// ABRE UMA PÁGINA NUM NAVEGADOR DE VERDADE, MEXE NELA E TIRA UMA FOTO
// ----------------------------------------------------------------------------
// Serve pra conferir o que o teste de rota não alcança: se a tela ficou do
// jeito que eu disse que ficou. Já me pegou duas vezes dizendo que um elemento
// estava escondido enquanto o pixel mostrava ele na cara.
//
// Fala CDP (Chrome DevTools Protocol) direto, sem puppeteer: o `ws` já vem com
// o socket.io, então não entra dependência nova no projeto por causa de teste.
//
//   node teste/navegar.js <url> <foto.png> [largura] [altura] [acao.js]
//
// `acao.js` é um arquivo com UMA expressão JS (normalmente uma async IIFE) que
// roda dentro da página; o que ela devolver é impresso aqui. A foto sai depois
// da ação, pra capturar o estado final.
//
// COOKIE=connect.sid=xxx  entra como cookie da sessão — é assim que a página
// abre logada sem passar pela tela de login.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const [, , URL_ALVO, SAIDA, LARG = '900', ALT = '1200', ACAO] = process.argv;
if (!URL_ALVO || !SAIDA) {
  console.error('uso: node teste/navegar.js <url> <foto.png> [larg] [alt] [acao.js]');
  process.exit(2);
}

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const navegador = CHROMES.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!navegador) { console.error('não achei Chrome nem Edge instalado'); process.exit(2); }

const PORTA = 9300 + Math.floor(Math.random() * 600);
const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), 'navegar-'));

// Perfil novo a cada vez: perfil reaproveitado traz cookie e cache da rodada
// anterior, e aí um teste passa por causa do estado do outro.
const chrome = spawn(navegador, [
  '--headless=new',
  '--remote-debugging-port=' + PORTA,
  '--user-data-dir=' + PERFIL,
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=' + LARG + ',' + ALT,
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const dorme = ms => new Promise(r => setTimeout(r, ms));

function pegarJson(caminho) {
  return new Promise((ok, falha) => {
    http.get({ host: '127.0.0.1', port: PORTA, path: caminho }, res => {
      let t = '';
      res.on('data', d => (t += d));
      res.on('end', () => { try { ok(JSON.parse(t)); } catch (e) { falha(e); } });
    }).on('error', falha);
  });
}

async function esperarNavegador() {
  for (let i = 0; i < 60; i++) {
    try { return await pegarJson('/json/version'); } catch (e) { await dorme(250); }
  }
  throw new Error('o navegador não abriu a porta de depuração');
}

// ---------- uma conversa CDP mínima ----------
function abrirCanal(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let seq = 0;
  const esperando = new Map();
  const ouvintes = [];

  ws.on('message', bruto => {
    let m; try { m = JSON.parse(bruto); } catch (e) { return; }
    if (m.id && esperando.has(m.id)) {
      const { ok, falha } = esperando.get(m.id);
      esperando.delete(m.id);
      m.error ? falha(new Error(m.error.message)) : ok(m.result);
    } else if (m.method) {
      ouvintes.forEach(f => f(m));
    }
  });

  return {
    pronto: new Promise((ok, falha) => { ws.on('open', ok); ws.on('error', falha); }),
    manda(metodo, params) {
      const id = ++seq;
      return new Promise((ok, falha) => {
        esperando.set(id, { ok, falha });
        ws.send(JSON.stringify({ id, method: metodo, params: params || {} }));
      });
    },
    ouve(f) { ouvintes.push(f); },
    fecha() { try { ws.close(); } catch (e) {} }
  };
}

(async () => {
  let canal;
  try {
    await esperarNavegador();
    const abas = await pegarJson('/json/list');
    const aba = abas.find(a => a.type === 'page');
    if (!aba) throw new Error('nenhuma aba aberta');

    canal = abrirCanal(aba.webSocketDebuggerUrl);
    await canal.pronto;

    // o erro da página é o que mais interessa quando algo não aparece
    canal.ouve(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        console.error('ERRO na página:', d.exceptionDetails || d.text,
          (d.exception && d.exception.description || '').split('\n')[0]);
      }
    });

    await canal.manda('Page.enable');
    await canal.manda('Runtime.enable');
    await canal.manda('Network.enable');
    await canal.manda('Emulation.setDeviceMetricsOverride', {
      width: Number(LARG), height: Number(ALT), deviceScaleFactor: 1, mobile: false
    });

    if (process.env.COOKIE) {
      const alvo = new (require('url').URL)(URL_ALVO);
      for (const parte of process.env.COOKIE.split(';')) {
        const [nome, ...resto] = parte.trim().split('=');
        if (!nome || !resto.length) continue;
        await canal.manda('Network.setCookie', {
          name: nome, value: resto.join('='),
          domain: alvo.hostname, path: '/'
        });
      }
    }

    const carregou = new Promise(ok => canal.ouve(m => {
      if (m.method === 'Page.loadEventFired') ok();
    }));
    await canal.manda('Page.navigate', { url: URL_ALVO });
    await Promise.race([carregou, dorme(20000)]);
    await dorme(900);   // respiro pro JS da página montar a tela

    if (ACAO) {
      const codigo = fs.readFileSync(ACAO, 'utf-8');
      const r = await canal.manda('Runtime.evaluate', {
        expression: codigo,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (r.exceptionDetails) {
        const e = r.exceptionDetails;
        console.error('ERRO no script da página:',
          e.text, (e.exception && e.exception.description || '').split('\n')[0]);
      } else if (r.result && r.result.value !== undefined) {
        console.log(r.result.value);
      }
      await dorme(500);
    }

    const foto = await canal.manda('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SAIDA, Buffer.from(foto.data, 'base64'));
    console.log('foto: ' + SAIDA);
  } catch (e) {
    console.error('falhou:', e.message);
    process.exitCode = 1;
  } finally {
    if (canal) canal.fecha();
    try { chrome.kill(); } catch (e) {}
    await dorme(300);
    try { fs.rmSync(PERFIL, { recursive: true, force: true }); } catch (e) {}
  }
})();
