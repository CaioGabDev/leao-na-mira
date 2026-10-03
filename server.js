const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const ConnectionClass = TikTokLiveConnection;
const fs = require('fs');
const path = require('path');
const criarRegistro = require('./clientes');
const dbFabrica = require('./db');   // só pela lista de tipos de carta
const assinatura = require('./assinatura');
const auth = require('./auth');
const chaves = require('./chaves');
const posse = require('./posse');
const termos = require('./termos');
const config = require('./config');
const { FileSessionStore } = require('./session-store');

// @ da live: o que o dono configurou vence; sem config, a env var de sempre.
// Lido UMA vez, na subida do servidor, de propósito: trocar de live com a
// coisa rodando misturaria duas lives dentro dos dados do mesmo dono.
const TIKTOK_USERNAME = config.get().live.usuario || process.env.TIKTOK_USERNAME || 'vitorb0rba';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Quem é o dono de cada requisição, e em que sala cada navegador escuta.
// Enquanto houver um cliente só, todo mundo cai no TIKTOK_USERNAME e nada muda.
const clientes = criarRegistro({ io, donoPadrao: TIKTOK_USERNAME });

// ---------- Login / sessão ----------
// Quem pode logar é cadastrado com `node create-user.js <usuario> <senha>`
// (gera/atualiza o users.json). Veja o README.
// As duas frouxuras que só fazem sentido numa máquina de desenvolvimento —
// segredo de sessão de brinquedo e cookie sem `secure` — ficam atrás desta
// variável, e de mais nada. Antes dependiam de `NODE_ENV`: esquecer a variável
// no deploy deixava a sessão com um segredo que está no git e o cookie viajando
// em HTTP, e o servidor subia igual, só com um aviso no log que ninguém lê.
// Agora o padrão é o seguro, e quem quer o frouxo pede.
const DEV_LOCAL = process.env.DEV_LOCAL === '1';

// Atrás de proxy (Railway) o `secure` do cookie só funciona com isto ligado,
// e é o que faz o req.ip ser o IP de quem pediu — o freio de tentativa conta
// por IP, então sem isto todo mundo viraria o mesmo IP do proxy.
if (!DEV_LOCAL) app.set('trust proxy', 1);

// ---------- cabeçalhos de segurança ----------
// À mão, e não com o helmet, pelo mesmo motivo do node:sqlite: dependência nova
// é coisa pra atualizar e auditar pra sempre, e o que se precisa aqui são sete
// cabeçalhos fixos. Primeiro middleware de propósito: assim até a resposta 401 e
// o arquivo estático saem com eles.
//
// A CSP não proíbe script inline: TODA página deste projeto tem um <script> no
// corpo e há onclick= espalhado pelo mural e pelo painel — uma CSP sem
// 'unsafe-inline' desligaria o site inteiro. O que ela faz é o que dá pra fazer
// sem reescrever as telas: script só da própria origem (e do cdnjs, que serve o
// html2canvas do mural), nada de <object>, nada de <base>, nenhum site pode
// embutir esta página num iframe e formulário só posta aqui dentro.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  // o googleapis é a folha do Google Fonts, que toda página carrega
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // os avatares vêm de vários domínios do TikTok, que mudam sem avisar
  "img-src 'self' data: https:",
  // 'self' já cobre o websocket da mesma origem, mas navegador antigo não
  // concorda — e sem socket não há live, então ws/wss vão escritos
  "connect-src 'self' ws: wss:",
  // o arquivo da fonte em si vem do gstatic, não do googleapis
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // só faz sentido onde já se está em HTTPS; em dev seria um tiro no pé, porque
  // o navegador passa a recusar http://localhost por meses
  if (!DEV_LOCAL) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

auth.seedFromEnv();
// Quem vem da versão antiga não tem `admin` em ninguém. Isto resolve uma vez,
// antes de qualquer requisição, pra ninguém ficar trancado pra fora.
auth.garantirDono();

// Sem segredo não tem sessão: o cookie de sessão é o que separa o dono do
// site de qualquer visitante, e com um segredo conhecido dá pra forjar um.
// Então falta de SESSION_SECRET derruba a subida em vez de virar aviso.
const SESSION_SECRET = process.env.SESSION_SECRET
  || (DEV_LOCAL ? 'dev-only-secret-troque-em-producao' : null);
if (!SESSION_SECRET) {
  console.error(
    'ERRO: SESSION_SECRET não definido. Gere um segredo longo e aleatório e ' +
    'configure essa env var (no Railway, em Variables). Pra rodar na sua ' +
    'máquina sem ela, suba com DEV_LOCAL=1.'
  );
  process.exit(1);
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // em arquivo, senão todo restart do servidor desloga todo mundo
  store: new FileSessionStore(),
  // cada visita renova o prazo: quem usa o site com frequência não reloga
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // padrão seguro: só uma subida com DEV_LOCAL=1 aceita cookie em HTTP
    secure: !DEV_LOCAL,
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 dias sem acessar
  }
});
app.use(sessionMiddleware);
app.use(express.json());

// mesma sessão do Express também vale pra conexão de socket
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  // mesma regra do HTTP: a conta precisa existir, não só a sessão
  const usuario = socket.request.session && socket.request.session.user;
  if (usuario && auth.existe(usuario)) return next();
  next(new Error('unauthorized'));
});

// ---------- freio de tentativa de senha ----------
// O login é público e senha é coisa que dá pra chutar — e aqui o chute é mais
// barato que na chave de ativação, porque as senhas têm 6 caracteres de mínimo.
//
// Conta por IP E por usuário, as duas contas no mesmo balde: só por IP, uma
// rede grande (ou um IP trocado a cada tentativa) passa por cima do freio; só
// por usuário, dá pra varrer uma lista de contas de um IP só sem nunca
// esbarrar. Acertar a senha zera as duas — quem entrou não está chutando.
const LOGIN_LIMITE = 10;
const LOGIN_JANELA = 15 * 60 * 1000;
const tentativasDeLogin = new Map();   // 'ip:x' | 'user:y' -> { contagem, ate }

function baldesDoLogin(req, usuario) {
  return ['ip:' + (req.ip || 'desconhecido'),
          'user:' + String(usuario || '').trim().toLowerCase()];
}

function loginTravado(req, usuario) {
  const agora = Date.now();
  return baldesDoLogin(req, usuario).some(balde => {
    const atual = tentativasDeLogin.get(balde);
    return !!atual && agora < atual.ate && atual.contagem >= LOGIN_LIMITE;
  });
}

function errouASenha(req, usuario) {
  const agora = Date.now();
  baldesDoLogin(req, usuario).forEach(balde => {
    const atual = tentativasDeLogin.get(balde);
    if (!atual || agora > atual.ate) {
      tentativasDeLogin.set(balde, { contagem: 1, ate: agora + LOGIN_JANELA });
    } else {
      atual.contagem++;
    }
  });
}

function acertouASenha(req, usuario) {
  baldesDoLogin(req, usuario).forEach(balde => tentativasDeLogin.delete(balde));
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (loginTravado(req, username)) {
    return res.status(429).json({ error: 'Muitas tentativas. Espere alguns minutos.' });
  }
  if (!auth.verifyCredentials(username, password)) {
    errouASenha(req, username);
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  acertouASenha(req, username);
  // troca o id da sessão ao logar, pra um id capturado antes do login não valer nada
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
    req.session.user = username;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
      // o administrador não cai no ranking: a casa dele é o painel
      res.json({ ok: true, destino: auth.ehAdmin(username) ? '/admin.html' : '/index.html' });
    });
  });
});

// A mesma régua pra quem se cadastra por chave e pro que o administrador cria
// na mão — senão dá pra criar pela porta dos fundos uma conta que a outra
// porta recusaria.
const MIN_SENHA = 6;
function validarCredenciais(usuario, senha) {
  const nome = String(usuario || '').trim();
  if (!nome) return 'Escolha um nome de usuário.';
  if (nome.length < 3) return 'O usuário precisa de pelo menos 3 caracteres.';
  if (nome.length > 40) return 'O usuário passou de 40 caracteres.';
  if (!/^[a-zA-Z0-9._-]+$/.test(nome)) {
    return 'No usuário valem letras, números, ponto, hífen e sublinhado.';
  }
  if (!senha || String(senha).length < MIN_SENHA) {
    return `A senha precisa de pelo menos ${MIN_SENHA} caracteres.`;
  }
  if (String(senha).length > 200) return 'Essa senha é longa demais.';
  return null;
}

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  const usuario = req.session && req.session.user;

  // Sessão aberta não basta: a conta pode ter sido apagada depois do login.
  // Sem esta conferência, "tirar o acesso" só impedia entrar DE NOVO — quem
  // já estava com a aba aberta seguia navegando até o cookie vencer.
  if (usuario && auth.existe(usuario)) return next();

  if (usuario) req.session.destroy(() => {});   // sessão órfã não serve pra nada
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
}

// Quem chega com uma chave ainda NÃO tem conta — se estas rotas ficassem
// atrás do login, ativar seria impossível.
const SEM_LOGIN = new Set([
  '/login.html', '/api/login',
  '/ativar.html', '/api/ativar', '/api/ativar/info',
  // os termos abrem pra qualquer um: ninguém deve precisar de conta pra ler o
  // que vai aceitar
  '/termos.html', '/api/termos',
  // a prova de posse acontece ANTES de a conta existir
  '/api/posse/desafio', '/api/posse/conferir'
]);

app.use((req, res, next) => {
  if (SEM_LOGIN.has(req.path)) return next();
  requireAuth(req, res, next);
});

// ---------- ATIVAÇÃO POR CHAVE ----------
// O administrador gera a chave e diz de qual live ela é. Quem recebe escolhe o
// próprio usuário e a própria senha: a senha não passa pela mão de ninguém e o
// administrador nunca fica sabendo dela.

// Freio de tentativa. A rota é pública e chave é coisa que dá pra chutar:
// 12 caracteres num alfabeto de 31 são ~59 bits, então força bruta não ia
// longe — mas sem freio ela vira um jeito barato de fazer barulho no servidor.
const chutes = new Map();   // ip -> { contagem, ate }
const LIMITE_DE_CHUTES = 15;
const JANELA_DE_CHUTES = 10 * 60 * 1000;

// O freio conta UMA coisa: chave rejeitada.
//
// Contar toda requisição parecia mais seguro e era pior: consultar a chave
// certa, errar o formato do usuário ou repetir um nome já usado somavam no
// mesmo balde, e o cliente legítimo travava no meio do próprio cadastro. Quem
// tem uma chave válida na mão já provou que não está chutando — e chutar é a
// única coisa contra a qual este freio serve.
function chuteiAChave(req) {
  const ip = req.ip || 'desconhecido';
  const agora = Date.now();
  const atual = chutes.get(ip);
  if (!atual || agora > atual.ate) {
    chutes.set(ip, { contagem: 1, ate: agora + JANELA_DE_CHUTES });
    return;
  }
  atual.contagem++;
}

function estaDeCastigo(req) {
  const atual = chutes.get(req.ip || 'desconhecido');
  if (!atual || Date.now() > atual.ate) return false;
  return atual.contagem > LIMITE_DE_CHUTES;
}

// Acertou a chave: o IP volta a ter crédito. Senão, ativar vários clientes da
// mesma rede (o mesmo escritório, o mesmo celular) esbarraria no freio.
function limparChutes(req) {
  chutes.delete(req.ip || 'desconhecido');
}

// Os dois baldes são indexados por IP, e IP é coisa que não acaba: sem varrer o
// que já venceu, quem manda uma tentativa de cada endereço faz a memória do
// processo crescer sem teto. Vencido não tem valor nenhum — nem pra travar nem
// pra liberar — então sai.
setInterval(() => {
  const agora = Date.now();
  for (const [ip, item] of chutes) if (agora > item.ate) chutes.delete(ip);
  for (const [balde, item] of tentativasDeLogin) if (agora > item.ate) tentativasDeLogin.delete(balde);
}, 10 * 60 * 1000).unref();

// Diz de qual live a chave é, sem gastar ela. É o que a tela mostra antes da
// pessoa escolher usuário e senha — pra ela saber que caiu no lugar certo.
app.get('/api/ativar/info', (req, res) => {
  if (estaDeCastigo(req)) {
    return res.status(429).json({ error: 'Muitas chaves erradas. Espere alguns minutos.' });
  }
  const conferida = chaves.conferir((req.query && req.query.chave) || '');
  if (!conferida.ok) {
    chuteiAChave(req);
    return res.status(404).json({ error: conferida.motivo });
  }
  limparChutes(req);
  res.json({
    ok: true, dono: conferida.dono, expiraEm: conferida.expiraEm,
    // a tela pula o passo da bio quando a chave dispensa
    exigeProva: conferida.exigeProva
  });
});

// Quem sou eu, pra tela decidir o que mostrar. A pagina de termos abre
// deslogado (ninguem deve precisar de conta pra ler o que vai aceitar), entao
// ela pergunta aqui e aceita levar 401 como resposta.
app.get('/api/eu', (req, res) => {
  const usuario = req.session.user;
  const ehAdmin = auth.ehAdmin(usuario);
  const aceite = auth.aceiteDe(usuario);
  res.json({
    usuario,
    admin: ehAdmin,
    dono: auth.donoDoUsuario(usuario) || null,
    aceiteValido: termos.aceiteValido(aceite),
    versaoAceita: aceite ? aceite.versao : null,
    // ja provou a posse do @ alguma vez? (na ativacao ou depois)
    temProva: !!(aceite && aceite.prova)
  });
});

// ---------- OS TERMOS ----------
app.get('/api/termos', (req, res) => {
  res.json({
    versao: termos.VERSAO,
    titulo: termos.TITULO,
    impressao: termos.impressao(),
    secoes: termos.SECOES
  });
});

// ---------- PROVA DE POSSE DO @ ----------
// De qual live é o desafio: quem está logado prova a PRÓPRIA live; quem não
// está (cadastro) prova a live da chave que tem na mão.
function donoDoDesafio(req) {
  const usuario = req.session && req.session.user;
  if (usuario) return { ok: true, dono: auth.donoDoUsuario(usuario) || '', logado: true };

  if (estaDeCastigo(req)) {
    return { ok: false, codigo: 429, motivo: 'Muitas chaves erradas. Espere alguns minutos.' };
  }
  const conferida = chaves.conferir((req.body && req.body.chave) || '');
  if (!conferida.ok) {
    chuteiAChave(req);
    return { ok: false, codigo: 400, motivo: conferida.motivo };
  }
  limparChutes(req);
  return { ok: true, dono: conferida.dono, logado: false };
}

app.post('/api/posse/desafio', (req, res) => {
  const quem = donoDoDesafio(req);
  if (!quem.ok) return res.status(quem.codigo).json({ error: quem.motivo });
  if (!quem.dono) return res.status(400).json({ error: 'Essa conta não está ligada a nenhuma live.' });

  const desafio = posse.desafiar(quem.dono);
  res.json({
    ok: true,
    dono: desafio.dono,
    codigo: desafio.codigo,
    expiraEm: desafio.expiraEm,
    perfil: 'https://www.tiktok.com/@' + desafio.dono
  });
});

app.post('/api/posse/conferir', async (req, res) => {
  const quem = donoDoDesafio(req);
  if (!quem.ok) return res.status(quem.codigo).json({ error: quem.motivo });
  if (!quem.dono) return res.status(400).json({ error: 'Essa conta não está ligada a nenhuma live.' });

  let r;
  try {
    r = await posse.conferir(quem.dono);
  } catch (e) {
    console.error('prova de posse estourou:', e && e.message);
    return res.status(502).json({ error: 'Não consegui falar com o TikTok agora. Tente de novo.' });
  }
  if (!r.ok) {
    return res.status(400).json({ error: r.motivo, bioLida: r.bioLida, esperar: r.esperar });
  }

  // A prova fica na SESSÃO deste navegador. É o que amarra "provou" a "cadastrou":
  // sem isso, provar numa aba e cadastrar em outra passaria batido.
  req.session.provaDePosse = {
    metodo: 'bio', dono: r.dono, userId: r.userId,
    nickname: r.nickname, codigo: r.codigo, em: new Date().toISOString()
  };
  req.session.save(() => res.json({
    ok: true, dono: r.dono, nickname: r.nickname, userId: r.userId
  }));
});

// ---------- ACEITE DE QUEM JÁ TEM CONTA ----------
// Cliente que o administrador cadastrou na mão, ou que já existia antes dos
// termos: aceita aqui, e a prova de posse entra junto se ele tiver feito.
app.post('/api/aceitar', (req, res) => {
  const usuario = req.session && req.session.user;
  if (!usuario) return res.status(401).json({ error: 'Entre primeiro.' });
  const { aceito, declaracoes } = req.body || {};
  if (!aceito) return res.status(400).json({ error: 'É preciso aceitar os termos.' });

  const dono = auth.donoDoUsuario(usuario) || '';
  const prova = req.session.provaDePosse;
  const vale = prova && posse.normalizar(prova.dono) === posse.normalizar(dono);

  auth.registrarAceite(usuario, termos.registroDeAceite({
    dono,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    prova: vale ? prova : null,
    declaracoes
  }));
  res.json({ ok: true, versao: termos.VERSAO, comProva: !!vale });
});

app.post('/api/ativar', (req, res) => {
  if (estaDeCastigo(req)) {
    return res.status(429).json({ error: 'Muitas chaves erradas. Espere alguns minutos.' });
  }
  const { chave, usuario, senha } = req.body || {};
  const nome = String(usuario || '').trim();

  const conferida = chaves.conferir(chave);
  if (!conferida.ok) {
    chuteiAChave(req);
    return res.status(400).json({ error: conferida.motivo });
  }
  // chave boa: daqui pra frente os erros são de formulário, não de chute
  limparChutes(req);

  const problema = validarCredenciais(nome, senha);
  if (problema) return res.status(400).json({ error: problema });

  // A AUTORIZAÇÃO DO STREAMER. Sem a prova de posse do @, a chave sozinha
  // deixaria qualquer um que a visse cadastrar a live de outra pessoa.
  //
  // A chave pode dispensar a prova — mas aí ela carrega o motivo escrito por
  // quem a criou, e isso vai pro registro no lugar da prova. "Sem prova" e
  // "dispensado pelo Caio em 02/10 porque fechou pessoalmente" são coisas
  // muito diferentes na hora de responder por isso.
  const naSessao = req.session && req.session.provaDePosse;
  const provou = naSessao
    && posse.normalizar(naSessao.dono) === posse.normalizar(conferida.dono);

  let prova;
  if (provou) {
    prova = naSessao;
  } else if (conferida.exigeProva === false) {
    prova = {
      metodo: 'dispensada',
      dono: conferida.dono,
      por: conferida.criadaPor || null,
      motivo: conferida.motivoSemProva || null,
      em: new Date().toISOString()
    };
  } else {
    return res.status(403).json({
      error: 'Falta provar que o @ é seu. Volte e confira o código na bio.',
      precisaProvar: true
    });
  }
  // E o aceite. Ele é gravado junto com a conta, não depois — conta criada sem
  // aceite é exatamente o buraco que isto fecha.
  if (!req.body.aceito) {
    return res.status(400).json({ error: 'É preciso aceitar os termos para ativar.' });
  }
  if (auth.loadUsers().some(u => u.username === nome)) {
    return res.status(409).json({ error: 'Já existe alguém com esse nome de usuário.' });
  }

  // Gastar a chave ANTES de criar a conta. Se o cadastro falhar depois, o
  // prejuízo é uma chave queimada; na ordem inversa, duas ativações
  // simultâneas criariam duas contas com a mesma chave.
  const gasto = chaves.usar(chave, nome);
  if (!gasto.ok) return res.status(400).json({ error: gasto.motivo });

  auth.upsertUser(nome, String(senha), {
    dono: gasto.dono,
    aceite: termos.registroDeAceite({
      dono: gasto.dono,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      prova,
      declaracoes: req.body.declaracoes
    })
  });

  let ligado = false;
  try {
    clientes.iniciar(gasto.dono);
    ligado = true;
  } catch (e) {
    console.error(`Não consegui subir a live @${gasto.dono}:`, e.message);
  }


  // Já entra logado: pedir pra digitar de novo o que acabou de escolher é
  // só um jeito a mais de errar.
  req.session.regenerate(err => {
    if (err) return res.json({ ok: true, dono: gasto.dono, ligado, entrou: false });
    req.session.user = nome;
    req.session.save(() => res.json({ ok: true, dono: gasto.dono, ligado, entrou: true }));
  });
});

// ---------- validação do que chega nas rotas de power-up ----------
// O @ de quem ganhou a carta vira CHAVE de objeto lá dentro, e o tipo da carta
// vira texto na tela de todo mundo que vê aquela live. Então os dois são
// conferidos aqui, na entrada: o que o TikTok não poderia ter mandado não passa.
function identificadorValido(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 80
         && !['__proto__', 'constructor', 'prototype'].includes(v);
}

// Devolve o primeiro tipo que não existe (pra dizer QUAL na resposta), ou null.
function tipoForaDaLista(itens) {
  if (!itens || typeof itens !== 'object') return null;
  return Object.keys(itens).find(t => !dbFabrica.TIPOS_DE_CARTA.has(t)) || null;
}

// Quais cartas (e quantas) uma premiação deu. O TikTok não manda isso pela
// live — mostra no painel dele — então quem informa é quem está assistindo.
// O restante do estoque é automático: o uso desconta e os 5 dias vencem.
app.post('/api/powerup/itens', (req, res) => {
  const { uniqueId, ganhaEm, itens } = req.body || {};
  if (!identificadorValido(uniqueId) || !ganhaEm) {
    return res.status(400).json({ error: 'uniqueId e ganhaEm são obrigatórios.' });
  }
  if (itens && typeof itens !== 'object') {
    return res.status(400).json({ error: 'itens deve ser um objeto { tipo: quantidade }.' });
  }
  const desconhecido = tipoForaDaLista(itens);
  if (desconhecido) {
    return res.status(400).json({ error: `Não conheço a carta "${desconhecido}".` });
  }
  const { db, live } = clientes.doPedido(req);
  const ok = db.definirItensDaPremiacao(uniqueId, ganhaEm, itens || {});
  if (!ok) return res.status(404).json({ error: 'Premiação não encontrada.' });

  live.broadcastPowerUps();
  res.json({ ok: true });
});

// O mesmo item em TODAS as premiações pendentes de alguém. Existe porque a
// fila de "a informar" chega a dezenas, e na prática são quase sempre a mesma
// carta — quem joga luva ganha luva. Uma a uma é trabalho que ninguém faz.
app.post('/api/powerup/itens-pendentes', (req, res) => {
  const { uniqueId, itens } = req.body || {};
  if (!identificadorValido(uniqueId)) {
    return res.status(400).json({ error: 'uniqueId é obrigatório.' });
  }
  if (!itens || typeof itens !== 'object' || !Object.keys(itens).length) {
    return res.status(400).json({ error: 'Escolha pelo menos um item.' });
  }
  const desconhecido = tipoForaDaLista(itens);
  if (desconhecido) {
    return res.status(400).json({ error: `Não conheço a carta "${desconhecido}".` });
  }

  const { db, live } = clientes.doPedido(req);
  const quantas = db.definirItensDasPendentes(uniqueId, itens);
  if (!quantas) {
    return res.status(404).json({ error: 'Essa pessoa não tem premiação pendente no prazo.' });
  }

  live.broadcastPowerUps();
  res.json({ ok: true, quantas });
});


// ---------- SÓ O DONO DA INSTALAÇÃO ----------
// A página de configuração e a API dela ficam atrás de um segundo portão, além
// do login. Quem é dono está explicado no auth.ehAdmin().
function requireAdmin(req, res, next) {
  const usuario = req.session && req.session.user;
  if (usuario && auth.ehAdmin(usuario)) return next();
  // req.path aqui vem sem o prefixo montado, então quem responde é o originalUrl
  if ((req.originalUrl || '').startsWith('/api/')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return res.status(403).send(
    '<!doctype html><meta charset="utf-8"><title>Sem acesso</title>' +
    '<body style="font-family:system-ui;background:#0a0807;color:#f3e9dc;padding:40px">' +
    '<h1>Essa parte é do dono do site</h1>' +
    '<p>Sua conta não tem acesso à configuração.</p>' +
    '<p><a style="color:#ffb03a" href="/">Voltar</a></p>');
}
// O painel e o cadastro são do dono do negócio. A APARÊNCIA não: o cliente
// mexe na cara da live dele (o /api/config decide o escopo por quem pediu).
app.use(['/admin.html', '/api/clientes', '/api/chaves', '/api/espiar'], requireAdmin);

// De quem é a cara que esta requisição pode mexer.
//
// Administrador escolhe: `?dono=@fulano` pra um cliente, vazio pra a
// instalação. Cliente só mexe na live DELE — e se pedir outra, leva 403 em
// vez de ter o pedido redirecionado calado (redirecionar fazia ele
// sobrescrever a própria cara com um texto destinado a outro lugar).
function escopoDoPedido(req) {
  const usuario = (req.session && req.session.user) || null;
  const bruto = (req.query && req.query.dono) || (req.body && req.body.dono) || '';
  const pedido = config.usuarioTikTok(bruto);

  if (auth.ehAdmin(usuario)) return { dono: pedido, permitido: true };

  const meu = clientes.doPedido(req).dono;
  // `dono` vazio quer dizer "a minha", não "a da casa" — então não é recusa
  const pediuOutra = !!bruto && pedido !== meu;
  return { dono: meu, permitido: !pediuOutra };
}

app.get('/api/config', (req, res) => {
  const { dono, permitido } = escopoDoPedido(req);
  if (!permitido) return res.status(403).json({ error: 'Você só pode ver a cara da sua live.' });
  res.json({
    dono,                                                // '' = a instalação
    ehAdmin: auth.ehAdmin((req.session && req.session.user) || null),
    config: config.get(dono),
    instalacao: config.get(),                            // o que o cliente herda
    padrao: config.PADRAO,                               // pro botão "voltar ao padrão"
    clientes: config.listarClientes(),
    liveEmUso: TIKTOK_USERNAME,                          // o @ que o servidor está usando agora
    liveDoAmbiente: process.env.TIKTOK_USERNAME || '',   // o que veio da env var, se veio
    assinatura: assinatura.estado(),                     // com ou sem chave (nunca a chave)
    livesLigadas: clientes.listar().length
  });
});

app.post('/api/config', (req, res) => {
  const { dono, permitido } = escopoDoPedido(req);
  if (!permitido) return res.status(403).json({ error: 'Você só pode mexer na cara da sua live.' });
  let salvo;
  try {
    salvo = config.salvar(req.body || {}, dono);
  } catch (e) {
    console.error('Erro ao salvar config:', e.message);
    return res.status(500).json({ error: 'Não deu pra gravar a configuração.' });
  }
  // só a live da CASA depende de restart; a de um cliente é o @ dele
  const efetivo = dono ? TIKTOK_USERNAME
                       : (salvo.live.usuario || process.env.TIKTOK_USERNAME || 'vitorb0rba');
  res.json({ ok: true, dono, config: salvo, precisaReiniciar: efetivo !== TIKTOK_USERNAME });
});

// ---------- CLIENTES ----------
// Cadastrar um cliente é: criar o login dele e amarrar ao @ da live dele. O
// motor sobe na hora — sem reiniciar o servidor.
app.get('/api/clientes', (req, res) => {
  const usuarios = auth.loadUsers();
  const donos = new Set(config.listarClientes());
  usuarios.forEach(u => { if (u.dono) donos.add(u.dono); });
  donos.add(TIKTOK_USERNAME);

  const abertos = new Map(clientes.listar().map(c => [c.dono, c]));
  const comConfig = config.listarClientes();

  res.json({
    padrao: TIKTOK_USERNAME,
    // administradores não pertencem a live nenhuma: são as contas da casa
    admins: usuarios.filter(u => u.admin === true).map(u => u.username),
    eu: (req.session && req.session.user) || null,
    clientes: [...donos].sort().map(dono => {
      const c = abertos.get(dono);
      const ficha = {
        dono,
        daCasa: dono === TIKTOK_USERNAME,
        ligado: !!c,
        temConfig: comConfig.includes(dono),
        // só quem está amarrado ÀQUELA live; admin não entra na conta de ninguém
        usuarios: usuarios.filter(u => !u.admin && (u.dono || TIKTOK_USERNAME) === dono)
                          .map(u => u.username)
      };

      // Os números de cada live, pro painel mostrar tudo de uma vez sem o
      // administrador ter que entrar em cada uma.
      if (c) {
        try {
          const g = c.db.getGlobalStats();
          ficha.aoVivo = c.live.estaOnline();
          ficha.conexao = c.live.estadoDaConexao();
          ficha.numeros = {
            espectadores: g.currentViewers || 0,
            pico: g.peakViewers || 0,
            diamantes: g.totalDiamonds || 0,
            comentarios: g.totalComments || 0,
            seguiram: g.totalFollows || 0,
            pessoas: c.db.getRanking().length,
            duracaoSegundos: g.uptimeSeconds || 0
          };
        } catch (e) {
          // uma live com problema não pode derrubar a listagem inteira
          ficha.erro = e.message;
        }
      }
      return ficha;
    })
  });
});

app.post('/api/clientes', (req, res) => {
  const { usuario, senha } = req.body || {};
  const ehAdministrador = !!(req.body && req.body.administrador);
  const dono = config.usuarioTikTok((req.body && req.body.dono) || '');

  // administrador é conta da casa: não pertence a live nenhuma
  if (!ehAdministrador && !dono) return res.status(400).json({ error: 'O @ da live do cliente é obrigatório.' });
  const problema = validarCredenciais(usuario, senha);
  if (problema) return res.status(400).json({ error: problema });
  if (auth.loadUsers().some(u => u.username === usuario)) {
    return res.status(409).json({ error: 'Já existe alguém com esse nome de usuário.' });
  }

  if (ehAdministrador) {
    auth.upsertUser(String(usuario).trim(), String(senha), { admin: true, dono: '' });
    return res.json({ ok: true, administrador: true, usuario: String(usuario).trim() });
  }

  auth.upsertUser(String(usuario).trim(), String(senha), { dono });

  // sobe o motor desse cliente agora; se falhar, o cadastro continua valendo
  let ligado = false;
  try {
    clientes.iniciar(dono);
    ligado = true;
  } catch (e) {
    console.error(`Não consegui subir a live @${dono}:`, e.message);
  }

  res.json({ ok: true, dono, ligado });
});

// Promove ou rebaixa um administrador.
//
// Duas travas: ninguém se rebaixa sozinho (evita o clique que tranca a pessoa
// pra fora da própria configuração) e a instalação nunca fica sem nenhum dono.
app.post('/api/clientes/admin', (req, res) => {
  const { usuario } = req.body || {};
  const virar = !!(req.body && req.body.administrador);
  const eu = (req.session && req.session.user) || null;

  if (!usuario) return res.status(400).json({ error: 'Qual usuário?' });
  if (!auth.loadUsers().some(u => u.username === usuario)) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }
  if (!virar) {
    if (usuario === eu) {
      return res.status(400).json({ error: 'Não dá pra tirar o seu próprio acesso de administrador.' });
    }
    const admins = auth.loadUsers().filter(u => u.admin === true).map(u => u.username);
    if (admins.length <= 1 && admins.includes(usuario)) {
      return res.status(400).json({ error: 'Esse é o único administrador — a configuração ficaria inacessível.' });
    }
  }

  auth.setAdmin(usuario, virar);
  // Promover solta a pessoa da live dela: administrador não é de live nenhuma.
  // O caminho de volta NÃO devolve o @ antigo — quem é rebaixado cai na live da
  // casa até alguém amarrar noutra. Por isso a tela avisa disso antes de promover.
  if (virar) auth.setDono(usuario, '');

  res.json({ ok: true, usuario, administrador: virar });
});

// Tira o ACESSO de alguém. Os dados da live não são apagados aqui de
// propósito: apagar é irreversível e não pode sair de um clique na lista.
app.post('/api/clientes/remover-acesso', (req, res) => {
  const { usuario } = req.body || {};
  if (!usuario) return res.status(400).json({ error: 'Qual usuário?' });
  if (usuario === (req.session && req.session.user)) {
    return res.status(400).json({ error: 'Não dá pra remover o seu próprio acesso.' });
  }
  const users = auth.loadUsers();
  const alvo = users.find(u => u.username === usuario);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (alvo.admin === true && users.filter(u => u.admin === true).length <= 1) {
    return res.status(400).json({ error: 'Esse é o único administrador — apagar deixaria a configuração inacessível.' });
  }

  auth.saveUsers(users.filter(u => u.username !== usuario));
  res.json({ ok: true });
});

// ---------- CHAVES ----------
app.get('/api/chaves', (req, res) => {
  res.json({ chaves: chaves.listar(), padrao: TIKTOK_USERNAME });
});

app.post('/api/chaves', (req, res) => {
  const dono = config.usuarioTikTok((req.body && req.body.dono) || '');
  if (!dono) return res.status(400).json({ error: 'A chave precisa do @ da live.' });

  let registro;
  try {
    registro = chaves.gerar({
      dono,
      criadaPor: (req.session && req.session.user) || null,
      validadeDias: req.body && req.body.validadeDias,
      observacao: req.body && req.body.observacao,
      exigeProva: req.body && req.body.exigeProva,
      motivoSemProva: req.body && req.body.motivoSemProva
    });
  } catch (e) {
    // dispensar a prova sem escrever o motivo cai aqui
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true, ...registro });
});

// Virar a exigência de uma chave já enviada. É a saída pro cliente travado
// porque o TikTok barrou a leitura do perfil: o link que ele tem continua
// valendo, só deixa de pedir a bio.
app.post('/api/chaves/exigencia', (req, res) => {
  const { chave, exigeProva, motivoSemProva } = req.body || {};
  const r = chaves.trocarExigencia(chave, exigeProva, motivoSemProva);
  if (!r.ok) return res.status(400).json({ error: r.motivo });
  res.json(r);
});

app.post('/api/chaves/revogar', (req, res) => {
  const ok = chaves.revogar((req.body && req.body.chave) || '');
  if (!ok) return res.status(404).json({ error: 'Chave não encontrada, ou já usada.' });
  res.json({ ok: true });
});

app.post('/api/chaves/apagar', (req, res) => {
  const ok = chaves.apagar((req.body && req.body.chave) || '');
  if (!ok) return res.status(404).json({ error: 'Chave não encontrada.' });
  res.json({ ok: true });
});

// ---------- ESPIAR ----------
// O administrador não tem live própria. Pra dar suporte, ele entra na de um
// cliente — e isso fica guardado na sessão dele, não na do cliente.
app.get('/api/espiar', (req, res) => {
  const dono = config.usuarioTikTok((req.query && req.query.dono) || '');
  if (!dono) return res.status(400).json({ error: 'Qual live?' });
  req.session.espiando = dono;
  req.session.save(() => res.redirect('/index.html'));
});

app.get('/api/espiar/sair', (req, res) => {
  delete req.session.espiando;
  req.session.save(() => res.redirect('/admin.html'));
});

// ---------- PÁGINAS COM A MARCA DO CLIENTE ----------
// As páginas continuam sendo arquivos estáticos. A única coisa que acontece
// aqui é trocar os {{marcadores}} pelo config antes de entregar. Vem ANTES do
// express.static de propósito: senão ele entrega o arquivo cru.
// Lista fechada de nomes — nada de montar caminho com o que veio na URL.
const PAGINAS = new Set(['index.html', 'mural.html', 'login.html', 'ativar.html',
                         'painel.html', 'diagnostico.html', 'admin.html', 'config.html',
                         'termos.html']);
// as telas que pertencem a UMA live — o administrador não mora nelas
const PAGINAS_DE_CLIENTE = new Set(['index.html', 'mural.html', 'painel.html', 'diagnostico.html']);
const cachePagina = new Map();   // nome|variante -> { mtimeMs, versao, html }

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const nome = req.path === '/' ? 'index.html' : req.path.slice(1);
  if (!PAGINAS.has(nome)) return next();

  // A casa do administrador é o painel, não o ranking de uma live: ele é o
  // dono do negócio, não um streamer. Se quiser ver a live de um cliente,
  // entra por "espiar" — e aí a sessão diz de quem é a tela.
  const souDono = !!(req.session && req.session.user && auth.ehAdmin(req.session.user));
  if (souDono && PAGINAS_DE_CLIENTE.has(nome) && !(req.session && req.session.espiando)) {
    return res.redirect('/admin.html');
  }

  // O ACEITE É A PORTA. Cliente sem aceite — ou com aceite de uma versão
  // anterior dos termos — só abre a página dos termos. O administrador fica de
  // fora: ele é a casa, não um streamer, e trancá-lo aqui tiraria dele a única
  // tela de onde se conserta qualquer coisa.
  const logado = req.session && req.session.user;
  if (logado && !souDono && nome !== 'termos.html' && nome !== 'login.html'
      && !termos.aceiteValido(auth.aceiteDe(logado))) {
    return res.redirect('/termos.html');
  }

  const arquivo = path.join(__dirname, 'public', nome);
  let stat;
  try { stat = fs.statSync(arquivo); } catch (e) { return next(); }

  // A cara da página é a do cliente de quem está logado; o link da engrenagem
  // só existe pro dono. O cache guarda uma versão por combinação dos dois,
  // senão um cliente serviria a página pintada do outro.
  const ehAdmin = souDono;
  const espiando = !!(req.session && req.session.espiando);
  let dono = '';
  try { dono = clientes.doPedido(req).dono; } catch (e) { dono = ''; }
  const chave = nome + '|' + dono + (ehAdmin ? '|dono' : '|comum') + (espiando ? '|espiando' : '');

  const guardado = cachePagina.get(chave);
  if (guardado && guardado.mtimeMs === stat.mtimeMs && guardado.versao === config.getVersao()) {
    res.type('html');
    return res.send(guardado.html);
  }

  let html;
  try { html = fs.readFileSync(arquivo, 'utf-8'); } catch (e) { return next(); }
  html = config.aplicar(html, { ehAdmin, dono, espiando });
  cachePagina.set(chave, { mtimeMs: stat.mtimeMs, versao: config.getVersao(), html });
  res.type('html');
  res.send(html);
});

app.use(express.static('public'));

app.post('/api/reset', (req, res) => {
  const { db, live } = clientes.doPedido(req);
  db.resetAll();
  // resetAll apagou a sessão que estava aberta; se a live continua no ar, ela
  // recomeça agora — senão o painel mostra "offline" com a live rolando.
  live.sessaoReiniciada();
  live.broadcastRanking();
  res.json({ ok: true });
});

// Limpa só o mural da tropa (o print da semana recomeça do zero). Ranking,
// likes, presentes e os níveis já conhecidos ficam de pé — diferente do
// /api/reset, que apaga tudo.
app.post('/api/tropa/limpar', (req, res) => {
  const { db, sala } = clientes.doPedido(req);
  db.limparTropa();
  io.to(sala).emit('tropa_limpa');
  res.json({ ok: true });
});

app.post('/api/tropa/remover', (req, res) => {
  const { nome, tipo } = req.body || {};
  // os dois voltam pra tela de todo mundo da sala num `emit`, então nada de
  // aceitar objeto ou texto sem fim aqui
  if (!identificadorValido(nome) || !identificadorValido(tipo)) {
    return res.status(400).json({ error: 'nome e tipo são obrigatórios' });
  }
  const { db, sala } = clientes.doPedido(req);
  const removeu = db.removerDaTropa(nome, tipo);
  if (removeu) io.to(sala).emit('tropa_removida', { nome, tipo });
  res.json({ ok: true, removeu });
});

// Tudo que o streamer quer ver da live dele, num pedido só. O escopo vem do
// clientes.doPedido: cada um enxerga a própria live e nada mais.
app.get('/api/dashboard', (req, res) => {
  const { db } = clientes.doPedido(req);
  res.json(db.getDashboard());
});

// A curva da live, minuto a minuto. `agrupar` junta N minutos num ponto só —
// quem desenha sabe quantos pixels tem, o servidor não.
app.get('/api/serie', (req, res) => {
  const { db } = clientes.doPedido(req);
  const q = req.query || {};
  res.json(db.getSerie({
    desde: Number(q.desde) || undefined,
    ate: Number(q.ate) || undefined,
    agrupar: Number(q.agrupar) || undefined
  }));
});

// O olhar longo: melhores dias, dia da semana, horário e recordes.
app.get('/api/registros', (req, res) => {
  const { db } = clientes.doPedido(req);
  const dias = Number(req.query && req.query.dias);
  res.json(db.getRegistros({ dias: dias > 0 ? Math.min(dias, 400) : undefined }));
});

app.get('/api/batalhas', (req, res) => {
  res.json(clientes.doPedido(req).db.getBattleStats());
});

app.get('/api/ranking', (req, res) => {
  res.json(clientes.doPedido(req).db.getRanking());
});

app.get('/api/sessions', (req, res) => {
  res.json(clientes.doPedido(req).db.getSessions());
});

app.get('/api/user/:uniqueId', (req, res) => {
  if (!identificadorValido(req.params.uniqueId)) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  const profile = clientes.doPedido(req).db.getUserProfile(req.params.uniqueId);
  if (!profile.user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(profile);
});

io.on('connection', socket => {
  // A sala é o que faz este navegador receber SÓ os eventos da live dele.
  // Sem o join, o socket fica surdo — e é assim que tem que ser: melhor uma
  // tela parada do que a tela com os dados de outro cliente.
  const { db, live, sala } = clientes.doSocket(socket);
  socket.join(sala);

  socket.emit('ranking', db.getRanking());
  socket.emit('live_status', { online: live.estaOnline() });
  socket.emit('live_feed_init', live.feed());
  socket.emit('global_stats', db.getGlobalStats());
  socket.emit('tropa_init', db.getTropa());
  socket.emit('battle_stats', db.getBattleStats());
  socket.emit('powerup_estoque', db.getEstoqueCartas());
  socket.emit('diagnostico_init', live.diagnostico());
});


// Último a entrar de propósito: o Express só usa isto se nenhuma rota respondeu.
// Sem ele, um erro dentro de uma rota caía no handler padrão do Express, que
// manda a stack trace inteira pro navegador quando NODE_ENV não é 'production'
// — caminhos de arquivo, nomes de função e número de linha pra quem pediu.
// O log completo continua, só não vai mais pela resposta.
app.use((err, req, res, next) => {
  console.error(`Erro em ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  if ((req.originalUrl || '').startsWith('/api/')) {
    return res.status(500).json({ error: 'Algo deu errado aqui dentro.' });
  }
  res.status(500).type('text').send('Algo deu errado aqui dentro.');
});

process.on('uncaughtException', (err) => {
  console.error('Exceção não tratada:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Promise rejeitada sem tratamento:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(assinatura.resumo());

  // A live da casa sempre sobe. Além dela, sobe uma por cliente cadastrado —
  // quem tem `dono` no users.json (ver create-user.js --dono). Enquanto não
  // existir nenhum, isto é um laço vazio e nada muda.
  const donos = new Set([TIKTOK_USERNAME]);
  try {
    auth.loadUsers().forEach(u => { if (u.dono) donos.add(u.dono); });
  } catch (e) {
    console.error('Não consegui ler os clientes cadastrados:', e.message);
  }

  donos.forEach(dono => {
    try {
      clientes.iniciar(dono);
      console.log(`Motor da live @${dono} de pé.`);
    } catch (e) {
      // um cliente com problema não pode impedir os outros de subir
      console.error(`Falhei ao subir a live @${dono}:`, e.message);
    }
  });
});