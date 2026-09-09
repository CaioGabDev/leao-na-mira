const fs = require('fs');
const FILE = process.env.RAILWAY_ENVIRONMENT ? '/data/live.json' : 'live.json';

// Tudo fica em memória (rápido, sem travar em picos de taps).
// O disco só é atualizado periodicamente (ver saveToDisk).
let state = { users: {}, actions: [] };


if (fs.existsSync(FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    state.users = state.users || {};
    state.actions = state.actions || [];
  } catch (e) {
    console.error('Erro ao ler live.json, começando do zero:', e.message);
  }
}
state.tropa = state.tropa || [];
state.sessions = state.sessions || []; // histórico de lives já finalizadas

state.global = state.global || {
  totalDiamonds: 0,
  totalLikes: 0,
  totalComments: 0,
  totalFollows: 0,
  totalShares: 0,
  peakViewers: 0,
  currentViewers: 0,
  uniqueViewers: 0,
  startedAt: Date.now()
};
// campos novos, com default pra não quebrar live.json antigo
state.global.lastLiveDurationSeconds = state.global.lastLiveDurationSeconds || 0;
state.global.sessionPeakViewers = state.global.sessionPeakViewers || 0;
state.currentSessionSnapshot = state.currentSessionSnapshot || null;

let dirty = false;

function saveToDisk() {
  if (!dirty) return;
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  dirty = false;
}
setInterval(saveToDisk, 5000);
process.on('SIGINT', () => { saveToDisk(); process.exit(); });
process.on('exit', saveToDisk);

function ensureUser(uniqueId, nickname, avatar) {
  if (!state.users[uniqueId]) {
    state.users[uniqueId] = {
      uniqueId, nickname, avatar: avatar || null,
      likes: 0, gifts_count: 0, gifts_value: 0, powerups: {},
      comments: 0, followed: false, shared: false,
      gifterLevel: 0, memberLevel: 0,
      firstSeenAt: Date.now()

    };
    state.global.uniqueViewers += 1;
  } else {
    state.users[uniqueId].nickname = nickname;
    if (avatar) state.users[uniqueId].avatar = avatar;
  }
}

// Likes: mantém UM único registro por usuário durante toda a live, apenas somando nele
const pendingLikes = {};
const likeActionRef = {};

function addLikes(uniqueId, nickname, count, avatar) {
  ensureUser(uniqueId, nickname, avatar);
  state.users[uniqueId].likes += count;
  state.global.totalLikes += count; // NOVO
  dirty = true;
  if (!pendingLikes[uniqueId]) pendingLikes[uniqueId] = { nickname, count: 0 };
  pendingLikes[uniqueId].nickname = nickname;
  pendingLikes[uniqueId].count += count;
}

function addToTropa(nome, nivel, tipo, avatar) {
  const existente = state.tropa.find(p =>
    p.nome.toLowerCase() === nome.toLowerCase() && p.tipo === tipo
  );
  if (existente) {
    if (nivel <= existente.nivel) return null; // nada novo, ignora
    existente.nivel = nivel;
    existente.avatar = avatar || existente.avatar;
    dirty = true;
    return existente;
  }
  const novo = { id: Date.now() + Math.random(), nome, nivel, tipo, avatar: avatar || null };
  state.tropa.push(novo);
  dirty = true;
  return novo;
}

// A lib do TikTok pode devolver, pro mesmo badgeSceneType, mais de um objeto:
// um só com a imagem do selo (sem "level") e outro com o level de verdade
// (vindo de privilegeLogExtra). Um .find() simples podia cair no objeto sem
// "level" e achar que a pessoa não tinha nível nenhum, mesmo tendo — por isso
// aqui procuramos especificamente pelo badge que TEM level definido.
function getBadgeLevel(badges, sceneType) {
  return badges?.find(b => b.badgeSceneType === sceneType && b.level != null)?.level;
}

function checkLevelUp(uniqueId, nickname, avatar, badges) {
  ensureUser(uniqueId, nickname, avatar);
  const u = state.users[uniqueId];
  const resultados = [];

  const presenteador = getBadgeLevel(badges, 8);
  const membro = getBadgeLevel(badges, 10);

  if (presenteador && presenteador > u.gifterLevel) {
    u.gifterLevel = presenteador;
    if (presenteador >= 10) {
      const item = addToTropa(nickname, presenteador, 'presenteador', avatar);
      if (item) resultados.push(item);
    }
  }
  if (membro && membro > u.memberLevel) {
    u.memberLevel = membro;
    if (membro >= 10) {
      const item = addToTropa(nickname, membro, 'membro', avatar);
      if (item) resultados.push(item);
    }
  }

  dirty = true;
  return resultados;
}

function getTropa() {
  return state.tropa;
}

function flushLikeBuffer() {
  const entries = Object.entries(pendingLikes);
  if (!entries.length) return;
  entries.forEach(([uniqueId, { nickname, count }]) => {
    let action = likeActionRef[uniqueId];
    if (!action) {
      action = { uniqueId, nickname, type: 'like', detail: null, value: 0, count: 0, timestamp: Date.now() };
      state.actions.push(action);
      likeActionRef[uniqueId] = action;
    }
    action.value += count;
    action.nickname = nickname;
    action.timestamp = Date.now();
    dirty = true;
    delete pendingLikes[uniqueId];
  });
}
setInterval(flushLikeBuffer, 10000);

// Presentes: UM registro por usuário + nome do presente (em vez de 1 linha por envio).
// Ex: se "Rose" for enviada 50 vezes pela mesma pessoa, vira 1 linha só com count:50 e value somado.
const giftActionRef = {}; // chave: `${uniqueId}::${giftName}`

function addGift(uniqueId, nickname, giftName, value, avatar) {
  ensureUser(uniqueId, nickname, avatar);
  state.users[uniqueId].gifts_count += 1;
  state.users[uniqueId].gifts_value += value;
  state.global.totalDiamonds += value; // NOVO
  dirty = true;
  logGiftAction(uniqueId, nickname, giftName, value);
}

function logGiftAction(uniqueId, nickname, giftName, value) {
  const key = `${uniqueId}::${giftName}`;
  let action = giftActionRef[key];
  if (!action) {
    action = {
      uniqueId, nickname, type: 'gift', detail: giftName,
      value: 0, count: 0, timestamp: Date.now()
    };
    state.actions.push(action);
    giftActionRef[key] = action;
  }
  action.value += value;
  action.count += 1;
  action.nickname = nickname;
  action.timestamp = Date.now();
  dirty = true;
}

function addPowerUp(uniqueId, nickname, name, avatar) {
  ensureUser(uniqueId, nickname, avatar);
  const powerups = state.users[uniqueId].powerups;
  powerups[name] = (powerups[name] || 0) + 1;
  dirty = true;
  logPowerUpAction(uniqueId, nickname, name);
}

// Power-ups: mesma ideia, um registro por usuário + tipo de power-up
const powerUpActionRef = {}; // chave: `${uniqueId}::${name}`

function logPowerUpAction(uniqueId, nickname, name) {
  const key = `${uniqueId}::${name}`;
  let action = powerUpActionRef[key];
  if (!action) {
    action = {
      uniqueId, nickname, type: 'powerup', detail: name,
      value: 0, count: 0, timestamp: Date.now()
    };
    state.actions.push(action);
    powerUpActionRef[key] = action;
  }
  action.count += 1;
  action.value = action.count; // valor = quantidade de vezes
  action.nickname = nickname;
  action.timestamp = Date.now();
  dirty = true;
}

const MAX_ACTIONS = 5000; // limite de segurança: nunca deixa o histórico crescer sem fim
// (com a consolidação acima, cada usuário só ocupa 1 linha por like + 1 por tipo de presente/power-up,
// então isso raramente vai bater nesse teto mesmo em lives longas)

function getRanking() {
  return Object.values(state.users)
    .map(u => ({ ...u, score: u.likes + u.gifts_value * 10 }))
    .sort((a, b) => b.score - a.score);
}

function getUserProfile(uniqueId) {
  const user = state.users[uniqueId];
  const history = state.actions
    .filter(a => a.uniqueId === uniqueId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100);
  return { user, history };
}

function resetAll() {
  state.users = {};
  state.actions = [];
  state.tropa = [];
  state.sessions = [];
  state.currentSessionSnapshot = null;
  state.global = {
    totalDiamonds: 0, totalLikes: 0, totalComments: 0, totalFollows: 0, totalShares: 0,
    peakViewers: 0, currentViewers: 0, uniqueViewers: 0, startedAt: Date.now(),
    lastLiveDurationSeconds: 0, sessionPeakViewers: 0
  };
  Object.keys(pendingLikes).forEach(k => delete pendingLikes[k]);
  Object.keys(likeActionRef).forEach(k => delete likeActionRef[k]);
  Object.keys(giftActionRef).forEach(k => delete giftActionRef[k]);
  Object.keys(powerUpActionRef).forEach(k => delete powerUpActionRef[k]);
  dirty = true;
  saveToDisk();
}

function addComment(uniqueId, nickname, avatar) {
  ensureUser(uniqueId, nickname, avatar);
  state.users[uniqueId].comments += 1;
  state.global.totalComments += 1;
  dirty = true;
}

function addFollow(uniqueId, nickname, avatar) {
  ensureUser(uniqueId, nickname, avatar);
  if (!state.users[uniqueId].followed) {
    state.users[uniqueId].followed = true;
    state.global.totalFollows += 1;
    dirty = true;
  }
}

function addShare(uniqueId, nickname, avatar) {
  ensureUser(uniqueId, nickname, avatar);
  if (!state.users[uniqueId].shared) {
    state.users[uniqueId].shared = true;
    state.global.totalShares += 1;
    dirty = true;
  }
}

function updateViewerCount(count) {
  state.global.currentViewers = count;
  if (count > state.global.peakViewers) state.global.peakViewers = count;
  if (count > (state.global.sessionPeakViewers || 0)) state.global.sessionPeakViewers = count;
  dirty = true;
}

// Chamado quando a conexão com a live é estabelecida (live entrou no ar).
// Tira uma "foto" dos totais atuais pra depois calcular só o que essa live
// específica gerou (delta), e zera o pico de espectadores dessa sessão.
function markLiveOnline() {
  const now = Date.now();
  state.global.liveActive = true;
  state.global.startedAt = now;
  state.global.sessionPeakViewers = 0;

  state.currentSessionSnapshot = {
    startedAt: now,
    totalDiamonds: state.global.totalDiamonds,
    totalLikes: state.global.totalLikes,
    totalComments: state.global.totalComments,
    totalFollows: state.global.totalFollows,
    totalShares: state.global.totalShares
  };
  dirty = true;
}

// Chamado quando a live cai/termina. Calcula os números só dessa live
// (delta contra o snapshot tirado no markLiveOnline) e guarda no histórico.
// O uptime não zera: fica congelado na duração dessa live até a próxima começar.
function markLiveOffline() {
  if (state.global.liveActive && state.currentSessionSnapshot) {
    const snap = state.currentSessionSnapshot;
    const endedAt = Date.now();
    const durationSeconds = Math.floor((endedAt - snap.startedAt) / 1000);

    // só registra no histórico lives com alguma duração mínima (evita "lixo"
    // de reconexões picadas de poucos segundos)
    if (durationSeconds >= 10) {
      state.sessions.push({
        id: snap.startedAt,
        startedAt: snap.startedAt,
        endedAt,
        durationSeconds,
        totalDiamonds: state.global.totalDiamonds - snap.totalDiamonds,
        totalLikes: state.global.totalLikes - snap.totalLikes,
        totalComments: state.global.totalComments - snap.totalComments,
        totalFollows: state.global.totalFollows - snap.totalFollows,
        totalShares: state.global.totalShares - snap.totalShares,
        peakViewers: state.global.sessionPeakViewers || 0
      });
      if (state.sessions.length > 200) state.sessions.shift(); // limite de segurança
      state.global.lastLiveDurationSeconds = durationSeconds;
    }
  }
  state.global.liveActive = false;
  state.currentSessionSnapshot = null;
  dirty = true;
}

function getGlobalStats() {
  const uptimeSeconds = state.global.liveActive
    ? Math.floor((Date.now() - state.global.startedAt) / 1000)
    : (state.global.lastLiveDurationSeconds || 0);
  return { ...state.global, uptimeSeconds };
}

// Histórico de lives já finalizadas (mais recente primeiro), até o último reset.
function getSessions() {
  return [...state.sessions].sort((a, b) => b.startedAt - a.startedAt);
}

module.exports = {
  addLikes, addGift, addPowerUp, getRanking, getUserProfile, resetAll,
  getGlobalStats, updateViewerCount, addComment, addFollow, addShare,
  markLiveOnline, markLiveOffline, checkLevelUp, getTropa, getSessions
};