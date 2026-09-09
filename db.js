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
state.battles = state.battles || [];   // batalhas (PK) já encerradas
state.currentBattle = state.currentBattle || null; // batalha rolando agora

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

// A lib do TikTok pode devolver, pro mesmo tipo de badge, mais de um objeto:
// um só com a imagem do selo (sem level) e outro com o level de verdade. Um
// .find() simples podia cair no objeto sem level e achar que a pessoa não tinha
// nível nenhum — por isso aqui só vale badge que TEM level.
//
// Os nomes dos campos mudaram da v1 pra v2 da lib (badgeSceneType -> sceneType,
// e o level saiu pra dentro de privilegeLogExtra, como string). Lemos os dois
// formatos pra não depender da versão.
function badgeSceneOf(b) {
  return b.sceneType ?? b.badgeSceneType;
}

function badgeLevelOf(b) {
  const bruto = b.level ?? b.privilegeLogExtra?.level;
  const nivel = Number(bruto);
  return Number.isFinite(nivel) && nivel > 0 ? nivel : null;
}

function getBadgeLevel(badges, sceneType) {
  if (!Array.isArray(badges)) return null;
  // pega o MAIOR level encontrado pra aquela cena (badges repetidos acontecem)
  return badges.reduce((maior, b) => {
    if (badgeSceneOf(b) !== sceneType) return maior;
    const nivel = badgeLevelOf(b);
    return nivel != null && nivel > (maior || 0) ? nivel : maior;
  }, null);
}

function checkLevelUp(uniqueId, nickname, avatar, badges, user) {
  ensureUser(uniqueId, nickname, avatar);
  const u = state.users[uniqueId];
  const resultados = [];

  // payGrade/fansClub são o mesmo nível vindo por outro caminho: em muitos
  // eventos o badge não vem, mas esses campos vêm. Ficamos com o maior.
  const gradeDireto = Number(user?.payGrade?.level) || 0;
  const fansDireto = Number(
    user?.fansClub?.data?.level ?? user?.fansClubInfo?.fansLevel
  ) || 0;

  const presenteador = Math.max(getBadgeLevel(badges, 8) || 0, gradeDireto) || null;
  const membro = Math.max(getBadgeLevel(badges, 10) || 0, fansDireto) || null;

  // Primeira vez que conseguimos ler um nível dessa pessoa: só anotamos o ponto
  // de partida, sem anunciar. Sem isso, quem já era nível 17 há meses entraria
  // no mural como se tivesse acabado de subir — e sairia de novo num print em
  // que já apareceu. Da segunda leitura em diante, subida é subida.
  //
  // A marca é POR CATEGORIA: muita gente aparece primeiro só com o selo de
  // presenteador, e a primeira leitura do selo de membro (que pode vir lives
  // depois) também não pode contar como subida.
  const anotar = (nivel, tipo, campoNivel, campoLido) => {
    if (!nivel) return; // esse selo não veio nesse evento: não aprendemos nada
    const primeiraLeitura = !u[campoLido];
    u[campoLido] = true;
    if (nivel <= u[campoNivel]) return;
    u[campoNivel] = nivel;
    if (nivel < 10 || primeiraLeitura) return;
    const item = addToTropa(nickname, nivel, tipo, avatar);
    if (item) resultados.push(item);
  };

  anotar(presenteador, 'presenteador', 'gifterLevel', 'gifterLido');
  anotar(membro, 'membro', 'memberLevel', 'memberLido');

  dirty = true;
  return resultados;
}

function getTropa() {
  return state.tropa;
}

// Zera só o mural (pro print da semana começar limpo). Ranking, likes,
// presentes e os níveis já aprendidos continuam intactos — o que importa é
// não repetir no print quem já saiu.
function limparTropa() {
  state.tropa = [];
  dirty = true;
  saveToDisk();
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
  // 200 em vez de 100 porque agora comentários entram um por linha e não
  // podem empurrar os presentes/likes pra fora do histórico.
  const history = state.actions
    .filter(a => a.uniqueId === uniqueId)
    .sort((a, b) => (b.timestamp - a.timestamp) || ((b.seq || 0) - (a.seq || 0)))
    .slice(0, 200);
  return { user, history };
}

function resetAll() {
  state.users = {};
  state.actions = [];
  state.tropa = [];
  state.sessions = [];
  state.battles = [];
  state.currentBattle = null;
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
  Object.keys(commentActionRefs).forEach(k => delete commentActionRefs[k]);
  dirty = true;
  saveToDisk();
}

// Comentários: além de contar, guardamos o texto pra poder mostrar no perfil.
// Diferente de like/presente, cada comentário é uma linha própria (o texto muda
// toda vez), então limitamos quantos ficam guardados por pessoa.
const MAX_COMMENTS_PER_USER = 50;

function addComment(uniqueId, nickname, avatar, text) {
  ensureUser(uniqueId, nickname, avatar);
  state.users[uniqueId].comments += 1;
  state.global.totalComments += 1;
  logCommentAction(uniqueId, nickname, text);
  dirty = true;
}

// Fila dos comentários guardados de cada pessoa (mais antigo primeiro), pra não
// precisar varrer state.actions inteiro a cada comentário que chega.
const commentActionRefs = {}; // uniqueId -> [action, ...]

// Vários comentários caem no mesmo milissegundo numa live movimentada, então
// timestamp sozinho não ordena. seq é o desempate (sempre crescente).
let nextSeq = state.actions.reduce((max, a) => Math.max(max, a.seq || 0), 0) + 1;

function commentQueue(uniqueId) {
  if (!commentActionRefs[uniqueId]) {
    // primeira vez no processo: remonta a fila do que veio do live.json
    commentActionRefs[uniqueId] = state.actions.filter(
      a => a.type === 'comment' && a.uniqueId === uniqueId
    );
  }
  return commentActionRefs[uniqueId];
}

function logCommentAction(uniqueId, nickname, text) {
  const detail = (text || '').trim();
  if (!detail) return; // reação/figurinha sem texto: só entra na contagem

  // A fila tem que ser montada ANTES do push: depois do reinício ela é
  // remontada a partir de state.actions, e o comentário novo entraria
  // duas vezes (derrubando um antigo a mais do que devia).
  const fila = commentQueue(uniqueId);

  const action = {
    uniqueId, nickname, type: 'comment', detail,
    value: 0, count: 1, timestamp: Date.now(), seq: nextSeq++
  };
  state.actions.push(action);

  // Janela deslizante: entra o novo, sai o mais antigo. A contagem em
  // users[].comments e o total global NÃO são tocados — só o texto guardado
  // é descartado, pra não encher o live.json de linha.
  fila.push(action);
  while (fila.length > MAX_COMMENTS_PER_USER) {
    const antigo = fila.shift();
    const i = state.actions.indexOf(antigo);
    if (i !== -1) state.actions.splice(i, 1);
  }
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
// Batida de coração enquanto a live está no ar. Serve pra saber, depois de um
// restart do servidor, se a live que estava rodando é a MESMA (retoma a
// contagem) ou se já é outra (começa do zero).
const RETOMAR_SESSAO_MS = 3 * 60 * 1000;

function heartbeat() {
  if (!state.global.liveActive) return;
  state.global.lastActivityAt = Date.now();
  dirty = true;
}

function markLiveOnline() {
  const now = Date.now();

  // Um deploy/restart no meio da live derrubava startedAt pro instante da
  // reconexão e a duração voltava do zero. Se a live estava no ar e a última
  // batida foi agora há pouco, é a mesma live: mantém o relógio andando.
  const mesmaLive =
    state.global.liveActive &&
    state.currentSessionSnapshot &&
    now - (state.global.lastActivityAt || 0) < RETOMAR_SESSAO_MS;

  state.global.liveActive = true;
  state.global.lastActivityAt = now;

  if (mesmaLive) {
    state.global.startedAt = state.currentSessionSnapshot.startedAt;
    dirty = true;
    return;
  }

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

// ---------- BATALHAS (PK / link mic) ----------
const MAX_BATALHAS = 500;

function iniciarBatalha(battleId, oponente) {
  // o TikTok repete o evento de abertura; não recomeça a mesma batalha
  if (state.currentBattle && state.currentBattle.battleId === battleId) {
    return state.currentBattle;
  }
  state.currentBattle = {
    battleId,
    startedAt: Date.now(),
    oponente, // { uniqueId, nickname, avatar }
    meuScore: 0,
    scoreOponente: 0
  };
  dirty = true;
  return state.currentBattle;
}

function atualizarPlacarBatalha(battleId, meuScore, scoreOponente) {
  const b = state.currentBattle;
  if (!b) return null;
  if (battleId && b.battleId !== battleId) return null;
  b.meuScore = meuScore;
  b.scoreOponente = scoreOponente;
  dirty = true;
  return b;
}

function finalizarBatalha(battleId, dados = {}) {
  const b = state.currentBattle;
  if (!b) return null;
  if (battleId && b.battleId !== battleId) return null;

  // o evento de fim costuma chegar mais de uma vez
  if (state.battles.some(x => x.battleId === b.battleId)) {
    state.currentBattle = null;
    dirty = true;
    return null;
  }

  const meuScore = dados.meuScore ?? b.meuScore;
  const scoreOponente = dados.scoreOponente ?? b.scoreOponente;
  const resultado = dados.resultado
    || (meuScore > scoreOponente ? 'vitoria'
      : meuScore < scoreOponente ? 'derrota' : 'empate');

  const registro = {
    battleId: b.battleId,
    startedAt: b.startedAt,
    endedAt: Date.now(),
    duracaoSegundos: Math.max(0, Math.round((Date.now() - b.startedAt) / 1000)),
    oponente: b.oponente,
    meuScore,
    scoreOponente,
    resultado
  };

  state.battles.push(registro);
  if (state.battles.length > MAX_BATALHAS) state.battles.shift();
  state.currentBattle = null;
  dirty = true;
  saveToDisk();
  return registro;
}

// Se a live cair no meio da batalha, não deixa uma batalha fantasma pendurada.
function cancelarBatalhaEmAndamento() {
  if (!state.currentBattle) return;
  state.currentBattle = null;
  dirty = true;
}

function getBattleStats() {
  const batalhas = state.battles;
  const conta = r => batalhas.filter(b => b.resultado === r).length;
  const vitorias = conta('vitoria');
  const derrotas = conta('derrota');
  const empates = conta('empate');

  // agrupa por adversário
  const porRival = {};
  batalhas.forEach(b => {
    const id = b.oponente?.uniqueId || b.oponente?.nickname || '?';
    if (!porRival[id]) {
      porRival[id] = {
        uniqueId: id,
        nickname: b.oponente?.nickname || id,
        avatar: b.oponente?.avatar || null,
        batalhas: 0, vitorias: 0, derrotas: 0, empates: 0,
        diamantesFeitos: 0, diamantesTomados: 0,
        ultimaEm: 0
      };
    }
    const r = porRival[id];
    r.batalhas += 1;
    if (b.resultado === 'vitoria') r.vitorias += 1;
    else if (b.resultado === 'derrota') r.derrotas += 1;
    else r.empates += 1;
    r.diamantesFeitos += b.meuScore || 0;
    r.diamantesTomados += b.scoreOponente || 0;
    if (b.endedAt > r.ultimaEm) r.ultimaEm = b.endedAt;
    if (b.oponente?.avatar) r.avatar = b.oponente.avatar;
    if (b.oponente?.nickname) r.nickname = b.oponente.nickname;
  });

  const rivais = Object.values(porRival)
    .sort((a, b) => b.batalhas - a.batalhas || b.vitorias - a.vitorias);

  return {
    total: batalhas.length,
    vitorias,
    derrotas,
    empates,
    // % só faz sentido sobre batalhas decididas
    aproveitamento: (vitorias + derrotas)
      ? Math.round((vitorias / (vitorias + derrotas)) * 100)
      : 0,
    rivais,
    maisEnfrentado: rivais[0] || null,
    maisVencido: [...rivais].sort((a, b) => b.vitorias - a.vitorias)[0] || null,
    carrasco: [...rivais].sort((a, b) => b.derrotas - a.derrotas)[0] || null,
    ultimas: [...batalhas].sort((a, b) => b.endedAt - a.endedAt).slice(0, 30),
    emAndamento: state.currentBattle
  };
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
  markLiveOnline, markLiveOffline, checkLevelUp, getTropa, limparTropa, getSessions,
  heartbeat,
  iniciarBatalha, atualizarPlacarBatalha, finalizarBatalha,
  cancelarBatalhaEmAndamento, getBattleStats
};