const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLive } = require('@tiktool/live');
const db = require('./db');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'vitorb0rba';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

let liveOnline = false;

function broadcastLiveStatus() {
  io.emit('live_status', { online: liveOnline });
}

function broadcastRanking() {
  io.emit('ranking', db.getRanking());
}

const POWERUP_GIFTS = ['GG', 'Rocket', 'Universe'];

// O evento 'like' traz o TOTAL acumulado por usuário, não um incremento.
// Guardamos o último total visto de cada pessoa pra calcular a diferença.
const lastLikeTotal = {};

function startTikTokConnection() {
  const client = new TikTokLive({
    uniqueId: TIKTOK_USERNAME,
    apiKey: process.env.TIKTOOL_API_KEY
  });

  client.on('chat', () => {}); // não usamos, mas deixa registrado se quiser expandir depois

  client.on('like', event => {
    const uniqueId = event.userId || event.user?.uniqueId || event.nickname;
    const nickname = event.nickname;
    const total = event.totalLikeCount || 0;

    const anterior = lastLikeTotal[uniqueId] || 0;
    const delta = total - anterior;

    if (delta > 0) {
      db.addLikes(uniqueId, nickname, delta);
      broadcastRanking();
    }
    lastLikeTotal[uniqueId] = total;
  });

  client.on('gift', event => {
    const uniqueId = event.userId || event.user?.uniqueId || event.nickname;
    const nickname = event.nickname;
    const giftName = event.giftName;
    const value = event.diamondCount || 0;

    const isPowerUp = POWERUP_GIFTS.includes(giftName);
    if (isPowerUp) {
      db.addPowerUp(uniqueId, nickname, giftName);
    } else {
      db.addGift(uniqueId, nickname, giftName, value);
    }
    broadcastRanking();
  });

  client.connect().then(() => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME}`);
    liveOnline = true;
    broadcastLiveStatus();
  }).catch(err => {
    console.error('Erro ao conectar na live:', err?.message || err);
    console.log('Tentando novamente em 10s...');
    setTimeout(startTikTokConnection, 10000);
  });
}

app.post('/api/reset', (req, res) => {
  db.resetAll();
  Object.keys(lastLikeTotal).forEach(k => delete lastLikeTotal[k]);
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