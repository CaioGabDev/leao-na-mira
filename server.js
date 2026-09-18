const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const ConnectionClass = TikTokLiveConnection;
const fs = require('fs');
const path = require('path');
const criarRegistro = require('./clientes');
const assinatura = require('./assinatura');
const auth = require('./auth');
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
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

auth.seedFromEnv();

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-troque-em-producao';
if (!process.env.SESSION_SECRET) {
  console.warn('AVISO: SESSION_SECRET não definido. Configure essa env var em produção (Railway).');
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
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 dias sem acessar
  }
});
app.use(sessionMiddleware);
app.use(express.json());

// mesma sessão do Express também vale pra conexão de socket
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (socket.request.session && socket.request.session.user) return next();
  next(new Error('unauthorized'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  // troca o id da sessão ao logar, pra um id capturado antes do login não valer nada
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
    req.session.user = username;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
      res.json({ ok: true });
    });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
}

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/api/login') return next();
  requireAuth(req, res, next);
});

// Quais cartas (e quantas) uma premiação deu. O TikTok não manda isso pela
// live — mostra no painel dele — então quem informa é quem está assistindo.
// O restante do estoque é automático: o uso desconta e os 5 dias vencem.
app.post('/api/powerup/itens', (req, res) => {
  const { uniqueId, ganhaEm, itens } = req.body || {};
  if (!uniqueId || !ganhaEm) {
    return res.status(400).json({ error: 'uniqueId e ganhaEm são obrigatórios.' });
  }
  if (itens && typeof itens !== 'object') {
    return res.status(400).json({ error: 'itens deve ser um objeto { tipo: quantidade }.' });
  }
  const { db, live } = clientes.doPedido(req);
  const ok = db.definirItensDaPremiacao(uniqueId, ganhaEm, itens || {});
  if (!ok) return res.status(404).json({ error: 'Premiação não encontrada.' });

  live.broadcastPowerUps();
  res.json({ ok: true });
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
app.use(['/admin.html', '/api/config', '/api/clientes'], requireAdmin);

// `?dono=@fulano` edita a cara daquele cliente; sem ele, a da instalação.
function donoDoPedido(req) {
  const bruto = (req.query && req.query.dono) || (req.body && req.body.dono) || '';
  return config.usuarioTikTok(bruto);
}

app.get('/api/config', (req, res) => {
  const dono = donoDoPedido(req);
  res.json({
    dono,                                                // '' = a instalação
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
  const dono = donoDoPedido(req);
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

  const dePe = new Set(clientes.listar().map(c => c.dono));
  res.json({
    padrao: TIKTOK_USERNAME,
    clientes: [...donos].sort().map(dono => ({
      dono,
      daCasa: dono === TIKTOK_USERNAME,
      ligado: dePe.has(dono),
      temConfig: config.listarClientes().includes(dono),
      usuarios: usuarios.filter(u => (u.dono || TIKTOK_USERNAME) === dono).map(u => u.username)
    }))
  });
});

app.post('/api/clientes', (req, res) => {
  const { usuario, senha } = req.body || {};
  const dono = config.usuarioTikTok((req.body && req.body.dono) || '');

  if (!usuario || !senha) return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  if (!dono) return res.status(400).json({ error: 'O @ da live do cliente é obrigatório.' });
  if (String(senha).length < 6) return res.status(400).json({ error: 'A senha precisa de pelo menos 6 caracteres.' });
  if (auth.loadUsers().some(u => u.username === usuario)) {
    return res.status(409).json({ error: 'Já existe alguém com esse nome de usuário.' });
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

// Tira o ACESSO de alguém. Os dados da live não são apagados aqui de
// propósito: apagar é irreversível e não pode sair de um clique na lista.
app.post('/api/clientes/remover-acesso', (req, res) => {
  const { usuario } = req.body || {};
  if (!usuario) return res.status(400).json({ error: 'Qual usuário?' });
  if (usuario === (req.session && req.session.user)) {
    return res.status(400).json({ error: 'Não dá pra remover o seu próprio acesso.' });
  }
  const users = auth.loadUsers();
  const restante = users.filter(u => u.username !== usuario);
  if (restante.length === users.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

  auth.saveUsers(restante);
  res.json({ ok: true });
});

// ---------- PÁGINAS COM A MARCA DO CLIENTE ----------
// As páginas continuam sendo arquivos estáticos. A única coisa que acontece
// aqui é trocar os {{marcadores}} pelo config antes de entregar. Vem ANTES do
// express.static de propósito: senão ele entrega o arquivo cru.
// Lista fechada de nomes — nada de montar caminho com o que veio na URL.
const PAGINAS = new Set(['index.html', 'mural.html', 'login.html', 'diagnostico.html', 'admin.html']);
const cachePagina = new Map();   // nome|variante -> { mtimeMs, versao, html }

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const nome = req.path === '/' ? 'index.html' : req.path.slice(1);
  if (!PAGINAS.has(nome)) return next();

  const arquivo = path.join(__dirname, 'public', nome);
  let stat;
  try { stat = fs.statSync(arquivo); } catch (e) { return next(); }

  // A cara da página é a do cliente de quem está logado; o link da engrenagem
  // só existe pro dono. O cache guarda uma versão por combinação dos dois,
  // senão um cliente serviria a página pintada do outro.
  const ehAdmin = !!(req.session && req.session.user && auth.ehAdmin(req.session.user));
  let dono = '';
  try { dono = clientes.doPedido(req).dono; } catch (e) { dono = ''; }
  const chave = nome + '|' + dono + (ehAdmin ? '|dono' : '|comum');

  const guardado = cachePagina.get(chave);
  if (guardado && guardado.mtimeMs === stat.mtimeMs && guardado.versao === config.getVersao()) {
    res.type('html');
    return res.send(guardado.html);
  }

  let html;
  try { html = fs.readFileSync(arquivo, 'utf-8'); } catch (e) { return next(); }
  html = config.aplicar(html, { ehAdmin, dono });
  cachePagina.set(chave, { mtimeMs: stat.mtimeMs, versao: config.getVersao(), html });
  res.type('html');
  res.send(html);
});

app.use(express.static('public'));

app.post('/api/reset', (req, res) => {
  const { db, live } = clientes.doPedido(req);
  db.resetAll();
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
  if (!nome || !tipo) return res.status(400).json({ error: 'nome e tipo são obrigatórios' });
  const { db, sala } = clientes.doPedido(req);
  const removeu = db.removerDaTropa(nome, tipo);
  if (removeu) io.to(sala).emit('tropa_removida', { nome, tipo });
  res.json({ ok: true, removeu });
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