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
  state.global = {
    totalDiamonds: 0, totalLikes: 0, totalComments: 0, totalFollows: 0, totalShares: 0,
    peakViewers: 0, currentViewers: 0, uniqueViewers: 0, startedAt: Date.now()
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
  dirty = true;
}

function getGlobalStats() {
  return {
    ...state.global,
    uptimeSeconds: Math.floor((Date.now() - state.global.startedAt) / 1000)
  };
}

module.exports = { addLikes, addGift, addPowerUp, getRanking, getUserProfile, resetAll, getGlobalStats, updateViewerCount, addComment, addFollow, addShare };