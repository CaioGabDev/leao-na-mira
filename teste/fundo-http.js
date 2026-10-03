// ============================================================================
// O FUNDO DO MURAL PELAS ROTAS — quem pode mexer na foto de quem
// ----------------------------------------------------------------------------
// O teste do fundos.js prova que o módulo guarda certo. Este prova a parte que
// o módulo não decide: QUEM pode gravar.
//
// A pergunta que paga o teste: o streamer A consegue gravar por cima do fundo
// do streamer B? Se conseguir, um cliente troca a foto do story de outro — e
// como o mural continua funcionando, ninguém descobre até o story sair errado.
//
// Sobe o servidor de verdade numa pasta temporária (banco, usuários e fundos
// próprios) e conversa com ele por HTTP.
//
// Roda com:  node teste/fundo-http.js
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PROJETO = path.join(__dirname, '..');
const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'fundo-http-'));
const PORTA = 3900 + Math.floor(Math.random() * 90);

let falhas = 0;
const ok = (c, m, e) => {
  console.log((c ? '  OK  ' : '  FALHA') + '  ' + m + (e !== undefined ? '  -> ' + e : ''));
  if (!c) falhas++;
};

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);

// ---------- as contas, criadas antes de o servidor subir ----------
// O admin vem primeiro de propósito: o `garantirDono()` promove o único
// usuário a administrador, então um cliente criado sozinho viraria admin.
function prepararContas() {
  const cwdAntes = process.cwd();
  process.chdir(CAIXA);
  const auth = require(path.join(PROJETO, 'auth.js'));
  auth.upsertUser('acasa', 'senha-da-casa-123', { admin: true });
  auth.upsertUser('streamera', 'senha-a-123', { dono: 'streamer-a' });
  auth.upsertUser('streamerb', 'senha-b-123', { dono: 'streamer-b' });
  process.chdir(cwdAntes);
}

// ---------- HTTP mínimo, sem dependência ----------
function pedir(opcoes, corpo) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORTA, ...opcoes }, res => {
      const pedacos = [];
      res.on('data', d => pedacos.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        cabecalhos: res.headers,
        bytes: Buffer.concat(pedacos),
        get texto() { return Buffer.concat(pedacos).toString('utf-8'); },
        json() { try { return JSON.parse(this.texto); } catch (e) { return null; } }
      }));
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

async function entrar(usuario, senha) {
  const corpo = JSON.stringify({ username: usuario, password: senha });
  const r = await pedir({
    method: 'POST', path: '/api/login',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
  }, corpo);
  if (r.status !== 200) throw new Error('login de ' + usuario + ' falhou: ' + r.status + ' ' + r.texto);
  const cookie = (r.cabecalhos['set-cookie'] || [])
    .map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('login sem cookie');
  return cookie;
}

const comoEle = (cookie, extras) => ({ Cookie: cookie, ...(extras || {}) });

function subirServidor() {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, [path.join(PROJETO, 'server.js')], {
      cwd: CAIXA,
      env: {
        ...process.env,
        PORT: String(PORTA),
        TIKTOK_USERNAME: 'acasa',
        RAILWAY_ENVIRONMENT: '',
        SESSION_SECRET: 'segredo-de-teste',
        // sem isto o cookie de sessao sai 'secure' e nao volta em HTTP puro --
        // e o proprio servidor so abre essa excecao com DEV_LOCAL ligado
        DEV_LOCAL: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let saida = '';
    const olhar = d => {
      saida += d.toString();
      if (saida.includes('Servidor rodando')) resolve(filho);
    };
    filho.stdout.on('data', olhar);
    filho.stderr.on('data', olhar);
    filho.on('exit', c => reject(new Error('servidor morreu (' + c + '):\n' + saida.slice(-1500))));
    setTimeout(() => reject(new Error('servidor nao subiu em 25s:\n' + saida.slice(-1500))), 25000);
  });
}

(async () => {
  prepararContas();
  const servidor = await subirServidor();
  console.log('servidor de teste na porta ' + PORTA + ', dados em ' + CAIXA + '\n');

  try {
    const a = await entrar('streamera', 'senha-a-123');
    const b = await entrar('streamerb', 'senha-b-123');
    const casa = await entrar('acasa', 'senha-da-casa-123');

    console.log('=== sem foto escolhida, 404 e a resposta certa ===');
    {
      const r = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(a) });
      ok(r.status === 404, 'quem nunca escolheu recebe 404', r.status);
      ok(r.json() && r.json().temFundo === false, 'dizendo que nao tem fundo', r.texto.slice(0, 60));

      const i = await pedir({ method: 'GET', path: '/api/fundo/info', headers: comoEle(a) });
      ok(i.json().temFundo === false, 'e o /info concorda');
      ok(i.json().dono === 'streamer-a', 'resolvendo o dono pela sessao', i.json().dono);
    }

    console.log('\n=== o streamer grava a dele ===');
    {
      const r = await pedir({
        method: 'POST', path: '/api/fundo',
        headers: comoEle(a, { 'Content-Type': 'image/jpeg', 'Content-Length': JPG.length })
      }, JPG);
      ok(r.status === 200, 'gravou', r.status + ' ' + r.texto.slice(0, 80));

      const g = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(a) });
      ok(g.status === 200, 'e recebe de volta', g.status);
      ok(g.cabecalhos['content-type'] === 'image/jpeg', 'com o tipo certo', g.cabecalhos['content-type']);
      ok(g.bytes.equals(JPG), 'com os bytes intactos');
      ok(!!g.cabecalhos.etag, 'com ETag, pro navegador nao rebaixar a foto velha', g.cabecalhos.etag);
      ok(/no-cache/.test(g.cabecalhos['cache-control'] || ''),
         'e sem cache cego', g.cabecalhos['cache-control']);
    }

    console.log('\n=== E A PERGUNTA QUE IMPORTA: A mexe no fundo de B? ===');
    {
      const r = await pedir({
        method: 'POST', path: '/api/fundo?dono=streamer-b',
        headers: comoEle(a, { 'Content-Type': 'image/png', 'Content-Length': PNG.length })
      }, PNG);
      ok(r.status === 403, 'NAO: 403 ao tentar gravar na live do outro', r.status + ' ' + r.texto.slice(0, 70));

      const d = await pedir({ method: 'DELETE', path: '/api/fundo?dono=streamer-b', headers: comoEle(a) });
      ok(d.status === 403, 'nem apagar a do outro', d.status);

      const i = await pedir({ method: 'GET', path: '/api/fundo/info?dono=streamer-b', headers: comoEle(a) });
      ok(i.status === 403, 'nem espiar o estado da do outro', i.status);

      // e o lado de B continua intacto
      const g = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(b) });
      ok(g.status === 404, 'B continua sem fundo nenhum', g.status);
    }

    console.log('\n=== a foto de um nao e a foto do outro ===');
    {
      await pedir({
        method: 'POST', path: '/api/fundo',
        headers: comoEle(b, { 'Content-Type': 'image/png', 'Content-Length': PNG.length })
      }, PNG);
      const ga = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(a) });
      const gb = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(b) });
      ok(ga.bytes.equals(JPG), 'A recebe a de A');
      ok(gb.bytes.equals(PNG), 'B recebe a de B');
      ok(!ga.bytes.equals(gb.bytes), 'e nao e o mesmo arquivo pros dois (o bug original)');
    }

    console.log('\n=== o que nao e imagem nao entra ===');
    {
      const lixo = Buffer.from('<?php system($_GET[0]); ?>');
      const r = await pedir({
        method: 'POST', path: '/api/fundo',
        headers: comoEle(a, { 'Content-Type': 'image/jpeg', 'Content-Length': lixo.length })
      }, lixo);
      ok(r.status === 400, 'recusa pelos bytes, mesmo com Content-Type de imagem', r.status);

      const g = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(a) });
      ok(g.bytes.equals(JPG), 'e a foto boa de A continua la');

      const vazio = await pedir({
        method: 'POST', path: '/api/fundo',
        headers: comoEle(a, { 'Content-Type': 'image/jpeg', 'Content-Length': 0 })
      });
      ok(vazio.status === 400, 'corpo vazio tambem e recusado', vazio.status);
    }

    console.log('\n=== imagem grande demais responde com nome ===');
    {
      // Era um 500 mudo: o body-parser corta o corpo e, sem tratamento, o
      // streamer ve "deu erro" sem saber que o problema e o tamanho nem o que
      // fazer. O navegador reduz antes de enviar, entao quem chega aqui e quem
      // caiu no caminho sem redimensionamento.
      const gigante = Buffer.concat([JPG, Buffer.alloc(7 * 1024 * 1024, 3)]);
      const r = await pedir({
        method: 'POST', path: '/api/fundo',
        headers: comoEle(a, { 'Content-Type': 'image/jpeg', 'Content-Length': gigante.length })
      }, gigante);
      ok(r.status === 413, 'responde 413, nao 500 mudo', r.status);
      ok(/MB/.test((r.json() || {}).error || ''), 'dizendo que o problema e o tamanho',
         (r.json() || {}).error);

      const g = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(a) });
      ok(g.status === 200 && g.bytes.equals(JPG), 'e a foto que estava la continua inteira');
    }

    console.log('\n=== a instalacao nao tem fundo (e o porque do bug) ===');
    {
      const r = await pedir({
        method: 'POST', path: '/api/fundo',
        headers: comoEle(casa, { 'Content-Type': 'image/jpeg', 'Content-Length': JPG.length })
      }, JPG);
      ok(r.status === 400, 'admin sem escolher live: recusado', r.status);
      ok(/cada live/.test(r.json() && r.json().error || ''), 'com o motivo dito na cara',
         (r.json() || {}).error);

      const i = await pedir({ method: 'GET', path: '/api/fundo/info', headers: comoEle(casa) });
      ok(i.json().daInstalacao === true, 'e o /info avisa a tela', i.texto.slice(0, 70));
    }

    console.log('\n=== o admin mexe na live de um cliente ===');
    {
      const r = await pedir({
        method: 'POST', path: '/api/fundo?dono=streamer-b',
        headers: comoEle(casa, { 'Content-Type': 'image/jpeg', 'Content-Length': JPG.length })
      }, JPG);
      ok(r.status === 200, 'escolhendo a live, grava', r.status + ' ' + r.texto.slice(0, 70));

      const g = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(b) });
      ok(g.bytes.equals(JPG), 'e B ve a foto nova');
      ok(g.cabecalhos['content-type'] === 'image/jpeg', 'com o tipo trocado junto (era png)',
         g.cabecalhos['content-type']);
    }

    console.log('\n=== tirar a foto ===');
    {
      const r = await pedir({ method: 'DELETE', path: '/api/fundo', headers: comoEle(a) });
      ok(r.status === 200 && r.json().apagou === true, 'apagou', r.texto.slice(0, 60));
      const g = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(a) });
      ok(g.status === 404, 'e voltou pro degrade das cores da marca (404)', g.status);
      const gb = await pedir({ method: 'GET', path: '/api/fundo', headers: comoEle(b) });
      ok(gb.status === 200, 'sem encostar na de B', gb.status);
    }

    console.log('\n=== sem login nao passa ===');
    {
      const g = await pedir({ method: 'GET', path: '/api/fundo' });
      ok(g.status === 401, 'GET sem sessao: 401', g.status);
      const p = await pedir({
        method: 'POST', path: '/api/fundo?dono=streamer-b',
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': JPG.length }
      }, JPG);
      ok(p.status === 401, 'POST sem sessao: 401', p.status);
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
