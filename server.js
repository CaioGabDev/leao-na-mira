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

function broadcastLiveStatus() {
  io.emit('live_status', { online: liveOnline });
}

// Lista de nomes de presentes que você considera "Power-Up" (nomes em inglês, ex: "Rose", "Rocket", "Universe")
const POWERUP_GIFTS = ['GG', 'Rocket', 'Universe']; // ajuste com os nomes reais que aparecerem

function broadcastRanking() {
  io.emit('ranking', db.getRanking());
}

function startTikTokConnection() {
  const connection = new ConnectionClass(TIKTOK_USERNAME, {});

  connection.connect().then(state => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME} (roomId ${state.roomId})`);
    liveOnline = true;
    broadcastLiveStatus();
  }).catch(err => {
    console.error('Erro ao conectar na live:', err?.message || err, err?.response?.data || '');
    console.log('Tentando novamente em 10s...');
    setTimeout(startTikTokConnection, 10000);
  });

  // ADICIONA ESSE BLOCO AQUI (logo depois do .catch acima, antes do connection.on('like', ...))
  connection.on('error', err => {
    console.error('Erro do connection (evento error):', err?.message || err);
  });

  connection.on('like', data => {
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const count = data.count || data.likeCount || 1;
    db.addLikes(uniqueId, nickname, count);
    broadcastRanking();
  });

  connection.on('gift', data => {
    // Presentes em combo (type 1) só devem ser contados quando o combo termina
    if (data.gift?.type === 1 && !data.repeatEnd) return;

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  startTikTokConnection();
});