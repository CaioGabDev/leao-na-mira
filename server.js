const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-api');
const ConnectionClass = WebcastPushConnection;
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

// Cada conexão criada ganha um número. Só os eventos da conexão MAIS RECENTE
// são processados — isso evita contar em dobro caso uma conexão "antiga"
// ainda esteja viva quando uma nova é criada.
let connectionCounter = 0;
let activeConnectionId = 0;

function broadcastLiveStatus() {
  io.emit('live_status', { online: liveOnline });
}

const POWERUP_GIFTS = ['GG', 'Rocket', 'Universe'];

function broadcastRanking() {
  io.emit('ranking', db.getRanking());
}

function forceReconnect(motivo) {
  if (reconnecting) return;
  reconnecting = true;
  console.log(`Forçando reconexão (motivo: ${motivo})`);
  liveOnline = false;
  broadcastLiveStatus();

  // Invalida a conexão atual IMEDIATAMENTE — mesmo que o disconnect()
  // demore ou falhe, os eventos dela passam a ser ignorados a partir daqui.
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

function startTikTokConnection() {
  const myId = ++connectionCounter;
  const connection = new ConnectionClass(TIKTOK_USERNAME, {
  signApiKey: process.env.TIKTOOL_API_KEY
});
  currentConnection = connection;

  connection.connect().then(state => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME} (roomId ${state.roomId}) [conn #${myId}]`);
    activeConnectionId = myId; // só agora essa conexão passa a valer
    liveOnline = true;
    lastEventAt = Date.now();
    broadcastLiveStatus();
  }).catch(err => {
    console.error('Erro ao conectar na live:', err?.message || err, err?.response?.data || '');
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
  console.log('LIKE RAW:', JSON.stringify({
    uniqueId: data.user?.displayId || data.user?.uniqueId || data.uniqueId,
    nickname: data.user?.nickname || data.nickname,
    count: data.count,
    likeCount: data.likeCount
  }));
  lastEventAt = Date.now();
  const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
  const nickname = data.user?.nickname || data.nickname;
  const count = data.count || data.likeCount || 1;
  db.addLikes(uniqueId, nickname, count);
  broadcastRanking();
});

  connection.on('gift', data => {
    if (myId !== activeConnectionId) return; // ignora eco de conexão antiga
    if (data.gift?.type === 1 && !data.repeatEnd) return;
    lastEventAt = Date.now();

    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const giftName = data.gift?.name;
    const diamondCount = data.gift?.diamondCount || 0;
    const repeatCount = data.repeatCount || 1;

    const isPowerUp = POWERUP_GIFTS.includes(giftName);
    if (isPowerUp) {
      db.addPowerUp(uniqueId, nickname, giftName);
    } else {
      db.addGift(uniqueId, nickname, giftName, diamondCount * repeatCount);
    }
    broadcastRanking();
  });

  connection.on('disconnected', () => {
    if (myId !== activeConnectionId) return;
    console.log(`Desconectado da live [conn #${myId}]. Tentando reconectar...`);
    liveOnline = false;
    activeConnectionId = -1;
    broadcastLiveStatus();
    setTimeout(startTikTokConnection, 5000);
  });
}

// Watchdog: tempo bem mais generoso pra não confundir "silêncio normal"
// com "conexão morta". 5 minutos sem NENHUM like/presente é bem incomum
// numa live ativa com audiência.
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
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