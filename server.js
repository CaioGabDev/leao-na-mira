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
  const ok = db.definirItensDaPremiacao(uniqueId, ganhaEm, itens || {});
  if (!ok) return res.status(404).json({ error: 'Premiação não encontrada.' });

  broadcastPowerUps();
  res.json({ ok: true });
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

// ---------- POWER-UPS DO PK ----------
// O evento `linkMicBattleItemCard` usa msgType pra dizer o que aconteceu. Só um
// dos campos irmãos vem preenchido, e é o msgType que diz qual ler.
const PK_MSG_GANHOU = 4; // AWARD_CARD_NOTICE
const PK_CARTA_POR_MSGTYPE = {
  // Dado real: msgType 2 chega com o texto "sent 1 boosting glove" — é a LUVA
  // que a tropa usa. "critical strike" é o efeito interno dela, não o nome.
  2:  { campo: 'useCriticalStrikeCard', tipo: 'luva'    },
  3:  { campo: 'useSmokeCard',          tipo: 'nevoa'   },
  5:  { campo: 'useExtraTimeCard',      tipo: 'tempo'   },
  6:  { campo: 'useSpecialEffectCard',  tipo: 'efeito'  },
  7:  { campo: 'usePotionCard',         tipo: 'pocao'   },
  8:  { campo: 'useWaveCard',           tipo: 'onda'    },
  10: { campo: 'useTop2Card',           tipo: 'booster2'},
  11: { campo: 'useTop3Card',           tipo: 'booster3'},
  // "vault glove" é outra carta, não a luva do dia a dia — id separado pra não
  // misturar as duas no estoque caso apareça.
  12: { campo: 'useVaultGloveCard',     tipo: 'luva_cofre' }
};

// ---------- DESCOBRIR QUAL CARTA FOI GANHA ----------
// No evento de "ganhou" (msgType 4) o protocolo NÃO tem campo de tipo de carta:
// só `awardedUsers[]` e `displayContent`, que é o texto localizado que o app do
// TikTok renderiza na tela ("X ganhou uma Luva"). Ou seja: a informação existe,
// só não vem estruturada. Então a gente procura, em ordem de confiabilidade:
//   1. algum campo use*Card que tenha vindo preenchido junto (traz cardNameKey)
//   2. displayContent.key            (chave de i18n, não muda com o idioma)
//   3. defaultPattern / pieces       (texto em inglês, último recurso)
// Vocabulário montado a partir de mensagens REAIS de live. Aprendizado
// importante: o msgType é um balde grosso (msgType 6 = "special effect" cobre
// martelo, raio, heart-me...) e o cardNameKey vem genérico ("pm_mt_boost_effect").
// Quem diz a carta de verdade é o displayContent: "{0:user} sent 1 stun hammer".
// Por isso a ordem embaixo importa: o específico antes do genérico.
// Vocabulário montado a partir de mensagens REAIS de live. Três aprendizados
// que só apareceram com dado de verdade:
//
//  1. O msgType é um balde grosso: msgType 6 ("special effect") cobre martelo,
//     coração e provavelmente mais. Quem diz a carta é o displayContent
//     ("{0:user} sent 1 stun hammer").
//  2. O cardNameKey às vezes é genérico ("pm_mt_boost_effect") e às vezes é
//     específico ("ttlive_match_gotPowerUp_panel_no2_title"). Serve como 2ª
//     opinião, nunca como 1ª.
//  3. A imagem MENTE: a mensagem do martelo veio com card_effect_heartme_v4.png.
//     Não usar a imagem pra decidir nada.
//
// Os nomes do TikTok não batem com os da tropa: o que a gente chama de "raio"
// o TikTok chama de "no. 2 booster" (carta top2). Os ids aqui seguem o TikTok
// pra casar com o protocolo; a tradução pro nome da tropa fica no front.
const PALAVRAS_DA_CARTA = [
  // específicos primeiro
  [/stun.?hammer|hammer|martelo/i,          'martelo'  ],
  [/no[\s._-]*2(?!\d)|top.?2/i,             'booster2' ], // "no. 2 booster" = raio
  [/no[\s._-]*3(?!\d)|top.?3/i,             'booster3' ],
  [/glove|luva/i,                           'luva'     ],
  [/smoke|fog|n[eé]voa|nevoa/i,             'nevoa'    ],
  [/extra.?time|timer|tempo/i,              'tempo'    ],
  [/critical|cr[ií]tico|critico/i,          'critico'  ],
  [/potion|po[cç][aã]o|pocao/i,             'pocao'    ],
  [/wave|onda/i,                            'onda'     ],
  [/heart.?me|cora[cç][aã]o/i,              'coracao'  ],
  // genérico: só cai aqui se nada acima casou
  [/special.?effect|boost.?effect|efeito/i, 'efeito'   ]
];

// O texto da carta traz a quantidade ("{0:user} sent 1 boosting glove").
// Se vier 2, são duas cartas — não uma.
function quantidadeDoTexto(texto) {
  const m = /\bsent\s+(\d{1,2})\b/i.exec(String(texto || ''));
  const n = m ? parseInt(m[1], 10) : 1;
  return n >= 1 && n <= 50 ? n : 1;   // teto de sanidade
}

// O nome do arquivo de imagem da carta também identifica o item. Estas
// assinaturas saíram de mensagens reais:
//   card_crit_v3        -> "boosting glove" (a luva da tropa)
//   top2_buffer         -> "no. 2 booster"  (o raio)
//   card_effect_heartme -> heart me
// Atenção: na MENSAGEM DE USO a imagem já veio errada uma vez (o martelo
// chegou com a imagem do heartme). Por isso imagem é sempre a ÚLTIMA opção,
// depois do texto.
const IMAGEM_DA_CARTA = [
  [/card_crit/i,          'luva'     ],
  [/top2_buffer|top_?2/i, 'booster2' ],
  [/top3_buffer|top_?3/i, 'booster3' ],
  [/hammer/i,             'martelo'  ],
  [/heart_?me/i,          'coracao'  ],
  [/smoke|fog/i,          'nevoa'    ],
  [/extra_?time|timer/i,  'tempo'    ],
  [/potion/i,             'pocao'    ],
  [/wave/i,               'onda'     ]
];

function tipoPelaImagem(uri) {
  if (!uri) return null;
  for (const [padrao, tipo] of IMAGEM_DA_CARTA) {
    if (padrao.test(uri)) return tipo;
  }
  return null;
}

function tipoPelasPalavras(texto) {
  if (!texto) return null;
  for (const [padrao, tipo] of PALAVRAS_DA_CARTA) {
    if (padrao.test(texto)) return tipo;
  }
  return null;
}

// Junta tudo que é texto dentro de um Text do protocolo (key, pattern e pedaços).
function textosDoDisplayContent(dc) {
  if (!dc) return '';
  const partes = [dc.key, dc.defaultPattern];
  (dc.pieces || []).forEach(pedaco => {
    partes.push(pedaco?.stringValue, pedaco?.patternRefValue?.key, pedaco?.patternRefValue?.defaultPattern);
  });
  return partes.filter(Boolean).join(' | ');
}

// A carta USADA: o displayContent do próprio use*Card traz o nome específico
// ("sent 1 stun hammer"); o msgType só entra como reserva.
function descobrirCartaUsada(data, mapa) {
  const carta = data?.[mapa.campo];
  const info = carta?.cardInfo;
  return tipoPelasPalavras(textosDoDisplayContent(carta?.displayContent))
      || tipoPelasPalavras(info?.common?.cardNameKey || info?.cardNameKey)
      || mapa.tipo;
}

function descobrirCartaGanha(data) {
  // 1) algum use*Card veio preenchido de carona? aí o cardNameKey resolve
  for (const { campo, tipo } of Object.values(PK_CARTA_POR_MSGTYPE)) {
    const info = data?.[campo]?.cardInfo;
    if (!info) continue;
    const chave = info.common?.cardNameKey || info.cardNameKey;
    return tipoPelasPalavras(chave) || tipo;
  }
  // 2) e 3) a chave de i18n e depois o texto
  const dc = data?.awardCardNotice?.displayContent;
  return tipoPelasPalavras(dc?.key) || tipoPelasPalavras(textosDoDisplayContent(dc));
}

// ---------- O ITEM DE CADA PREMIADO ----------
// O texto geral do prêmio vem genérico ("Contributors got match power-ups"),
// mas cada premiado carrega `tags[]`, que é o selo que o TikTok desenha ao lado
// do nome dele — com `content` (texto) e `iconImage` (o ícone da carta).
// É daí que sai o item de cada um, individualmente. Se a tag não disser nada,
// cai pro que a mensagem inteira sugerir; se nem isso, fica pendente.
function descobrirCartaDoPremiado(bu, data) {
  const tags = bu?.tags || [];

  // 1) o texto da tag
  for (const tg of tags) {
    const achou = tipoPelasPalavras(tg?.content);
    if (achou) return achou;
  }
  // 2) o ícone da tag
  for (const tg of tags) {
    const achou = tipoPelaImagem(tg?.iconImage?.uri || tg?.iconImage?.urlList?.[0]);
    if (achou) return achou;
  }
  // 3) a mensagem como um todo
  return descobrirCartaGanha(data);
}

// A tag pode trazer quantidade ("x2", "×2", "2x"). Retorna null quando não diz,
// pra quem chamou usar a quantidade do texto da mensagem.
function quantidadeDoPremiado(bu) {
  for (const tg of (bu?.tags || [])) {
    const m = /[x×]\s*(\d{1,2})|(\d{1,2})\s*[x×]/i.exec(String(tg?.content || ''));
    if (m) {
      const n = parseInt(m[1] || m[2], 10);
      if (n >= 1 && n <= 50) return n;
    }
  }
  return null;
}

// Luva/Top2/Top3 aninham o sendUser dentro de cardInfo.common; névoa, tempo e
// os outros põem direto em cardInfo.sendUser. Essa diferença é do protocolo.
function usuarioDaCarta(carta) {
  const info = carta?.cardInfo;
  return info?.common?.sendUser?.user || info?.sendUser?.user || null;
}

// A chave aqui é o userId NUMÉRICO, de propósito — e isso é diferente do resto
// do app, que usa o displayId (o @). O motivo: nas mensagens de carta do PK o
// displayId pode vir vazio, e aí a mesma pessoa apareceria duas vezes na aba
// (uma linha com @ e outra com o id). O userId vem sempre nesses eventos.
// O `handle` fica guardado do lado pra, no dia que der, cruzar com o ranking
// (que é indexado por @ — ver o comentário em processarBadges).
function dadosDoUsuarioPK(u) {
  if (!u) return null;
  const uniqueId = u.userId || u.displayId;
  if (!uniqueId) return null;
  return {
    uniqueId,
    handle: u.displayId || null,
    nickname: u.nickName || u.displayId || uniqueId,
    avatar: u.avatarThumb?.urlList?.[0] || null
  };
}

// ---------- DE QUEM É A CARTA ----------
// As mensagens de carta chegam pelos DOIS lados do PK: o suporte do adversário
// também aparece. Contar todo mundo estava errado — o objetivo é saber quem da
// NOSSA live tem carta pra jogar.
//
// Pro USO é direto: a carta diz o anfitrião beneficiado (anchorId/toAnchorId),
// então basta comparar com o meuUserId.
//
// Pro PRÊMIO não tem campo de lado nenhum ("Contributors got match power-ups").
// A saída é o linkMicArmies, que traz os contribuidores INDEXADOS POR ANFITRIÃO
// — daí sai a lista de quem é do nosso lado.
let meusContribuintes = new Set();
let batalhaDosContribuintes = null;

function anfitriaoBeneficiado(carta) {
  const info = carta?.cardInfo;
  return String(
    carta?.anchorId ||
    info?.common?.toAnchorIdStr || info?.common?.toAnchorId ||
    info?.toAnchorIdStr || info?.toAnchorId || ''
  );
}

// Duas travas, porque em live real a primeira pode não vir:
//   1. o anfitrião beneficiado na própria carta (autoritativo quando existe)
//   2. se a carta não disser, olha se quem mandou é contribuinte NOSSO
// Retorna null só quando nenhuma das duas sabe responder.
function ehDoNossoLado(carta) {
  if (!meuUserId) return null;
  const alvo = anfitriaoBeneficiado(carta);
  if (alvo) return alvo === String(meuUserId);

  const quem = usuarioDaCarta(carta);
  const id = String(quem?.userId || quem?.displayId || '');
  if (id && meusContribuintes.size) return meusContribuintes.has(id);

  return null;
}

function broadcastPowerUps() {
  io.emit('powerup_estoque', db.getEstoqueCartas());
}

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

// ---------- BATALHAS (PK / link mic) ----------
// Ações do evento linkMicBattle (enum LinkMicBattleBattleAction da lib)
const BATALHA_ABRIU = 4;      // OPEN
// Tudo que encerra: FINISH, CUT_SHORT, CANCEL e alguém largando o link mic.
// Antes eu só ouvia FINISH e CUT_SHORT — quando o adversário saía do ar a
// batalha ficava aberta pra sempre no painel.
const ACOES_DE_FIM = new Set([5, 6, 3, 11]);
// Resultado por anfitrião (enum BattleResultResult)
const RESULTADO = { 0: 'vitoria', 1: 'derrota', 2: 'empate' };

// Guardamos o id numérico do dono da live assim que ele aparece numa batalha,
// pra reconhecer quem é quem no placar (o linkMicArmies só manda userId).
let meuUserId = null;

// O TikTok manda quando a batalha deve acabar; serve de rede de segurança pra
// fechar a batalha caso o evento de fim nunca chegue.
function fimPrevisto(settings) {
  if (!settings) return null;
  const paraMs = v => {
    const n = Number(v);
    if (!n) return 0;
    return n < 1e12 ? n * 1000 : n; // alguns campos vêm em segundos
  };
  const fim = paraMs(settings.endTimeMs);
  if (fim) return fim;
  const inicio = paraMs(settings.startTimeMs);
  const dur = Number(settings.duration) || 0;
  return inicio && dur ? inicio + dur * 1000 : null;
}

// ---------- DIAGNÓSTICO ----------
// As linhas de decisão de nível e do farejador vão pro log do servidor E pra
// página /diagnostico.html, pra dar pra acompanhar durante a live sem precisar
// abrir o painel do Railway. Guarda as últimas linhas pra quem abrir depois.
const diagnostico = [];
const MAX_DIAGNOSTICO = 400;

function registrarDiagnostico(canal, texto) {
  const linha = { canal, texto, em: Date.now() };
  diagnostico.push(linha);
  if (diagnostico.length > MAX_DIAGNOSTICO) diagnostico.shift();
  io.emit('diagnostico', linha);
}

db.setLogListener(registrarDiagnostico);

function broadcastBattles() {
  io.emit('battle_stats', db.getBattleStats());
}

// anchorsInfo vem como [{ key: userId, value: { user: {...} } }]
function anfitrioesDaBatalha(data) {
  return (data.anchorsInfo || [])
    .map(w => {
      const u = w.value?.user || {};
      return {
        userId: String(w.key || u.userId || ''),
        nickname: u.nickName || u.nickname || null,
        displayId: u.displayId || null,
        avatar: u.avatarThumb?.urlList?.[0] || null
      };
    })
    .filter(a => a.userId);
}

// Batalha de dupla (2v2): o TikTok manda quem é de qual time em teamMember,
// e o placar somado de cada time em teamArmies/teamBattleResult.
// Sem isso, `o primeiro que não é você` podia ser o SEU PARCEIRO — e ele ia
// parar no histórico como adversário, com o placar dele no lugar do inimigo.
function timesDaBatalha(data) {
  return (data.teamMember || [])
    .map(t => ({
      teamId: String(t.teamId || ''),
      membros: (t.userId || []).map(String)
    }))
    .filter(t => t.teamId && t.membros.length);
}

function souEu(anfitriao) {
  if (!anfitriao) return false;
  if (meuUserId && anfitriao.userId === meuUserId) return true;
  return (anfitriao.displayId || '').toLowerCase() === TIKTOK_USERNAME.toLowerCase();
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
  if (!badges) return;

  const subidas = db.checkLevelUp(uniqueId, nickname, avatar, badges);
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
  // batalha interrompida pela queda não vira registro no histórico
  db.cancelarBatalhaEmAndamento();
  broadcastLiveStatus();
  broadcastBattles();
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
    // Sem isso o watchdog só enxergava like e presente: numa live de muita
    // conversa e pouco like ele forçava reconexão a cada 5 min, a sessão era
    // dada como encerrada e a duração voltava do zero no meio da live.
    lastEventAt = Date.now();
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

  // A lib já separa seguir/compartilhar em eventos próprios (ela olha o
  // displayText.key do WebcastSocialMessage) e, quando faz isso, NÃO emite
  // 'social'. O handler antigo só ouvia 'social' e procurava um campo `label`
  // que nem existe mais — por isso "Seguiram" ficava zerado.
  function registrarSocial(data, tipo) {
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();
    // `id` entra na fila porque nem todo evento social traz o @ (displayId);
    // sem nenhum id a pessoa não tem como ser separada das outras.
    const uniqueId = data.user?.displayId || data.user?.uniqueId
      || data.uniqueId || data.user?.id || data.userId;
    const nickname = data.user?.nickname || data.user?.nickName || data.nickname;
    const avatar = getAvatar(data);

    const contou = tipo === 'follow'
      ? db.addFollow(uniqueId, nickname, avatar)
      : db.addShare(uniqueId, nickname, avatar);

    console.log(
      `[${tipo}] ${nickname || '(sem nome)'} id=${uniqueId || 'NENHUM'} ` +
      `${contou ? 'contou' : 'não contou (já tinha ou sem id)'} ` +
      `— total agora: ${tipo === 'follow' ? db.getGlobalStats().totalFollows : db.getGlobalStats().totalShares}`
    );

    broadcastRanking();
    broadcastGlobalStats();
    pushFeed({ type: tipo, uniqueId, nickname, avatar });
  }

  connection.on('follow', data => registrarSocial(data, 'follow'));
  connection.on('share', data => registrarSocial(data, 'share'));

  // Sobra pra versões da lib que mandam tudo junto em 'social'.
  connection.on('social', data => {
    const rotulo = (
      data.label || data.displayType || data.common?.displayText?.key || ''
    ).toLowerCase();
    if (rotulo.includes('follow')) registrarSocial(data, 'follow');
    else if (rotulo.includes('share')) registrarSocial(data, 'share');
  });

  // Abertura da batalha: descobre quem é o adversário.
  connection.on('linkMicBattle', data => {
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();

    const acao = Number(data.action ?? 0);
    const battleId = String(data.battleId || '');
    const anfitrioes = anfitrioesDaBatalha(data);

    const eu = anfitrioes.find(souEu);
    if (eu) meuUserId = eu.userId;

    if (acao === BATALHA_ABRIU) {
      const times = timesDaBatalha(data);
      const nomeDe = a => a.nickname || a.displayId || a.userId;

      // ---- 2v2 (ou mais): decide pelo TIME, não pela ordem da lista ----
      if (times.length >= 2) {
        const meuTime = meuUserId && times.find(t => t.membros.includes(meuUserId));
        const timeRival = meuTime && times.find(t => t.teamId !== meuTime.teamId);
        if (!meuTime || !timeRival) {
          // não deu pra saber quem é de qual lado: melhor não registrar nada
          // do que registrar o parceiro como adversário
          console.log('Batalha em dupla ignorada: não identifiquei os times');
          return;
        }

        const rivais = timeRival.membros
          .map(id => anfitrioes.find(a => a.userId === id))
          .filter(Boolean);
        if (!rivais.length) {
          console.log('Batalha em dupla ignorada: time rival sem nomes');
          return;
        }

        db.iniciarBatalha(battleId, {
          uniqueId: 'dupla:' + timeRival.membros.slice().sort().join('+'),
          nickname: rivais.map(nomeDe).join(' + '),
          avatar: rivais[0].avatar
        }, fimPrevisto(data.battleSettings),
          { meuTimeId: meuTime.teamId, timeRivalId: timeRival.teamId });

        console.log(`Batalha em dupla começou contra ${rivais.map(nomeDe).join(' + ')}`);
        broadcastBattles();
        return;
      }

      // ---- 1v1 ----
      const adversario = anfitrioes.find(a => !souEu(a));
      if (!adversario) return;
      // mais de dois anfitriões sem teamMember: não dá pra dizer quem é inimigo
      if (anfitrioes.length > 2) {
        console.log('Batalha com vários anfitriões e sem times: ignorada');
        return;
      }

      db.iniciarBatalha(battleId, {
        uniqueId: adversario.displayId || adversario.userId,
        nickname: nomeDe(adversario),
        avatar: adversario.avatar
      }, fimPrevisto(data.battleSettings));
      console.log(`Batalha começou contra ${nomeDe(adversario)}`);
      broadcastBattles();
      return;
    }

    if (ACOES_DE_FIM.has(acao)) {
      // CANCEL costuma ser convite abortado antes de valer: se ninguém pontuou,
      // some sem virar registro em vez de gerar um "empate 0 x 0" no histórico
      const emCurso = db.getBattleStats().emAndamento;
      if (acao === 3 && emCurso && !emCurso.meuScore && !emCurso.scoreOponente) {
        db.cancelarBatalhaEmAndamento();
        broadcastBattles();
        return;
      }

      let veredito, meuScore, scoreRival;

      // Em dupla o veredito vem por time, em teamBattleResult.
      if (emCurso?.emDupla && Array.isArray(data.teamBattleResult)) {
        const doTime = id => data.teamBattleResult.find(t => String(t.teamId) === String(id));
        const meu = doTime(emCurso.meuTimeId);
        const rival = doTime(emCurso.timeRivalId);
        if (meu) {
          veredito = RESULTADO[Number(meu.result)];
          meuScore = Number(meu.totalScore) || 0;
        }
        if (rival) scoreRival = Number(rival.totalScore) || 0;
      } else {
        // 1v1: battleResult é um mapa userId -> { result, score }
        const resultados = data.battleResult || {};
        const meu = meuUserId ? resultados[meuUserId] : null;
        const doOutro = Object.entries(resultados)
          .find(([uid]) => uid !== meuUserId)?.[1];
        if (meu) {
          veredito = RESULTADO[Number(meu.result)];
          meuScore = Number(meu.score) || 0;
        }
        if (doOutro) scoreRival = Number(doOutro.score) || 0;
      }

      const registro = db.finalizarBatalha(battleId, {
        // se o TikTok mandou o veredito, ele manda; senão o placar decide
        resultado: veredito,
        meuScore,
        scoreOponente: scoreRival
      });

      if (registro) {
        console.log(`Batalha encerrada: ${registro.resultado} contra ${registro.oponente?.nickname} (${registro.meuScore} x ${registro.scoreOponente})`);
      }
      broadcastBattles();
    }
  });

  // Placar ao vivo durante a batalha.
  connection.on('linkMicArmies', data => {
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();

    const emCurso = db.getBattleStats().emAndamento;
    if (!emCurso) return;
    const battleId = String(data.battleId || '');
    let meuPlacar = null, placarRival = null;

    // Em dupla o que vale é o total do time, não o de cada um.
    if (emCurso.emDupla && Array.isArray(data.teamArmies)) {
      const doTime = id => data.teamArmies.find(t => String(t.teamId) === String(id));
      const meu = doTime(emCurso.meuTimeId);
      const rival = doTime(emCurso.timeRivalId);
      if (!meu || !rival) return;
      meuPlacar = Number(meu.teamTotalScore) || 0;
      placarRival = Number(rival.teamTotalScore) || 0;
    } else {
      const armies = data.armies || {};
      const entradas = Object.entries(armies);
      if (!entradas.length || !meuUserId) return;
      const outroId = entradas.map(([uid]) => uid).find(uid => uid !== meuUserId);
      if (!outroId) return;
      const pontos = uid => Number(armies[uid]?.hostscore) || 0;
      meuPlacar = pontos(meuUserId);
      placarRival = pontos(outroId);
    }

    const atual = db.atualizarPlacarBatalha(battleId, meuPlacar, placarRival);
    if (atual) io.emit('battle_live', atual);
  });

  // SUPERFÃ — ainda não ligado no automático, de propósito.
  //
  // O evento `superFanJoin` da lib parecia ser "entrou no clube", mas o nome da
  // chave do TikTok (ttlive_superfan_commentnotif_superfanjoined) é o superfã
  // ENTRANDO NA LIVE. Quem já era superfã há meses era anotado como se tivesse
  // acabado de virar.
  //
  // Não achei, no protocolo, nenhum campo que diga "essa pessoa é superfã" nem
  // uma chave conhecida pra "virou superfã". Então, em vez de chutar de novo,
  // aqui a gente só ESCUTA e anota no log a primeira vez que cada tipo de aviso
  // aparece — com o texto que o TikTok manda junto. Numa live em que alguém
  // virar superfã de verdade, a linha certa aparece no log e daí dá pra ligar
  // isso no automático com precisão.
  const avisosVistos = new Set();
  function espiarBarrage(data, origem) {
    if (myId !== activeConnectionId) return;
    const chave = data.content?.key || data.commonBarrageContent?.key || '(sem chave)';
    if (avisosVistos.has(chave)) return; // só a primeira vez de cada tipo
    avisosVistos.add(chave);
    const texto = data.content?.defaultPattern
      || data.commonBarrageContent?.defaultPattern || '(sem texto)';
    const quem = data.user?.nickname || data.user?.nickName || '(sem nome)';
    console.log(`[aviso:${origem}] chave="${chave}" texto="${texto}" quem="${quem}"`);
  }

  connection.on('superFanJoin', data => espiarBarrage(data, 'superFanJoin'));
  connection.on('superFan', data => espiarBarrage(data, 'superFan'));

  // SUBIDA DE NÍVEL ANUNCIADA PELO TIKTOK — agora com a chave certa.
  //
  // O que me enganou antes: `userGradeParam`/`fansLevelParam` vêm preenchidos
  // TAMBÉM no banner de entrada na live (a pessoa entra, o banner mostra o
  // nível dela). Quem separa uma coisa da outra é o msgType, do enum
  // BarrageMessageBarrageType da lib:
  //     8  = USER_UPGRADE                     -> presenteador SUBIU
  //     9  = GRADE_USER_ENTRANCE_NOTIFICATION -> só entrou
  //     10 = FANS_LEVEL_UPGRADE               -> membro SUBIU
  //     11 = FANS_LEVEL_ENTRANCE              -> só entrou
  // Confirmado no log da live: AJB veio com 9 e caiozz com 11, os dois entrada.
  const BARRAGE_SUBIU_PRESENTEADOR = 8;
  const BARRAGE_SUBIU_MEMBRO = 10;

  connection.on('barrage', data => {
    espiarBarrage(data, 'barrage');
    if (myId !== activeConnectionId) return;

    const msgType = Number(data.msgType);
    const ehSubida = msgType === BARRAGE_SUBIU_PRESENTEADOR || msgType === BARRAGE_SUBIU_MEMBRO;
    const tipo = msgType === BARRAGE_SUBIU_MEMBRO ? 'membro' : 'presenteador';
    const param = msgType === BARRAGE_SUBIU_MEMBRO ? data.fansLevelParam : data.userGradeParam;

    const quem = param?.user || data.user || {};
    const nome = quem.nickname || quem.nickName || '(sem nome)';
    const nivel = Number(param?.currentGrade) || 0;

    if (!ehSubida) {
      // entrada e outros banners: só observa, não escreve na lista
      const grade = Number(data.userGradeParam?.currentGrade) || 0;
      const fans = Number(data.fansLevelParam?.currentGrade) || 0;
      if (grade || fans) {
        registrarDiagnostico('banner',
          `${nome} msgType=${msgType} grade=${grade || '-'} fans=${fans || '-'} (não é subida)`);
      }
      return;
    }

    if (!nivel || nome === '(sem nome)') {
      registrarDiagnostico('banner', `subida de ${tipo} sem dados suficientes (msgType=${msgType})`);
      return;
    }

    const uniqueId = quem.displayId || quem.uniqueId || quem.id || param?.userId || null;
    const avatar = quem.avatarThumb?.urlList?.[0] || null;
    const item = db.registrarSubidaDeNivel(uniqueId, nome, avatar, nivel, tipo);
    if (item) io.emit('tropa_add', item);
  });

  // ---------- FAREJADOR DE SUBIDA DE NÍVEL ----------
  // Objetivo: descobrir QUAL mensagem o TikTok manda no instante em que alguém
  // sobe de nível. Com essa mensagem na mão, o mural para de depender de
  // inferência e passa a ser exato.
  //
  // A lib emite 'decodedData' pra TODA mensagem que chega, com o nome do tipo.
  // Aqui a gente ignora as de alto volume (comentário, presente, like...) e
  // anota o resto: uma linha por tipo novo, e linha cheia pra qualquer mensagem
  // que cheire a "subiu de nível".
  const ALTO_VOLUME = new Set([
    'WebcastChatMessage', 'WebcastGiftMessage', 'WebcastLikeMessage',
    'WebcastMemberMessage', 'WebcastRoomUserSeqMessage', 'WebcastSocialMessage',
    'WebcastLinkMicArmies', 'WebcastEmoteChatMessage'
  ]);
  // Procuramos só nos TEXTOS da mensagem (as chaves e as frases que o TikTok
  // manda), nunca no JSON inteiro — senão nome de arquivo de imagem tipo
  // "grade_badge_lv28.png" dispara alarme falso, que foi o que aconteceu.
  const CHEIRO_DE_SUBIDA = /upgrade|level.?up|grade.?up|promote|reached|now.?level|subiu|n[ií]vel/i;

  // varre a mensagem atrás de key/defaultPattern em qualquer profundidade
  function textosDaMensagem(obj, achados = [], profundidade = 0) {
    if (!obj || typeof obj !== 'object' || profundidade > 6) return achados;
    for (const [chave, valor] of Object.entries(obj)) {
      if ((chave === 'key' || chave === 'defaultPattern') && typeof valor === 'string' && valor) {
        achados.push(valor);
      } else if (valor && typeof valor === 'object') {
        textosDaMensagem(valor, achados, profundidade + 1);
      }
      if (achados.length > 40) break;
    }
    return achados;
  }
  const tiposVistos = new Set();
  let farejadosNaLive = 0;
  const LIMITE_FAREJADOR = 300; // teto de segurança pra não inundar o log

  connection.on('decodedData', (metodo, decodificada) => {
    if (myId !== activeConnectionId) return;
    if (farejadosNaLive >= LIMITE_FAREJADOR) return;

    const tipo = decodificada?.type || metodo;
    if (!tipo || ALTO_VOLUME.has(tipo)) return;

    const dados = decodificada?.data ?? decodificada;
    let texto;
    try {
      texto = JSON.stringify(dados, (k, v) => (typeof v === 'bigint' ? String(v) : v));
    } catch (e) { return; }
    if (!texto) return;

    const quem = dados?.user?.nickname || dados?.user?.nickName || '';
    const hora = new Date().toLocaleTimeString('pt-BR');
    const textos = textosDaMensagem(dados);

    // 1) Cheirou a subida: manda a mensagem inteira (é o que eu preciso ver)
    if (textos.some(t => CHEIRO_DE_SUBIDA.test(t))) {
      farejadosNaLive++;
      const cabecalho = `>>> POSSÍVEL SUBIDA <<< tipo=${tipo} quem="${quem}"`;
      console.log(`[FAREJADOR ${hora}] ${cabecalho}`);
      console.log(`[FAREJADOR ${hora}] ${texto.slice(0, 1800)}`);
      registrarDiagnostico('subida', cabecalho);
      registrarDiagnostico('subida', texto.slice(0, 1800));
      return;
    }

    // 2) Tipo nunca visto: uma linha só, pra montar o inventário da live
    // 2) Tipo nunca visto: uma linha curta e legível, com as frases da mensagem
    //    em vez do JSON cru (que só enchia a tela de cabeçalho e id).
    if (!tiposVistos.has(tipo)) {
      tiposVistos.add(tipo);
      farejadosNaLive++;
      const resumo = textos.length ? textos.slice(0, 4).join(' | ') : '(sem texto)';
      const linha = `tipo novo: ${tipo}${quem ? ` quem="${quem}"` : ''} → ${resumo}`;
      console.log(`[FAREJADOR ${hora}] ${linha}`);
      registrarDiagnostico('farejador', linha);
    }
  });

  // ---------- SONDA DOS POWER-UPS DO PK ----------
  // Listener próprio, separado do farejador de propósito: o farejador só mostra
  // UMA linha por tipo de mensagem, e aqui eu preciso do JSON inteiro de TODA
  // carta pra descobrir uma coisa que o schema não responde: qual power-up foi
  // GANHO. O `awardCardNotice` traz `awardedUsers[]` (quem ganhou) mas nenhum
  // campo dizendo qual carta — só o texto traduzido. Esta sonda existe pra
  // confirmar isso numa live real antes de construir qualquer estoque em cima.
  // Some sozinha depois de LIMITE_SONDA dumps, pra não inundar a página.
  let sondaPowerUp = 0;
  const LIMITE_SONDA = 40;
  const CARTAS_PK = {
    2: 'critical_strike', 3: 'smoke/nevoa', 4: 'AWARD (ganhou)', 5: 'extra_time/tempo',
    6: 'special_effect', 7: 'potion', 8: 'wave', 9: 'special_effect_notice',
    10: 'top2', 11: 'top3', 12: 'vault_glove/luva', 1: 'card_obtain_guide'
  };

  connection.on('decodedData', (metodo, decodificada) => {
    if (myId !== activeConnectionId) return;
    const tipo = decodificada?.type || metodo;
    if (tipo !== 'WebcastLinkMicBattleItemCard') return;
    if (sondaPowerUp >= LIMITE_SONDA) return;
    sondaPowerUp++;

    const d = decodificada?.data ?? decodificada;
    let json;
    try {
      json = JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? String(v) : v));
    } catch (e) { return; }

    const rotulo = CARTAS_PK[d?.msgType] || `msgType desconhecido (${d?.msgType})`;
    registrarDiagnostico('powerup', `[${sondaPowerUp}/${LIMITE_SONDA}] CARTA DE PK → ${rotulo}`);
    // displayContent de QUALQUER carta (uso ou prêmio) — é onde mora o nome real
    let dc = d?.awardCardNotice?.displayContent;
    for (const campo of Object.values(PK_CARTA_POR_MSGTYPE).map(m => m.campo)) {
      const carta = d?.[campo];
      if (!carta) continue;
      if (carta.displayContent) dc = carta.displayContent;
      const info = carta.cardInfo;
      registrarDiagnostico('powerup',
        `  cardNameKey="${info?.common?.cardNameKey || info?.cardNameKey || ''}"` +
        (carta.effectType !== undefined ? ` effectType=${carta.effectType}` : ''));
      break;
    }
    // imprime os DOIS ids de cada pessoa: preciso saber se o @ (displayId) vem
    const pessoas = [
      ...(d?.awardCardNotice?.awardedUsers || []).map(b => ['ganhou', b?.user]),
      ...Object.values(PK_CARTA_POR_MSGTYPE)
        .map(mp => ['usou', usuarioDaCarta(d?.[mp.campo])]).filter(([, u]) => u)
    ];
    pessoas.forEach(([papel, u]) => {
      if (!u) return;
      registrarDiagnostico('powerup',
        `  ${papel}: nick="${u.nickName || ''}" userId="${u.userId || ''}" displayId="${u.displayId || '(VAZIO)'}"`);
    });
    // TAGS de cada premiado: é aqui que pode estar o nome da carta ganha.
    (d?.awardCardNotice?.awardedUsers || []).forEach((bu, i) => {
      const tags = bu?.tags || [];
      if (!tags.length) {
        registrarDiagnostico('powerup', `  premiado[${i}] SEM TAGS`);
        return;
      }
      tags.forEach((tg, j) => {
        registrarDiagnostico('powerup',
          `  premiado[${i}].tag[${j}] content="${tg?.content || ''}"` +
          ` icone="${tg?.iconImage?.uri || tg?.iconImage?.urlList?.[0] || ''}"`);
      });
    });
    if (dc) {
      registrarDiagnostico('powerup', `  key="${dc.key || ''}" pattern="${dc.defaultPattern || ''}"`);
      (dc.pieces || []).forEach((pc, i) => {
        const txt = pc?.stringValue || pc?.patternRefValue?.key || pc?.patternRefValue?.defaultPattern;
        if (txt) registrarDiagnostico('powerup', `  pedaco[${i}] "${txt}"`);
      });
    }
    registrarDiagnostico('powerup', (json || '').slice(0, 1800));
    console.log(`[POWERUP] ${rotulo} :: ${(json || '').slice(0, 1200)}`);
  });

  // Mantém a lista de contribuintes do nosso lado. Fica separado da sonda de
  // baixo porque a sonda tem teto de logs e isto precisa rodar sempre.
  connection.on('linkMicArmies', data => {
    if (myId !== activeConnectionId) return;
    if (!meuUserId) return;

    const battleId = String(data?.battleId || '');
    if (battleId && battleId !== batalhaDosContribuintes) {
      batalhaDosContribuintes = battleId;
      meusContribuintes = new Set();          // batalha nova, lista nova
    }
    // armies é um mapa anfitrião -> exército. O nosso é o do meuUserId.
    const meu = (data?.armies || {})[String(meuUserId)];
    (meu?.userArmies || []).forEach(ua => {
      const id = String(ua?.userIdStr || ua?.userId || '');
      if (id) meusContribuintes.add(id);
    });
  });

  // ---------- SONDA 2: EFEITOS POR USUÁRIO (linkMicArmies) ----------
  // O linkMicArmies traz effectInfos.effectInfoList = [{type, uidList, effectExtra}],
  // ou seja, QUAL efeito está ativo em QUAIS usuários. Se isso vier preenchido,
  // é a fonte certa pra saber o que cada um ganhou — melhor que adivinhar pelo
  // texto do prêmio. Também loga o ranking de contribuidores, porque "no. 2
  // booster" tem cara de ser POSIÇÃO (2º colocado) e não nome de carta.
  //
  // Este evento dispara a cada presente, então: só loga quando tem efeito,
  // ignora repetição e tem teto próprio.
  let sondaEfeitos = 0;
  const LIMITE_EFEITOS = 30;
  let ultimaAssinaturaEfeito = '';

  connection.on('linkMicArmies', data => {
    if (myId !== activeConnectionId) return;
    if (sondaEfeitos >= LIMITE_EFEITOS) return;

    const lista = data?.effectInfos?.effectInfoList || [];
    const ranking = [];
    Object.values(data?.armies || {}).forEach(exercito => {
      (exercito?.userArmies || []).forEach((ua, pos) => {
        ranking.push(`${pos + 1}º ${ua?.nickname || ''} (${ua?.userIdStr || ua?.userId || ''}) ${ua?.score || 0}`);
      });
    });

    if (!lista.length && !ranking.length) return;

    // não repete a mesma foto duas vezes seguidas
    const assinatura = JSON.stringify([lista, ranking]);
    if (assinatura === ultimaAssinaturaEfeito) return;
    ultimaAssinaturaEfeito = assinatura;
    sondaEfeitos++;

    registrarDiagnostico('powerup', `[efeitos ${sondaEfeitos}/${LIMITE_EFEITOS}] versao=${data?.effectInfos?.effectListVersion || ''}`);
    if (!lista.length) registrarDiagnostico('powerup', '  effectInfoList VAZIO');
    lista.forEach((ef, i) => {
      registrarDiagnostico('powerup',
        `  efeito[${i}] type="${ef?.type || ''}" uids=[${(ef?.uidList || []).join(',')}] extra="${(ef?.effectExtra || '').slice(0, 200)}"`);
    });
    ranking.slice(0, 6).forEach(linha => registrarDiagnostico('powerup', `  contrib ${linha}`));
  });

  // ---------- POWER-UPS DO PK: QUEM GANHOU / QUEM USOU ----------
  connection.on('linkMicBattleItemCard', data => {
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();

    const msgType = Number(data?.msgType);
    let mexeu = false;

    // GANHOU: awardedUsers[] diz quem, mas o protocolo NÃO tem campo dizendo
    // qual carta foi ganha (só o texto traduzido em displayContent). Então a
    // carta entra na fila com tipo null e o abatimento cai pra "mais antiga".
    if (msgType === PK_MSG_GANHOU) {
      const premiados = data?.awardCardNotice?.awardedUsers || [];
      const qtdGanha = quantidadeDoTexto(textosDoDisplayContent(data?.awardCardNotice?.displayContent));
      premiados.forEach(bu => {
        const p = dadosDoUsuarioPK(bu?.user);
        if (!p) return;
        // O prêmio não diz de que lado a pessoa é. Só conta quem apareceu como
        // contribuinte NOSSO no linkMicArmies — senão entra o suporte do
        // adversário. Sem essa lista ainda, não conta (melhor faltar do que
        // contar o inimigo).
        if (!meusContribuintes.has(String(p.uniqueId))) {
          registrarDiagnostico('powerup',
            `  PULOU prêmio de "${p.nickname}" (${p.uniqueId}): ` +
            (meusContribuintes.size ? 'não está nos nossos contribuintes' : 'lista de contribuintes ainda vazia'));
          return;
        }
        // item e quantidade DESTE premiado (a tag dele), não da mensagem toda
        const tipoGanho = descobrirCartaDoPremiado(bu, data);
        const qtd = quantidadeDoPremiado(bu) ?? qtdGanha;

        if (db.registrarCartaGanha(p.uniqueId, p.nickname, p.avatar, tipoGanho, p.handle, qtd)) {
          mexeu = true;
          // Sem pushFeed de propósito: o feedLine() do front não conhece esses
          // tipos e renderizaria uma linha sem texto. O lugar deles é a aba.
          console.log(`[POWERUP] ${p.nickname} GANHOU ${qtd}x ${tipoGanho || 'power-up (item nao identificado -> fica pendente)'}`);
        }
      });
    }

    // USOU: aqui o protocolo é completo — sabe a carta (pelo msgType) e quem.
    const mapa = PK_CARTA_POR_MSGTYPE[msgType];
    if (mapa) {
      const carta = data?.[mapa.campo];
      // A carta diz pra qual anfitrião foi jogada. Se foi contra a gente, não
      // entra no estoque — era esse o bug: contava o suporte do adversário.
      const nosso = ehDoNossoLado(carta);
      if (nosso === false) {
        registrarDiagnostico('powerup',
          `  IGNORADO: carta jogada pro anfitrião ${anfitriaoBeneficiado(carta)} (não é o nosso ${meuUserId})`);
        return;
      }
      if (nosso === null) {
        registrarDiagnostico('powerup',
          `  ATENÇÃO: não deu pra saber o lado da carta (meuUserId=${meuUserId || 'null'}, ` +
          `anfitrião="${anfitriaoBeneficiado(carta)}") — contando como nosso`);
      }
      const p = dadosDoUsuarioPK(usuarioDaCarta(carta));
      const tipoUsado = descobrirCartaUsada(data, mapa);
      const qtdUsada = quantidadeDoTexto(textosDoDisplayContent(carta?.displayContent));
      if (p && db.registrarCartaUsada(p.uniqueId, p.nickname, p.avatar, tipoUsado, p.handle, qtdUsada)) {
        mexeu = true;
        console.log(`[POWERUP] ${p.nickname} USOU ${qtdUsada}x ${tipoUsado}`);
      }
    }

    if (mexeu) broadcastPowerUps();
  });

  connection.on('member', data => {
    processarBadges(data);
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const nickname = data.user?.nickname || data.nickname;
    const avatar = getAvatar(data);
    pushFeed({ type: 'join', uniqueId, nickname, avatar });
  });

  // ÚNICO listener de roomUser (antes existiam dois, duplicados, um deles
  // nem chamava db.updateViewerCount — foi removido).
  connection.on('roomUser', data => {
    if (myId !== activeConnectionId) return;
    lastEventAt = Date.now();
    // `total` (campo 3) = quem está assistindo AGORA.
    // `totalUser` (campo 7) = acumulado de quem já entrou na live — era esse
    // que eu estava lendo, por isso o número só subia e o pico ficava inflado.
    // viewerCount é o nome antigo da v1, fica só como último recurso.
    const count = Number(data.total ?? data.viewerCount ?? 0) || 0;
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

// Uma carta vence 5 dias depois de ganha, possivelmente sem live rolando. Este
// tick só reavalia o estoque (getEstoqueCartas já expira o que passou do prazo)
// e reemite pra quem estiver com a aba aberta.
setInterval(broadcastPowerUps, 5 * 60 * 1000);

const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
setInterval(() => {
  // marca que a live seguia no ar; se o servidor reiniciar logo em seguida,
  // a duração é retomada em vez de voltar pro zero
  if (liveOnline) db.heartbeat();

  // adversário que some no meio não gera evento de fim: fecha na unha
  if (db.fecharBatalhaAbandonada()) {
    console.log('Batalha encerrada por abandono (o adversário parou de responder)');
    broadcastBattles();
  }

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

// Limpa só o mural da tropa (o print da semana recomeça do zero). Ranking,
// likes, presentes e os níveis já conhecidos ficam de pé — diferente do
// /api/reset, que apaga tudo.
app.post('/api/tropa/limpar', (req, res) => {
  db.limparTropa();
  io.emit('tropa_limpa');
  res.json({ ok: true });
});

app.post('/api/tropa/remover', (req, res) => {
  const { nome, tipo } = req.body || {};
  if (!nome || !tipo) return res.status(400).json({ error: 'nome e tipo são obrigatórios' });
  const removeu = db.removerDaTropa(nome, tipo);
  if (removeu) io.emit('tropa_removida', { nome, tipo });
  res.json({ ok: true, removeu });
});

app.get('/api/batalhas', (req, res) => {
  res.json(db.getBattleStats());
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
  socket.emit('battle_stats', db.getBattleStats());
  socket.emit('powerup_estoque', db.getEstoqueCartas());
  socket.emit('diagnostico_init', diagnostico);
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