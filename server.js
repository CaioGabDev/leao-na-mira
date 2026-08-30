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

function broadcastLiveStatus() {
  io.emit('live_status', { online: liveOnline });
}

const POWERUP_GIFTS = ['GG', 'Rocket', 'Universe'];

function broadcastRanking() {
  io.emit('ranking', db.getRanking());
}

function forceReconnect(motivo) {
  if (reconnecting) return; // evita disparar reconexão duplicada
  reconnecting = true;
  console.log(`Forçando reconexão (motivo: ${motivo})`);
  liveOnline = false;
  broadcastLiveStatus();

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
  const connection = new ConnectionClass(TIKTOK_USERNAME, {});
  currentConnection = connection;

  connection.connect().then(state => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME} (roomId ${state.roomId})`);
    liveOnline = true;
    lastEventAt = Date.now();
    broadcastLiveStatus();
  }).catch(err => {
    console.error('Erro ao conectar na live:', err?.message || err, err?.response?.data || '');
    console.log('Tentando novamente em 10s...');
    setTimeout(startTikTokConnection, 10000);
  });

  connection.on('error', err => {
    console.error('Erro do connection (evento error):', err?.message || err);
  });

  // Dispara quando o streamer encerra a live de propósito
  connection.on('streamEnd', (reason) => {
    console.log('Live encerrada pelo streamer (streamEnd):', reason);
    forceReconnect('streamEnd');
  });

  connection.on('like', data => {
    lastEventAt = Date.now();
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const count = data.count || data.likeCount || 1;
    db.addLikes(uniqueId, nickname, count);
    broadcastRanking();
  });

  connection.on('gift', data => {
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
    console.log('Desconectado da live. Tentando reconectar...');
    liveOnline = false;
    broadcastLiveStatus();
    setTimeout(startTikTokConnection, 5000);
  });
}

// Watchdog: se o app acha que está "online" mas não chega NENHUM evento
// (like/gift) por muito tempo, provavelmente a live antiga fechou e o
// app ficou "pendurado" numa conexão morta. Força reconexão nesse caso.
const WATCHDOG_TIMEOUT_MS = 90 * 1000; // 90s sem evento = suspeito
setInterval(() => {
  if (liveOnline && !reconnecting && Date.now() - lastEventAt > WATCHDOG_TIMEOUT_MS) {
    forceReconnect('watchdog: sem eventos há muito tempo');
  }
}, 20000);

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