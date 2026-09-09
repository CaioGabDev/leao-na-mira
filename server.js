const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const ConnectionClass = TikTokLiveConnection;
const db = require('./db');
const auth = require('./auth');
const { FileSessionStore } = require('./session-store');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'vitorb0rba';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

app.use(express.static('public'));

let liveOnline = false;
let currentConnection = null;
let lastEventAt = Date.now();
let reconnecting = false;
let connectionCounter = 0;
let activeConnectionId = 0;
let disconnectedSince = null; // marca quando a conexão caiu, sem ainda considerar a live encerrada

function broadcastLiveStatus() {
  io.emit('live_status', { online: liveOnline });
}

const POWERUP_GIFTS = ['GG', 'Rocket', 'Universe'];

function broadcastRanking() {
  io.emit('ranking', db.getRanking());
}

let liveFeed = [];
function pushFeed(event) {
  event.timestamp = Date.now();
  liveFeed.push(event);
  if (liveFeed.length > 50) liveFeed.shift();
  io.emit('live_feed_event', event);
}

function broadcastGlobalStats() {
  io.emit('global_stats', db.getGlobalStats());
}

function processarBadges(data) {
  // displayId é o @ do usuário; uniqueId aqui era o id numérico e criava um
  // registro paralelo ao do ranking pra mesma pessoa.
  const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
  const nickname = data.user?.nickname || data.nickname;
  const avatar = getAvatar(data);
  // badgeList é o nome na v2 da lib (userBadges era v1) — sem isso nenhum
  // nível era lido e a tropa nunca enchia sozinha.
  const badges = data.user?.badgeList || data.user?.userBadges;
  if (!badges && !data.user) return;

  const subidas = db.checkLevelUp(uniqueId, nickname, avatar, badges, data.user);
  subidas.forEach(item => io.emit('tropa_add', item));
}

// Só considera a live REALMENTE encerrada (fecha a sessão no histórico e
// zera o cronômetro de duração) se ficarmos esse tempo sem reconectar.
// Antes, toda queda de conexão — mesmo uma reconexão rápida de rede —
// disparava markLiveOffline/markLiveOnline na hora, e isso fazia a duração
// da live voltar a zero no meio da transmissão sem o streamer ter encerrado
// nada.
const OFFLINE_GRACE_MS = 90 * 1000;

function markSessionEndedIfNeeded(motivo) {
  if (!liveOnline) return;
  console.log(`Encerrando sessão (motivo: ${motivo})`);
  liveOnline = false;
  db.markLiveOffline();
  broadcastLiveStatus();
}

function forceReconnect(motivo) {
  if (reconnecting) return;
  reconnecting = true;
  console.log(`Forçando reconexão (motivo: ${motivo})`);
  activeConnectionId = -1;
  if (!disconnectedSince) disconnectedSince = Date.now();

  try {
    if (currentConnection) currentConnection.disconnect();
  } catch (e) {
    console.error('Erro ao desconectar conexão antiga:', e?.message || e);
  }

  setTimeout(() => {
    reconnecting = false;
    startTikTokConnection();
  }, 5000);
}

function getAvatar(data) {
  return data.profilePictureUrl
    || data.user?.avatarThumb?.urlList?.[0]
    || data.user?.profilePicture?.url
    || null;
}

const translationCache = {};

async function translateGiftName(name) {
  if (!name) return name;
  if (translationCache[name]) return translationCache[name];
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(name)}&langpair=en|pt-BR`);
    const data = await res.json();
    const translated = data?.responseData?.translatedText || name;
    translationCache[name] = translated;
    return translated;
  } catch (e) {
    console.error('Erro ao traduzir presente:', e.message);
    return name; // se falhar, usa o nome original em inglês
  }
}

// Contador de quantas vezes o roomUser (contagem de espectadores) chegou desde
// que o processo subiu. Serve só pra diagnóstico: se esse número não sobe
// durante a live, é porque o TikTok não está mandando o evento (limitação da
// API deles, não é bug do nosso código) — dá pra ver isso no log do servidor.
let roomUserEventCount = 0;

function startTikTokConnection() {
  const myId = ++connectionCounter;
  const connection = new ConnectionClass(TIKTOK_USERNAME, {
    signApiKey: process.env.EULERSTREAM_API_KEY
  });
  currentConnection = connection;

  connection.connect().then(state => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME} (roomId ${state.roomId}) [conn #${myId}]`);
    activeConnectionId = myId;
    lastEventAt = Date.now();
    disconnectedSince = null;
    // Se já estava "ao vivo" (foi só uma reconexão rápida), mantém a mesma
    // sessão rodando — só abre uma sessão nova quando a live tinha mesmo
    // sido dada como encerrada.
    if (!liveOnline) {
      liveOnline = true;
      db.markLiveOnline();
      broadcastLiveStatus();
    }
  }).catch(err => {
    console.error('Erro ao conectar na live:', err?.message || err);
    if (!disconnectedSince) disconnectedSince = Date.now();
    console.log('Tentando novamente em 10s...');
    setTimeout(startTikTokConnection, 10000);
  });

  connection.on('error', err => {
    console.error(`Erro do connection [conn #${myId}]:`, err?.message || err);
  });

  connection.on('streamEnd', (reason) => {
    if (myId !== activeConnectionId) return;
    console.log('Live encerrada pelo streamer (streamEnd):', reason);
    // streamEnd é um sinal explícito do TikTok de que a live acabou de
    // verdade, então aqui sim fechamos a sessão na hora (diferente de uma
    // simples queda de conexão).
    markSessionEndedIfNeeded('streamEnd');
    forceReconnect('streamEnd');
  });

  connection.on('like', data => {
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const count = data.count || data.likeCount || 1;
    db.addLikes(uniqueId, nickname, count, getAvatar(data));
    broadcastRanking();
  });

  connection.on('chat', data => {
    processarBadges(data);
    if (myId !== activeConnectionId) return;
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const avatar = getAvatar(data);
    // O texto do comentário vem em `content` na v2 da lib (o campo `comment`
    // só existia na v1) — por isso o feed aparecia vazio.
    // Alguns comentários chegam sem texto mesmo (ex: reações/figurinhas).
    // Guardamos como veio — quem decide o texto de exibição é o front-end.
    const comment = (data.content || data.comment || '').trim();
    db.addComment(uniqueId, nickname, avatar, comment);
    broadcastGlobalStats();
    pushFeed({ type: 'chat', uniqueId, nickname, avatar, text: comment });
  });

  connection.on('social', data => {
    if (myId !== activeConnectionId) return;
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const avatar = getAvatar(data);
    const label = (data.label || data.displayType || '').toLowerCase();

    if (label.includes('follow')) {
      db.addFollow(uniqueId, nickname, avatar);
      broadcastRanking();
      broadcastGlobalStats();
      pushFeed({ type: 'follow', uniqueId, nickname, avatar });
    } else if (label.includes('share')) {
      db.addShare(uniqueId, nickname, avatar);
      broadcastRanking();
      broadcastGlobalStats();
      pushFeed({ type: 'share', uniqueId, nickname, avatar });
    }
  });

  connection.on('member', data => {
    processarBadges(data);
    if (myId !== activeConnectionId) return;
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const avatar = getAvatar(data);
    pushFeed({ type: 'join', uniqueId, nickname, avatar });
  });

  // ÚNICO listener de roomUser (antes existiam dois, duplicados, um deles
  // nem chamava db.updateViewerCount — foi removido).
  connection.on('roomUser', data => {
    if (myId !== activeConnectionId) return;
    const count = data.viewerCount ?? 0;
    roomUserEventCount++;
    console.log(`[roomUser #${roomUserEventCount}] espectadores: ${count}`);
    db.updateViewerCount(count);
    broadcastGlobalStats();
    io.emit('viewer_count', { count });
  });

  connection.on('gift', data => {
    processarBadges(data);
    if (myId !== activeConnectionId) return;
    if (data.gift?.type === 1 && !data.repeatEnd) return;
    lastEventAt = Date.now();

    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const giftNameEn = data.gift?.name;
    const diamondCount = data.gift?.diamondCount || 0;
    const repeatCount = data.repeatCount || 1;
    const avatar = getAvatar(data);

    const isPowerUp = POWERUP_GIFTS.includes(giftNameEn);

    // Nunca espera a tradução: usa o que já tiver em cache (ou o nome em
    // inglês como fallback) e processa o presente na hora — assim uma chuva
    // de presentes não fica travada esperando resposta de uma API externa.
    // Se o nome ainda não tá traduzido, dispara a tradução em segundo plano
    // só pra esquentar o cache pros próximos presentes iguais.
    const giftNamePt = translationCache[giftNameEn] || giftNameEn;
    if (giftNameEn && !translationCache[giftNameEn]) translateGiftName(giftNameEn);

    if (isPowerUp) {
      db.addPowerUp(uniqueId, nickname, giftNamePt, avatar);
    } else {
      db.addGift(uniqueId, nickname, giftNamePt, diamondCount * repeatCount, avatar);
    }
    broadcastRanking();
    broadcastGlobalStats();
  });

  connection.on('disconnected', () => {
    if (myId !== activeConnectionId) return;
    console.log(`Desconectado da live [conn #${myId}]. Tentando reconectar...`);
    // Não fecha a sessão aqui — pode ser só uma queda de rede rápida. Quem
    // decide se isso virou "live encerrada" é o watchdog abaixo, depois de
    // OFFLINE_GRACE_MS sem conseguir reconectar.
    activeConnectionId = -1;
    if (!disconnectedSince) disconnectedSince = Date.now();
    setTimeout(startTikTokConnection, 5000);
  });
}

const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
setInterval(() => {
  if (liveOnline && !reconnecting && Date.now() - lastEventAt > WATCHDOG_TIMEOUT_MS) {
    forceReconnect('watchdog: sem eventos há muito tempo');
  }
  if (liveOnline && disconnectedSince && Date.now() - disconnectedSince > OFFLINE_GRACE_MS) {
    markSessionEndedIfNeeded('sem reconectar por muito tempo');
  }
}, 30000);

app.post('/api/reset', (req, res) => {
  db.resetAll();
  broadcastRanking();
  res.json({ ok: true });
});

app.get('/api/ranking', (req, res) => {
  res.json(db.getRanking());
});

app.get('/api/sessions', (req, res) => {
  res.json(db.getSessions());
});

app.get('/api/user/:uniqueId', (req, res) => {
  const profile = db.getUserProfile(req.params.uniqueId);
  if (!profile.user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(profile);
});

io.on('connection', socket => {
  socket.emit('ranking', db.getRanking());
  socket.emit('live_status', { online: liveOnline });
  socket.emit('live_feed_init', liveFeed);
  socket.emit('global_stats', db.getGlobalStats());
  socket.emit('tropa_init', db.getTropa());
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
  startTikTokConnection();
});