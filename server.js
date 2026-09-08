const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const ConnectionClass = TikTokLiveConnection;
const db = require('./db');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'vitorb0rba';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));
app.use(express.json());

let liveOnline = false;
let currentConnection = null;
let lastEventAt = Date.now();
let reconnecting = false;
let connectionCounter = 0;
let activeConnectionId = 0;

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

function forceReconnect(motivo) {
  if (reconnecting) return;
  reconnecting = true;
  console.log(`Forçando reconexão (motivo: ${motivo})`);
  liveOnline = false;
  broadcastLiveStatus();
  activeConnectionId = -1;

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

function startTikTokConnection() {
  const myId = ++connectionCounter;
  const connection = new ConnectionClass(TIKTOK_USERNAME, {
    signApiKey: process.env.EULERSTREAM_API_KEY
  });
  currentConnection = connection;

  connection.connect().then(state => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME} (roomId ${state.roomId}) [conn #${myId}]`);
    activeConnectionId = myId;
    liveOnline = true;
    lastEventAt = Date.now();
    broadcastLiveStatus();
  }).catch(err => {
    console.error('Erro ao conectar na live:', err?.message || err);
    console.log('Tentando novamente em 10s...');
    setTimeout(startTikTokConnection, 10000);
  });

  connection.on('error', err => {
    console.error(`Erro do connection [conn #${myId}]:`, err?.message || err);
  });

  connection.on('streamEnd', (reason) => {
    if (myId !== activeConnectionId) return;
    console.log('Live encerrada pelo streamer (streamEnd):', reason);
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
  if (myId !== activeConnectionId) return;
  const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
  const nickname = data.user?.nickname || data.nickname;
  const avatar = getAvatar(data);
  const comment = data.comment || '';
  db.addComment(uniqueId, nickname, avatar);
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
  if (myId !== activeConnectionId) return;
  const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
  const nickname = data.user?.nickname || data.nickname;
  const avatar = getAvatar(data);
  pushFeed({ type: 'join', uniqueId, nickname, avatar });
});

connection.on('roomUser', data => {
  if (myId !== activeConnectionId) return;
  const count = data.viewerCount || 0;
  db.updateViewerCount(count);
  broadcastGlobalStats();
  io.emit('viewer_count', { count });
});

connection.on('gift', async data => {
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
  const giftNamePt = await translateGiftName(giftNameEn); 

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
    liveOnline = false;
    activeConnectionId = -1;
    broadcastLiveStatus();
    setTimeout(startTikTokConnection, 5000);
  });

  connection.on('roomUser', data => {
  if (myId !== activeConnectionId) return;
  io.emit('viewer_count', { count: data.viewerCount || 0 });
});
}

const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
setInterval(() => {
  if (liveOnline && !reconnecting && Date.now() - lastEventAt > WATCHDOG_TIMEOUT_MS) {
    forceReconnect('watchdog: sem eventos há muito tempo');
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