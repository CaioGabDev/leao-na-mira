// ============================================================================
// DADOS DA LIVE
// ----------------------------------------------------------------------------
// Isto era um módulo com UM estado só, gravando num live.json. Agora é uma
// FÁBRICA: `paraDono('@fulano')` devolve o mesmo conjunto de funções de
// sempre, só que amarrado aos dados daquele dono. Quem chama não mudou nada —
// `db.addLikes(...)` continua idêntico — e é isso que vai permitir, no passo
// seguinte, o servidor segurar vários clientes ao mesmo tempo.
//
// O estado continua inteiro em memória (rápido nos picos de tap); o banco é o
// espelho dele, gravado de tempos em tempos e sempre dentro de uma transação.
// ============================================================================
const fs = require('fs');
const banco = require('./banco');

// Só serve pra migração: o live.json antigo vira a primeira carga do banco.
const JSON_ANTIGO = process.env.RAILWAY_ENVIRONMENT ? '/data/live.json' : 'live.json';

const INTERVALO_GRAVACAO = 5000;

// Uma instância por dono, reaproveitada: dois pedidos pelo mesmo dono têm que
// mexer no MESMO estado em memória, senão um sobrescreve o outro no banco.
const instancias = new Map();

// `opcoes.espelharJson` faz esta instância manter o live.json atualizado no
// formato antigo. Só vale na PRIMEIRA chamada de cada dono (depois disso a
// instância é reaproveitada).
function paraDono(dono, opcoes) {
  const chave = String(dono || '').trim().toLowerCase();
  if (!chave) throw new Error('paraDono precisa do @ do dono da live.');
  if (!instancias.has(chave)) instancias.set(chave, criarBanco(chave, opcoes));
  return instancias.get(chave);
}

// Grava todo mundo antes de morrer. Fica no módulo, e não dentro da fábrica,
// pra não pendurar um listener por cliente no processo.
function gravarTodos() {
  for (const inst of instancias.values()) {
    try { inst.saveToDisk(); } catch (e) { console.error('Erro ao gravar:', e.message); }
  }
}
process.on('SIGINT', () => { gravarTodos(); process.exit(); });
process.on('exit', gravarTodos);

function criarBanco(dono, opcoes) {
  const espelharJson = !!(opcoes && opcoes.espelharJson);
  let state = banco.carregar(dono);

  // Primeira subida depois da mudança: traz o live.json pro banco, uma vez só.
  // O arquivo antigo é só LIDO — fica lá, intacto, como rede de segurança.
  //
  // `listarDonos().length === 0` é a trava que importa: aquele live.json é de
  // UMA instalação, a original. Sem isso, todo cliente novo que fosse criado
  // depois nasceria com os dados do primeiro — cada um enxergando a live do
  // outro. Banco vazio é a única situação em que o arquivo antigo é dele.
  if (!state && banco.listarDonos().length === 0 && fs.existsSync(JSON_ANTIGO)) {
    try {
      state = JSON.parse(fs.readFileSync(JSON_ANTIGO, 'utf-8'));
      console.log(`[banco] importando o live.json para o dono "${dono}"...`);

      // Foto do "antes", feita uma vez só e nunca mais tocada. Se algo der
      // errado na migração, é daqui que se volta.
      const copia = JSON_ANTIGO + '.pre-sqlite';
      if (!fs.existsSync(copia)) {
        fs.copyFileSync(JSON_ANTIGO, copia);
        console.log(`[banco] cópia de segurança em ${copia}`);
      }
    } catch (e) {
      console.error('Erro ao ler o live.json antigo, começando do zero:', e.message);
      state = null;
    }
  }
  if (!state) state = banco.estadoVazio();

  // defaults — o mesmo cuidado de antes, agora protegendo também contra um
  // live.json velho que não tinha esses campos
  state.users = state.users || {};
  state.actions = state.actions || [];
  state.tropa = state.tropa || [];
  state.sessions = state.sessions || []; // histórico de lives já finalizadas
  state.battles = state.battles || [];   // batalhas (PK) já encerradas
  state.currentBattle = state.currentBattle || null; // batalha rolando agora
  state.cartas = state.cartas || {};      // estoque de power-ups do PK por pessoa

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
  // Campo a campo, e não só `state.global || {...}`: um global truncado (que
  // já apareceu vindo de arquivo torto) deixava os contadores `undefined`, e
  // aí a primeira soma virava NaN e contaminava o ranking inteiro.
  ['totalDiamonds', 'totalLikes', 'totalComments', 'totalFollows', 'totalShares',
   'peakViewers', 'currentViewers', 'uniqueViewers'].forEach(campo => {
    if (typeof state.global[campo] !== 'number' || !Number.isFinite(state.global[campo])) {
      state.global[campo] = 0;
    }
  });
  if (typeof state.global.startedAt !== 'number') state.global.startedAt = Date.now();

  // campos novos, com default pra não quebrar estado antigo
  state.global.lastLiveDurationSeconds = state.global.lastLiveDurationSeconds || 0;
  state.global.sessionPeakViewers = state.global.sessionPeakViewers || 0;
  state.currentSessionSnapshot = state.currentSessionSnapshot || null;

  let dirty = false;

  // Buffer da série temporal: os pontos vão pro banco junto com o resto, no
  // saveToDisk. Fica FORA do `state` de propósito — o state é reescrito
  // inteiro a cada gravação, e amostra é append-only.
  //
  // Declarado AQUI, e não junto das funções que usam: o saveToDisk roda uma
  // vez na subida (pra o dono já existir no banco) e `let` mais embaixo
  // deixava ele batendo na zona morta.
  const PASSO_AMOSTRA_MS = 60 * 1000;      // um ponto por minuto
  const GUARDAR_AMOSTRAS_DIAS = 90;
  let amostrasPendentes = [];
  let ultimaAmostraEm = 0;
  let ultimaPoda = 0;

  // A marca de superfã foi gravada por um evento que, na verdade, avisa quando um
  // superfã ENTRA na live — não quando alguém vira superfã. Como isso marcou
  // gente que já era superfã há tempo, a marca é apagada pra não bloquear o
  // registro certo quando ele existir.
  if (!state.global.superfaRemarcado) {
    Object.values(state.users).forEach(u => { delete u.superFaEm; });
    // (o cadastro manual de superfã vive no navegador, não aqui — então isso
    //  só tira o que foi anotado errado pelo automático)
    state.tropa = state.tropa.filter(p => p.tipo !== 'superfã');
    state.global.superfaRemarcado = true;
    dirty = true;
  }

  // Enquanto o id vinha vazio, todos esses eventos caíam num mesmo registro de
  // chave "undefined" — que além de sujar o ranking, marcava followed/shared e
  // fazia todo mundo depois dele ser ignorado na contagem. Tira ele do caminho.
  ['undefined', 'null', ''].forEach(chave => {
    if (!state.users[chave]) return;
    const fantasma = state.users[chave];
    delete state.users[chave];
    if (fantasma.followed) state.global.totalFollows = Math.max(0, state.global.totalFollows - 1);
    if (fantasma.shared) state.global.totalShares = Math.max(0, state.global.totalShares - 1);
    state.global.uniqueViewers = Math.max(0, state.global.uniqueViewers - 1);
    state.actions = state.actions.filter(a => String(a.uniqueId) !== chave);
    dirty = true;
  });

  // O pico ficou gravado com o acumulado de quem entrou (campo errado do
  // TikTok), e pico só cresce — então esse número errado nunca sairia sozinho.
  // Zera uma única vez pra ele voltar a ser medido pelo valor certo.
  // As fantasmas que já entraram no histórico saem daqui. Uma vez só, e a
  // marca fica gravada — o resetAll preserva as marcas de migração de
  // propósito (ver o comentário lá).
  if (!state.global.fantasmasLimpos) {
    const antes = state.sessions.length;
    state.sessions = state.sessions.filter(temSinalDeVida);
    const foram = antes - state.sessions.length;
    if (foram) {
      console.log(`[${dono}] ${foram} "live" sem sinal de vida nenhum saiu do histórico ` +
        '(conexão fantasma: zero espectador, zero interação).');
    }
    state.global.fantasmasLimpos = true;
    dirty = true;
  }

  if (!state.global.picoCorrigido) {
    state.global.peakViewers = 0;
    state.global.sessionPeakViewers = 0;
    state.global.picoCorrigido = true;
    dirty = true;
  }

  // ---------- espelho no formato antigo ----------
  // Enquanto isto existir, voltar pro código pré-SQLite é de graça: o
  // live.json está sempre atualizado. É a rede que segura a migração.
  //
  // Anda junto com o banco, na mesma batida: qualquer atraso aqui vira uma
  // janela de dado que se perderia num rollback. E não custa nada — é a mesma
  // escrita que o código antigo já fazia a cada 5 segundos, sozinha.
  function espelharNoJson() {
    if (!espelharJson) return;
    try {
      fs.writeFileSync(JSON_ANTIGO, JSON.stringify(state, null, 2));
    } catch (e) {
      // o espelho é conveniência: falhar nele não pode derrubar a gravação
      console.error('[banco] não consegui atualizar o live.json:', e.message);
    }
  }

  function saveToDisk() {
    // a amostra vai junto mesmo sem `dirty`: o relógio da gravação é o mesmo
    // que empurra a série temporal pro disco
    amostrar();
    gravarAmostras();
    if (!dirty) return;
    banco.gravar(dono, state);
    dirty = false;
    espelharNoJson();
  }

  const relogio = setInterval(saveToDisk, INTERVALO_GRAVACAO);
  // unref: o relógio de gravação sozinho não segura o processo de pé
  if (relogio.unref) relogio.unref();

  function fechar() {
    saveToDisk();
    espelharNoJson();
    clearInterval(relogio);
    instancias.delete(dono);
  }

  // Se o estado veio do live.json (ou nasceu vazio), grava agora pra o dono
  // já existir no banco e a próxima subida não reimportar nada.
  if (!banco.temDados(dono)) { dirty = true; saveToDisk(); }

  function ensureUser(uniqueId, nickname, avatar) {
    // Sem id não dá pra separar uma pessoa da outra: tudo cairia na mesma chave
    // "undefined" e viraria um usuário só (e o `followed` desse fantasma faria
    // todo mundo depois dele ser ignorado).
    if (!uniqueId) return false;
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
      // só sobrescreve com o que veio de verdade: tem evento que chega sem
      // apelido, e antes isso apagava o nome que já estava guardado
      if (nickname) state.users[uniqueId].nickname = nickname;
      if (avatar) state.users[uniqueId].avatar = avatar;
    }
    return true;
  }

  // Likes: mantém UM único registro por usuário durante toda a live, apenas somando nele
  const pendingLikes = {};
  const likeActionRef = {};

  function addLikes(uniqueId, nickname, count, avatar) {
    state.global.totalLikes += count;
    dirty = true;
    // Sem id o like aconteceu do mesmo jeito (entra no total), só não dá pra
    // dizer de quem foi — então não entra no ranking de ninguém.
    if (!ensureUser(uniqueId, nickname, avatar)) return false;
    state.users[uniqueId].likes += count;
    if (!pendingLikes[uniqueId]) pendingLikes[uniqueId] = { nickname, count: 0 };
    pendingLikes[uniqueId].nickname = nickname;
    pendingLikes[uniqueId].count += count;
  }

  function addToTropa(nome, nivel, tipo, avatar) {
    // a lista do mural é casada por nome; sem nome não dá pra encaixar ninguém
    if (!nome || !String(nome).trim()) return null;
    const existente = state.tropa.find(p =>
      String(p.nome || '').toLowerCase() === String(nome).toLowerCase() && p.tipo === tipo
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

  // Deixa rastro de toda leitura de nível, pra dar pra conferir no log da live
  // por que fulano entrou ou não entrou no mural.
  // Além do log do servidor, manda a linha pra quem estiver ouvindo (o server
  // repassa pra página de diagnóstico, pra dar pra acompanhar sem abrir o
  // Railway no meio da live).
  let ouvinteDeLog = null;
  function setLogListener(fn) { ouvinteDeLog = fn; }

  // A partir de que nível a pessoa entra no mural. Mudar aqui muda os dois tipos.
  const NIVEL_MINIMO_MURAL = 10;

  function registrarLeitura(msg) {
    console.log('[nivel]', msg);
    if (ouvinteDeLog) { try { ouvinteDeLog('nivel', msg); } catch (e) {} }
  }

  function checkLevelUp(uniqueId, nickname, avatar, badges) {
    // sem id não dá pra saber de quem é o nível — e sem isso o `u` abaixo vinha
    // undefined e derrubava o handler inteiro do evento (o comentário/presente
    // daquele evento se perdia junto)
    if (!ensureUser(uniqueId, nickname, avatar)) return [];
    const u = state.users[uniqueId];
    const resultados = [];

    // Uma fonte só: o selo. Antes eu também olhava payGrade/fansClub como
    // reforço e ficava com o maior valor — mas as duas fontes nem sempre dizem
    // o mesmo número pra mesma pessoa, e a diferença entre elas era lida como
    // "subiu de nível". É o selo que aparece do lado do nome; é ele que vale.
    const presenteador = getBadgeLevel(badges, 8);
    const membro = getBadgeLevel(badges, 10);

    // Primeira vez que conseguimos ler um nível dessa pessoa: só anotamos o ponto
    // de partida, sem anunciar. Sem isso, quem já era nível 17 há meses entraria
    // no mural como se tivesse acabado de subir — e sairia de novo num print em
    // que já apareceu. Da segunda leitura em diante, subida é subida.
    //
    // A marca é POR CATEGORIA: muita gente aparece primeiro só com o selo de
    // presenteador, e a primeira leitura do selo de membro (que pode vir lives
    // depois) também não pode contar como subida.
    // Quem manda pro mural é a SUBIDA DO SELO — o número que aparece do lado do
    // nome. É a única fonte que dá pra ler com certeza. A regra é diferente pra
    // cada tipo, porque os dois níveis têm natureza diferente:
    //
    //   membro  = clube de fãs DE VOCÊS. Se subiu, subiu aqui. Ponto.
    //   presenteador = nível global do TikTok. A pessoa pode ter subido gastando
    //                  na live de outro streamer e só aparecer aqui depois. Por
    //                  isso só conta se ela também mandou presente NESTA live —
    //                  sem presente não tem como o nível ter subido aqui.
    // Janela: o presente tem que ter vindo DEPOIS da última vez que a gente leu o
    // nível dela. Assim não basta ter presenteado em algum momento da live — o
    // presente precisa estar dentro do intervalo em que a subida aconteceu.
    // (Antes: presenteou em qualquer momento da live. Isso deixava passar quem
    //  presenteou cedo, subiu na live de outro, e voltou aqui já com nível novo.)
    const inicioDaJanela = Math.max(u.gifterLidoEm || 0, state.global.startedAt || 0);
    const presenteouNaJanela = (u.ultimoPresenteEm || 0) >= inicioDaJanela;

    const anotar = (nivel, tipo, campoNivel, campoLido) => {
      if (!nivel) return; // esse selo não veio nesse evento
      const anterior = u[campoNivel] || 0;
      const primeiraLeitura = !u[campoLido];
      u[campoLido] = true;
      if (tipo === 'presenteador') u.gifterLidoEm = Date.now(); // fecha a janela
      if (nivel <= anterior) return;
      u[campoNivel] = nivel;

      // Primeira vez que lemos o nível dessa pessoa: só ponto de partida. Sem
      // isso, quem já era nível alto entraria como se tivesse acabado de subir.
      if (primeiraLeitura) {
        registrarLeitura(`${nickname} ${tipo} nv${nivel} — primeira leitura, só anotei`);
        return;
      }
      // A checagem da janela vem ANTES do corte de nível 10 de propósito: assim
      // toda subida pequena (2 -> 3, etc) também passa pela regra e vira teste
      // grátis dela no log, mesmo sem entrar no mural.
      if (tipo === 'presenteador' && !presenteouNaJanela) {
        registrarLeitura(
          `${nickname} presenteador ${anterior} -> ${nivel} — subiu FORA daqui ` +
          '(não mandou presente entre uma leitura e outra), fica de fora'
        );
        return;
      }
      if (nivel < NIVEL_MINIMO_MURAL) {
        registrarLeitura(
          `${nickname} ${tipo} ${anterior} -> ${nivel} — subiu AQUI ✔ ` +
          `mas o mural só mostra do ${NIVEL_MINIMO_MURAL} pra cima`
        );
        return;
      }

      const item = addToTropa(nickname, nivel, tipo, avatar);
      registrarLeitura(
        `${nickname} ${tipo} ${anterior} -> ${nivel} — ` +
        (item ? 'ENTROU no mural' : 'já estava no mural com nível igual ou maior')
      );
      if (item) resultados.push(item);
    };

    anotar(presenteador, 'presenteador', 'gifterLevel', 'gifterLido');
    anotar(membro, 'membro', 'memberLevel', 'memberLido');

    dirty = true;
    return resultados;
  }

  // Subida anunciada pelo próprio TikTok (o banner que passa na live).
  // Diferente do selo, aqui não tem adivinhação: o TikTok está dizendo que a
  // pessoa ACABOU de subir, e pra qual nível. Não precisa de linha de base, não
  // perde quem subiu antes da primeira leitura e não inventa quem não subiu.
  function registrarSubidaDeNivel(uniqueId, nickname, avatar, nivel, tipo) {
    const n = Number(nivel);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Só atualiza quem o servidor já conhece. Antes eu criava o registro aqui, e
    // quem só apareceu no aviso de subida entrava no ranking zerado e ainda
    // contava como espectador único.
    if (uniqueId) {
      const u = state.users[uniqueId];
      if (u) {
        const campo = tipo === 'membro' ? 'memberLevel' : 'gifterLevel';
        const lido = tipo === 'membro' ? 'memberLido' : 'gifterLido';
        if (n > (u[campo] || 0)) u[campo] = n;
        u[lido] = true;
        dirty = true;
      }
    }
    if (n < NIVEL_MINIMO_MURAL) {
      registrarLeitura(`(TikTok) ${nickname} ${tipo} nv${n} — subiu AQUI ✔ mas o mural só mostra do ${NIVEL_MINIMO_MURAL} pra cima`);
      return null;
    }
    const item = addToTropa(nickname, n, tipo, avatar);
    registrarLeitura(
      `(TikTok) ${nickname} ${tipo} nv${n} — ` +
      (item ? 'ENTROU no mural' : 'já estava no mural com nível igual ou maior')
    );
    return item;
  }

  // Superfã não tem nível: ou a pessoa é, ou não é. O TikTok avisa no momento em
  // que alguém ENTRA no clube (superFanJoin), então esse é o único evento que
  // serve — o outro (superFan) dispara pra quem já era, e encheria o mural de
  // gente que já saiu em print antigo.
  // O nível 1 aqui é só pra travar a repetição no addToTropa; o mural ignora o
  // número quando o tipo é superfã.
  function registrarSuperfa(uniqueId, nickname, avatar) {
    if (!ensureUser(uniqueId, nickname, avatar)) return null;
    const u = state.users[uniqueId];
    if (u.superFaEm) return null; // já registramos essa pessoa antes
    u.superFaEm = Date.now();
    dirty = true;
    return addToTropa(nickname, 1, 'superfã', avatar);
  }

  // Apagar alguém do mural tem que sair do servidor também, senão o tropa_init
  // do próximo carregamento traz a pessoa de volta.
  function removerDaTropa(nome, tipo) {
    const antes = state.tropa.length;
    state.tropa = state.tropa.filter(p =>
      !(String(p.nome || '').toLowerCase() === String(nome || '').toLowerCase() && p.tipo === tipo)
    );
    const removeu = state.tropa.length < antes;
    if (removeu) { dirty = true; saveToDisk(); }
    return removeu;
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
    state.global.totalDiamonds += value;
    dirty = true;
    if (!ensureUser(uniqueId, nickname, avatar)) return false;
    state.users[uniqueId].gifts_count += 1;
    state.users[uniqueId].gifts_value += value;
    // usado pra saber se a subida de presenteador aconteceu AQUI (ver checkLevelUp)
    state.users[uniqueId].ultimoPresenteEm = Date.now();
    logGiftAction(uniqueId, nickname, giftName, value);
    return true;
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
    if (!ensureUser(uniqueId, nickname, avatar)) return false;
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

  // ============================================================================
  // ESTOQUE DE POWER-UPS DO PK (luva, névoa, tempo, ...)
  //
  // Cada carta GANHA entra numa fila com a hora. Usar tira uma da fila (a mais
  // antiga do mesmo tipo, senão a mais antiga de todas). Passados 5 dias a carta
  // cai sozinha.
  //
  // LIMITE IMPORTANTE: este é o estoque DO QUE ESTA LIVE VIU. O servidor só está
  // conectado a uma sala, e a carta pertence à conta da pessoa — ela pode gastar
  // no PK de outro streamer e o evento nunca chega aqui. Quando isso acontece o
  // número fica ALTO demais (nunca baixo). Por isso o front mostra "estimativa".
  // ============================================================================
  const VALIDADE_CARTA_MS = 5 * 24 * 60 * 60 * 1000; // 5 dias

  function expirarCartas(agora = Date.now()) {
    let mudou = false;
    Object.values(state.cartas).forEach(ficha => {
      const antes = ficha.ganhas.length;
      ficha.ganhas = ficha.ganhas.filter(c => agora - c.em < VALIDADE_CARTA_MS);
      const caiu = antes - ficha.ganhas.length;
      if (caiu > 0) { ficha.expiradas += caiu; mudou = true; }
    });
    if (mudou) dirty = true;
    return mudou;
  }

  function garantirFichaDeCarta(uniqueId, nickname, avatar, handle) {
    if (!uniqueId) return null;
    let ficha = state.cartas[uniqueId];
    if (!ficha) {
      ficha = state.cartas[uniqueId] = {
        uniqueId, handle: handle || null, nickname: nickname || uniqueId, avatar: avatar || null,
        ganhas: [], usos: {}, usadas: 0, expiradas: 0, ultimaEm: Date.now()
      };
    }
    // mesmo cuidado do ensureUser: só sobrescreve com o que veio de verdade
    if (nickname) ficha.nickname = nickname;
    if (avatar) ficha.avatar = avatar;
    if (handle) ficha.handle = handle; // pode chegar só em alguns eventos
    return ficha;
  }

  function registrarCartaGanha(uniqueId, nickname, avatar, tipo, handle, qtd = 1) {
    const ficha = garantirFichaDeCarta(uniqueId, nickname, avatar, handle);
    if (!ficha) return false;
    const agora = Date.now();
    // Uma entrada por premiação. Se o evento identificou a carta (raro — o prêmio
    // costuma vir genérico), já preenche os itens e a premiação não nasce
    // pendente; senão fica esperando alguém informar.
    for (let i = 0; i < Math.max(1, qtd); i++) {
      const entrada = { em: agora, tipo: tipo || null };
      if (tipo) entrada.itens = { [tipo]: 1 };
      ficha.ganhas.push(entrada);
    }
    ficha.ultimaEm = agora;
    dirty = true;
    return true;
  }

  // NÃO abate da fila de premiações — e isso é de propósito.
  //
  // Confirmado em live: UMA mensagem de prêmio pode valer VÁRIAS cartas (a pessoa
  // ganhou 2 luvas e veio uma mensagem só), e o payload não tem quantidade nem
  // nomeia a carta. Então "premiações" e "cartas usadas" são duas contagens
  // diferentes e não dá pra subtrair uma da outra: se a premiação valia 2 e ela
  // usou 1, abater a premiação inteira zerava um estoque que ainda existe.
  //
  // O uso, ao contrário, é exato: sabe a carta, a pessoa e a quantidade.
  // O uso é exato: a carta, a pessoa e a quantidade vêm no evento. É o lado do
  // GASTO do estoque — o lado do GANHO vem de definirItensDaPremiacao, porque o
  // TikTok não diz quais cartas nem quantas cada premiação deu.
  // A premiação não diz qual carta foi — isso está provado com payload de
  // produção: `tags` e `pieces` vêm vazios e o texto é genérico. O USO diz,
  // porque é a única hora em que o TikTok manda o nome do item.
  //
  // Então a premiação pendente mais antiga é resolvida com o item jogado.
  // Mais antiga porque as cartas vencem em 5 dias e quem joga tende a gastar
  // a que está pra vencer. Isso escolhe QUAL premiação recebe um item que o
  // TikTok já afirmou — nunca inventa o item.
  function resolverPendenteComUso(ficha, tipo, quantas) {
    if (!tipo || !ficha || !Array.isArray(ficha.ganhas)) return 0;
    const agora = Date.now();

    const pendentes = ficha.ganhas
      .filter(c => !c.itens || !Object.keys(c.itens).length)
      .filter(c => agora - c.em < VALIDADE_CARTA_MS)   // vencida não conta
      .sort((a, b) => a.em - b.em);

    let resolvidas = 0;
    for (const premio of pendentes) {
      if (resolvidas >= quantas) break;
      premio.itens = { [tipo]: 1 };
      premio.tipo = tipo;
      premio.deduzido = true;   // veio do uso, não de alguém marcando
      resolvidas++;
    }
    return resolvidas;
  }

  function registrarCartaUsada(uniqueId, nickname, avatar, tipo, handle, qtd = 1) {
    const ficha = garantirFichaDeCarta(uniqueId, nickname, avatar, handle);
    if (!ficha) return false;
    const n = Math.max(1, qtd);
    const chave = tipo || 'desconhecido';

    ficha.usos = ficha.usos || {};
    ficha.usos[chave] = (ficha.usos[chave] || 0) + n;
    ficha.usadas += n;

    // o uso ensina o que a premiação era
    if (tipo) resolverPendenteComUso(ficha, tipo, n);

    // O que ESTA pessoa costuma jogar. Não vira palpite de estoque: serve pra
    // tela ajudar na hora de escolher quem chamar pra batalha.
    ficha.jogou = ficha.jogou || {};
    if (tipo) ficha.jogou[tipo] = (ficha.jogou[tipo] || 0) + n;

    ficha.ultimaEm = Date.now();
    dirty = true;
    return true;
  }

  // Informa (ou corrige) QUAIS cartas e QUANTAS uma premiação deu.
  // O TikTok mostra isso no painel dele mas não manda pela live, então quem sabe
  // é a pessoa que está assistindo. `ganhaEm` identifica a premiação.
  function definirItensDaPremiacao(uniqueId, ganhaEm, itens) {
    const ficha = state.cartas[uniqueId];
    if (!ficha) return false;

    const premio = ficha.ganhas.find(c => c.em === Number(ganhaEm));
    if (!premio) return false;

    const limpo = {};
    Object.entries(itens || {}).forEach(([tipo, qtd]) => {
      const n = Math.floor(Number(qtd) || 0);
      if (tipo && n > 0) limpo[tipo] = Math.min(n, 99);   // teto de sanidade
    });

    premio.itens = limpo;
    ficha.ultimaEm = Date.now();
    dirty = true;
    saveToDisk();
    return true;
  }

  // O mesmo conteúdo em TODAS as premiações pendentes e no prazo de alguém.
  //
  // Só as PENDENTES: as que já têm item (informado na mão ou deduzido de um
  // uso que o TikTok confirmou) não são tocadas — senão um clique em lote
  // apagaria informação melhor do que a que está entrando.
  //
  // Devolve quantas foram alteradas, pra tela poder dizer o que aconteceu em
  // vez de só piscar.
  function definirItensDasPendentes(uniqueId, itens) {
    const ficha = state.cartas[uniqueId];
    if (!ficha) return 0;

    const limpo = {};
    Object.entries(itens || {}).forEach(([tipo, qtd]) => {
      const n = Math.floor(Number(qtd) || 0);
      if (tipo && n > 0) limpo[tipo] = Math.min(n, 99);
    });
    if (!Object.keys(limpo).length) return 0;

    const agora = Date.now();
    let mexidas = 0;
    ficha.ganhas.forEach(c => {
      const pendente = !c.itens || !Object.keys(c.itens).length;
      const noPrazo = agora - c.em < VALIDADE_CARTA_MS;
      if (!pendente || !noPrazo) return;
      c.itens = { ...limpo };
      mexidas++;
    });

    if (mexidas) {
      ficha.ultimaEm = agora;
      dirty = true;
      saveToDisk();
    }
    return mexidas;
  }

  function getEstoqueCartas() {
    expirarCartas();
    const agora = Date.now();
    return Object.values(state.cartas)
      .map(ficha => {
        const maisAntiga = ficha.ganhas.length ? Math.min(...ficha.ganhas.map(c => c.em)) : null;
        return {
          uniqueId: ficha.uniqueId,
          handle: ficha.handle || null,
          nickname: ficha.nickname,
          avatar: ficha.avatar,
          // premiações VÁLIDAS (dentro dos 5 dias). Cada uma vale 1 OU MAIS
          // cartas — por isso o front mostra "≥" e não um número seco.
          premiacoes: ficha.ganhas.length,
          pendentes: ficha.ganhas.filter(c => !c.itens || Object.keys(c.itens).length === 0).length,
          usos: ficha.usos || {},
          usadas: ficha.usadas,
          expiradas: ficha.expiradas,
          totalPremiacoes: ficha.ganhas.length + ficha.expiradas,
          // quanto falta pra próxima vencer, em ms (null = não tem carta na mão)
          proximaExpiraEmMs: maisAntiga === null
            ? null
            : Math.max(0, VALIDADE_CARTA_MS - (agora - maisAntiga)),
          // Uma entrada por PREMIAÇÃO: a hora é exata (vem do evento) e os itens
          // são os informados. `pendente` = ainda ninguém disse o que veio nela.
          // o que ESTA pessoa costuma jogar (ajuda a decidir quem chamar)
          jogou: ficha.jogou || {},
          cartas: ficha.ganhas
            .map(c => ({
              ganhaEm: c.em,
              expiraEmMs: Math.max(0, VALIDADE_CARTA_MS - (agora - c.em)),
              itens: c.itens || {},
              // deduzido = o item veio do uso (o TikTok afirmou), não de
              // alguém marcando na mão
              deduzido: !!c.deduzido,
              pendente: !c.itens || Object.keys(c.itens).length === 0
            }))
            .sort((a, b) => a.expiraEmMs - b.expiraEmMs),

          // ESTOQUE POR ITEM: o que foi informado nas premiações no prazo, menos
          // o que a pessoa já jogou. É o "tem 2 luvas e 1 martelo".
          estoque: (() => {
            const ganho = {};
            ficha.ganhas.forEach(c => {
              Object.entries(c.itens || {}).forEach(([t, n]) => {
                ganho[t] = (ganho[t] || 0) + n;
              });
            });
            const usos = ficha.usos || {};
            const saldo = {};
            Object.keys(ganho).forEach(t => {
              const resta = ganho[t] - (usos[t] || 0);
              if (resta > 0) saldo[t] = resta;
            });
            return saldo;
          })(),
          ultimaEm: ficha.ultimaEm
        };
      })
      .filter(f => f.totalPremiacoes > 0 || f.usadas > 0)
      // quem tem premiação válida primeiro (é quem pode jogar carta agora)
      .sort((a, b) => b.premiacoes - a.premiacoes || b.usadas - a.usadas || a.nickname.localeCompare(b.nickname));
  }

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
    state.cartas = {};
    // As marcas de migração NÃO são dado da live: são "isto já foi corrigido
    // uma vez". Reconstruir o global sem elas rearmava as migrações de uso
    // único, e a do pico começa zerando o peakViewers — então resetar + dar
    // restart fazia o pico sumir sozinho no dia seguinte.
    const jaMigrado = {
      superfaRemarcado: state.global.superfaRemarcado,
      picoCorrigido: state.global.picoCorrigido,
      fantasmasLimpos: state.global.fantasmasLimpos
    };
    state.global = {
      totalDiamonds: 0, totalLikes: 0, totalComments: 0, totalFollows: 0, totalShares: 0,
      peakViewers: 0, currentViewers: 0, uniqueViewers: 0, startedAt: Date.now(),
      lastLiveDurationSeconds: 0, sessionPeakViewers: 0
    };
    Object.entries(jaMigrado).forEach(([marca, valor]) => {
      if (valor) state.global[marca] = valor;
    });
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
    state.global.totalComments += 1;
    dirty = true;
    if (!ensureUser(uniqueId, nickname, avatar)) return false;
    state.users[uniqueId].comments += 1;
    logCommentAction(uniqueId, nickname, text);
    return true;
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
    if (!ensureUser(uniqueId, nickname, avatar)) return false;
    if (state.users[uniqueId].followed) return false; // já tinha seguido antes
    state.users[uniqueId].followed = true;
    state.global.totalFollows += 1;
    dirty = true;
    return true;
  }

  function addShare(uniqueId, nickname, avatar) {
    if (!ensureUser(uniqueId, nickname, avatar)) return false;
    if (state.users[uniqueId].shared) return false;
    state.users[uniqueId].shared = true;
    state.global.totalShares += 1;
    dirty = true;
    return true;
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

  // Uma sessão só conta como live se alguma coisa aconteceu nela. Os campos
  // vêm do delta contra o retrato do começo, então "0 em tudo" quer dizer
  // literalmente nada: nem um espectador o TikTok reportou.
  function temSinalDeVida(s) {
    return (s.peakViewers || 0) > 0
      || (s.totalDiamonds || 0) > 0
      || (s.totalLikes || 0) > 0
      || (s.totalComments || 0) > 0
      || (s.totalFollows || 0) > 0
      || (s.totalShares || 0) > 0;
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

    // um ponto no instante em que a live sobe: sem ele a curva começa
    // no primeiro minuto cheio e o começo fica sem base de comparação
    amostrar(true);

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

      const sessao = {
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
      };

      // Só entra no histórico o que teve SINAL DE VIDA.
      //
      // O filtro daqui era `durationSeconds >= 10`, e duração não é o sinal:
      // apareceram "lives" de 1, 2 e 7 minutos com tudo zerado, em horários
      // em que ninguém abriu live nenhuma. Toda vez que o conector consegue
      // abrir a sala isto dispara — um deploy, um restart, uma sala que o
      // TikTok aceita mas não está transmitindo. Cada um virava uma live.
      //
      // Uma live de verdade sempre tem pelo menos um espectador contado. Zero
      // em TUDO, inclusive no pico, é conexão fantasma — e ela não é só feia
      // na lista: ela entra na média por live, no melhor dia, no dia da
      // semana e no horário, puxando todos pra baixo.
      if (durationSeconds >= 10 && temSinalDeVida(sessao)) {
        state.sessions.push(sessao);
        if (state.sessions.length > 200) state.sessions.shift(); // limite de segurança
        state.global.lastLiveDurationSeconds = durationSeconds;
      }
    }
    // e um ponto no fim, antes de marcar como fora do ar: senão o último
    // trecho da live (do penúltimo minuto até o fim) some da curva
    amostrar(true);

    state.global.liveActive = false;
    state.currentSessionSnapshot = null;
    dirty = true;
  }

  // ---------- BATALHAS (PK / link mic) ----------
  const MAX_BATALHAS = 500;

  function iniciarBatalha(battleId, oponente, terminaEm, times) {
    // o TikTok repete o evento de abertura; não recomeça a mesma batalha
    if (state.currentBattle && state.currentBattle.battleId === battleId) {
      return state.currentBattle;
    }
    state.currentBattle = {
      battleId,
      startedAt: Date.now(),
      oponente, // { uniqueId, nickname, avatar }
      meuScore: 0,
      scoreOponente: 0,
      terminaEm: terminaEm || null,  // horário previsto de fim, quando o TikTok manda
      ultimoSinalEm: Date.now(),     // última vez que o placar mexeu
      // batalha de dupla: guardamos os times pra somar o placar do lado certo
      emDupla: !!(times && times.meuTimeId),
      meuTimeId: times?.meuTimeId || null,
      timeRivalId: times?.timeRivalId || null
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
    b.ultimoSinalEm = Date.now();
    dirty = true;
    return b;
  }

  // Quando o adversário abandona no meio, o TikTok simplesmente para de mandar
  // evento — não vem FINISH nenhum. Sem isso a batalha ficava "ao vivo" pra
  // sempre no painel, travada no último placar.
  const BATALHA_SILENCIO_MS = 3 * 60 * 1000;   // placar parado por tanto tempo
  const BATALHA_LIMITE_MS = 20 * 60 * 1000;    // teto absoluto, se nada mais servir

  function fecharBatalhaAbandonada() {
    const b = state.currentBattle;
    if (!b) return false;

    const agora = Date.now();
    const passouDoFim = b.terminaEm && agora > b.terminaEm + 60 * 1000;
    const semSinal = agora - (b.ultimoSinalEm || b.startedAt) > BATALHA_SILENCIO_MS;
    const velhaDemais = agora - b.startedAt > BATALHA_LIMITE_MS;
    if (!passouDoFim && !semSinal && !velhaDemais) return false;

    // batalha que nem chegou a pontuar (convite cancelado, por ex.) some sem
    // virar registro — senão o histórico enche de 0 x 0
    if (!b.meuScore && !b.scoreOponente) {
      state.currentBattle = null;
      dirty = true;
      return true;
    }

    finalizarBatalha(b.battleId, { interrompida: true });
    return true;
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
      resultado,
      // marca que não veio veredito do TikTok: o adversário saiu no meio e o
      // resultado saiu do placar em que a batalha parou
      interrompida: !!dados.interrompida,
      emDupla: !!b.emDupla
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

  // ---------- SÉRIE TEMPORAL ----------
  // Um ponto por minuto enquanto a live está no ar. É o que permite ver a
  // CURVA da live em vez de só o total no fim.
  function amostrar(forcado) {
    if (!state.global.liveActive && !forcado) return false;
    const agora = Date.now();
    if (!forcado && agora - ultimaAmostraEm < PASSO_AMOSTRA_MS) return false;

    // arredonda pro minuto: dois pontos no mesmo minuto são o mesmo ponto, e
    // é isso que faz um restart no meio da live não duplicar a curva
    const t = Math.floor(agora / PASSO_AMOSTRA_MS) * PASSO_AMOSTRA_MS;
    ultimaAmostraEm = agora;

    const g = state.global;
    const ponto = {
      t,
      v: g.currentViewers || 0,      // espectadores NAQUELE instante
      d: g.totalDiamonds || 0,       // daqui pra baixo é acumulado
      l: g.totalLikes || 0,
      c: g.totalComments || 0,
      f: g.totalFollows || 0
    };

    // um restart no mesmo minuto substitui o ponto em vez de empilhar
    const igual = amostrasPendentes.findIndex(p => p.t === t);
    if (igual >= 0) amostrasPendentes[igual] = ponto;
    else amostrasPendentes.push(ponto);
    return true;
  }

  function gravarAmostras() {
    if (!amostrasPendentes.length) return;
    const lote = amostrasPendentes;
    amostrasPendentes = [];
    try {
      banco.anexarAmostras(dono, lote);
    } catch (e) {
      // não perde o lote: volta pra fila e tenta na próxima gravação
      amostrasPendentes = lote.concat(amostrasPendentes);
      console.error('[banco] não consegui gravar as amostras:', e.message);
      return;
    }

    // poda uma vez por dia, não a cada gravação
    const agora = Date.now();
    if (agora - ultimaPoda > 24 * 60 * 60 * 1000) {
      ultimaPoda = agora;
      try {
        banco.podarAmostras(dono, agora - GUARDAR_AMOSTRAS_DIAS * 24 * 60 * 60 * 1000);
      } catch (e) {
        console.error('[banco] não consegui podar as amostras:', e.message);
      }
    }
  }

  // A curva, já com os DELTAS calculados: o ponto guarda o acumulado, mas
  // quem desenha quer "quanto rendeu neste minuto".
  //
  // `agrupar` junta N minutos num ponto só — uma live de 6 horas tem 360
  // pontos, e num gráfico de 900px isso é menos de 3 pixels por ponto.
  function getSerie({ desde, ate, agrupar } = {}) {
    const de = Number(desde) || (Date.now() - 6 * 60 * 60 * 1000);
    const ateQuando = Number(ate) || Date.now();

    let pontos;
    try {
      pontos = banco.lerAmostras(dono, de, ateQuando);
    } catch (e) {
      return { pontos: [], erro: e.message };
    }
    // o que ainda não foi gravado também conta: sem isto o último minuto da
    // live só aparece depois da próxima gravação
    amostrasPendentes.forEach(p => {
      if (p.t >= de && p.t <= ateQuando && !pontos.some(q => q.t === p.t)) pontos.push(p);
    });
    pontos.sort((a, b) => a.t - b.t);

    const passo = Math.max(1, Math.floor(Number(agrupar) || 1));
    const saida = [];
    for (let i = 0; i < pontos.length; i += passo) {
      const bloco = pontos.slice(i, i + passo);
      const primeiro = bloco[0];
      const ultimo = bloco[bloco.length - 1];
      // o anterior ao bloco é a base do delta; sem ele o primeiro ponto da
      // série não tem contra o que comparar e vale 0
      const antes = i === 0 ? null : pontos[i - 1];
      const base = antes || primeiro;

      saida.push({
        t: primeiro.t,
        // pico de espectadores dentro do bloco: a média esconderia o momento
        v: Math.max(...bloco.map(p => p.v || 0)),
        d: Math.max(0, (ultimo.d || 0) - (base.d || 0)),
        l: Math.max(0, (ultimo.l || 0) - (base.l || 0)),
        c: Math.max(0, (ultimo.c || 0) - (base.c || 0)),
        f: Math.max(0, (ultimo.f || 0) - (base.f || 0)),
        // acumulado no fim do bloco, pra quem quiser a linha crescente
        dTotal: ultimo.d || 0
      });
    }
    return { pontos: saida, passoMinutos: passo, de, ate: ateQuando };
  }

  // ---------- REGISTROS ----------
  // O olhar longo: quais dias renderam mais, qual dia da semana, qual horário,
  // e os recordes. Tudo calculado das sessões, que já existem.

  const DIA_MS = 24 * 60 * 60 * 1000;
  const NOME_DO_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  // A chave do dia vem do fuso de quem lê, não de UTC: uma live que começa
  // 22h de sexta e vai até 1h de sábado é "sexta" pro streamer.
  function chaveDoDia(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  function somarSessao(alvo, s) {
    alvo.diamantes += s.totalDiamonds || 0;
    alvo.likes += s.totalLikes || 0;
    alvo.comentarios += s.totalComments || 0;
    alvo.seguidores += s.totalFollows || 0;
    alvo.compartilhou += s.totalShares || 0;
    alvo.segundos += s.durationSeconds || 0;
    alvo.lives += 1;
    if ((s.peakViewers || 0) > alvo.pico) alvo.pico = s.peakViewers || 0;
    return alvo;
  }

  const balde = extra => ({
    diamantes: 0, likes: 0, comentarios: 0, seguidores: 0, compartilhou: 0,
    segundos: 0, lives: 0, pico: 0, ...extra
  });

  function getRegistros({ dias } = {}) {
    const sessoes = getSessions();          // mais recente primeiro
    const limite = Number(dias) > 0 ? Date.now() - Number(dias) * DIA_MS : 0;
    const noPrazo = sessoes.filter(s => s.startedAt >= limite);

    // ---------- por dia ----------
    const porDia = new Map();
    noPrazo.forEach(s => {
      const k = chaveDoDia(s.startedAt);
      if (!porDia.has(k)) porDia.set(k, balde({ dia: k, em: s.startedAt }));
      somarSessao(porDia.get(k), s);
    });
    const dias_ = [...porDia.values()].sort((a, b) => a.em - b.em);

    // ---------- por dia da semana ----------
    const porSemana = NOME_DO_DIA.map((nome, i) => balde({ indice: i, nome }));
    noPrazo.forEach(s => somarSessao(porSemana[new Date(s.startedAt).getDay()], s));
    // a média é o que importa aqui: quem faz live toda sexta soma mais que
    // quem fez uma terça, e isso não quer dizer que sexta rende mais
    porSemana.forEach(b => {
      b.mediaPorLive = b.lives ? Math.round(b.diamantes / b.lives) : null;
    });

    // ---------- por hora de início ----------
    const porHora = Array.from({ length: 24 }, (_, h) => balde({ hora: h }));
    noPrazo.forEach(s => somarSessao(porHora[new Date(s.startedAt).getHours()], s));
    porHora.forEach(b => {
      b.mediaPorLive = b.lives ? Math.round(b.diamantes / b.lives) : null;
    });

    // ---------- recordes ----------
    // Sobre TODAS as sessões, não só as do período: recorde é recorde.
    const maiorPor = campo => sessoes.reduce(
      (melhor, s) => (!melhor || (s[campo] || 0) > (melhor[campo] || 0) ? s : melhor), null);

    const melhorDia = dias_.reduce(
      (melhor, d) => (!melhor || d.diamantes > melhor.diamantes ? d : melhor), null);

    const ranking = getRanking();
    const maiorPagante = ranking.reduce(
      (melhor, u) => (!melhor || u.gifts_value > melhor.gifts_value ? u : melhor), null);

    const recordes = {
      melhorLive: maiorPor('totalDiamonds'),
      maiorPico: maiorPor('peakViewers'),
      liveMaisLonga: maiorPor('durationSeconds'),
      melhorDia,
      maiorPagante: maiorPagante && maiorPagante.gifts_value > 0 ? {
        uniqueId: maiorPagante.uniqueId, nickname: maiorPagante.nickname,
        avatar: maiorPagante.avatar, diamantes: maiorPagante.gifts_value
      } : null
    };

    // ---------- sequência de dias com live ----------
    // Mostra constância, que é o que faz a audiência voltar.
    const diasComLive = [...porDia.keys()].sort();
    let sequencia = 0;
    if (diasComLive.length) {
      const umDia = d => { const x = new Date(d + 'T12:00:00'); return x.getTime(); };
      sequencia = 1;
      for (let i = diasComLive.length - 1; i > 0; i--) {
        const diff = Math.round((umDia(diasComLive[i]) - umDia(diasComLive[i - 1])) / DIA_MS);
        if (diff === 1) sequencia++; else break;
      }
      // a sequência só vale se ela chega até hoje ou ontem
      const ultimo = umDia(diasComLive[diasComLive.length - 1]);
      const faltando = Math.round((Date.now() - ultimo) / DIA_MS);
      if (faltando > 1) sequencia = 0;
    }

    const total = noPrazo.reduce((t, s) => somarSessao(t, s), balde());

    return {
      periodoDias: Number(dias) > 0 ? Number(dias) : null,
      total,
      mediaPorLive: total.lives ? {
        diamantes: Math.round(total.diamantes / total.lives),
        segundos: Math.round(total.segundos / total.lives),
        pico: Math.round(noPrazo.reduce((t, s) => t + (s.peakViewers || 0), 0) / total.lives)
      } : null,
      dias: dias_,
      porSemana,
      porHora,
      recordes,
      sequencia,
      lives: noPrazo.slice(0, 60)
    };
  }

  // ---------- DASHBOARD DO STREAMER ----------
  // Junta num lugar só o que ele quer saber. Tudo daqui já existia espalhado
  // (global, ranking, actions, sessions, battles, cartas) — o que faltava era
  // o corte: separar ESTA live do acumulado, e responder perguntas que o
  // número cru não responde ("quem sustenta a live", "melhorou ou piorou").

  // Os números só DESTA live: o acumulado menos o retrato tirado quando ela
  // subiu. Sem live no ar devolve null, e a tela mostra o acumulado.
  function numerosDaLiveAtual() {
    const snap = state.currentSessionSnapshot;
    if (!snap || !state.global.liveActive) return null;
    const g = state.global;
    return {
      comecouEm: snap.startedAt,
      duracaoSegundos: Math.floor((Date.now() - snap.startedAt) / 1000),
      diamantes:     Math.max(0, g.totalDiamonds  - snap.totalDiamonds),
      likes:         Math.max(0, g.totalLikes     - snap.totalLikes),
      comentarios:   Math.max(0, g.totalComments  - snap.totalComments),
      seguidores:    Math.max(0, g.totalFollows   - snap.totalFollows),
      compartilhou:  Math.max(0, g.totalShares    - snap.totalShares),
      pico:          g.sessionPeakViewers || 0
    };
  }

  // Variação contra a live anterior, em %. null quando não dá pra comparar —
  // e null NÃO é zero: "não tem com o que comparar" é diferente de "ficou
  // igual", e a tela precisa saber a diferença pra não desenhar uma seta.
  function variacao(agora, antes) {
    if (typeof antes !== 'number' || antes <= 0) return null;
    return Math.round(((agora - antes) / antes) * 100);
  }

  function getDashboard() {
    const g = getGlobalStats();
    const sessoes = getSessions();          // mais recente primeiro
    const ranking = getRanking();
    const atual = numerosDaLiveAtual();

    // ---------- presentes, agrupados por tipo ----------
    // As actions guardam UM registro por pessoa+presente, com quantos e quanto.
    // Somando por `detail` sai o que mais deu dinheiro na live.
    const porPresente = new Map();
    state.actions.forEach(a => {
      if (a.type !== 'gift' || !a.detail) return;
      let p = porPresente.get(a.detail);
      if (!p) porPresente.set(a.detail, p = { nome: a.detail, envios: 0, diamantes: 0, pessoas: new Set() });
      p.envios += a.count || 0;
      p.diamantes += a.value || 0;
      p.pessoas.add(a.uniqueId);
    });
    const presentes = [...porPresente.values()]
      .map(p => ({ nome: p.nome, envios: p.envios, diamantes: p.diamantes, pessoas: p.pessoas.size }))
      .sort((a, b) => b.diamantes - a.diamantes);

    // ---------- gente ----------
    const pagantes = ranking.filter(u => u.gifts_value > 0);
    const resumir = u => ({
      uniqueId: u.uniqueId, nickname: u.nickname, avatar: u.avatar,
      diamantes: u.gifts_value, presentes: u.gifts_count,
      likes: u.likes, comentarios: u.comments || 0,
      gifterLevel: u.gifterLevel || 0
    });

    const topDiamantes = [...pagantes].sort((a, b) => b.gifts_value - a.gifts_value).slice(0, 10).map(resumir);
    const topLikes = [...ranking].filter(u => u.likes > 0)
      .sort((a, b) => b.likes - a.likes).slice(0, 10).map(resumir);
    const topComentarios = [...ranking].filter(u => (u.comments || 0) > 0)
      .sort((a, b) => (b.comments || 0) - (a.comments || 0)).slice(0, 10).map(resumir);

    // QUEM SUSTENTA A LIVE. Um total alto pode vir de uma pessoa só — e isso
    // muda tudo pro streamer, que precisa saber se depende de alguém.
    const soma = (lista, campo) => lista.reduce((t, u) => t + (u[campo] || 0), 0);
    const diamantesDeTodos = soma(ranking, 'gifts_value');
    const top3 = soma([...pagantes].sort((a, b) => b.gifts_value - a.gifts_value).slice(0, 3), 'gifts_value');
    const concentracao = diamantesDeTodos > 0 ? Math.round((top3 / diamantesDeTodos) * 100) : null;

    // ---------- engajamento ----------
    // De cada 100 que apareceram, quantos fizeram alguma coisa. `uniqueViewers`
    // conta quem gerou QUALQUER evento — quem só assistiu calado nunca entra
    // em nenhuma das duas contas, então isto é "dos que apareceram", não
    // "dos que assistiram". A tela precisa dizer isso.
    const pct = (parte, todo) => (todo > 0 ? Math.round((parte / todo) * 100) : null);
    const apareceram = ranking.length;
    const engajamento = {
      apareceram,
      presentearam: pagantes.length,
      comentaram: ranking.filter(u => (u.comments || 0) > 0).length,
      seguiram: ranking.filter(u => u.followed).length,
      curtiram: ranking.filter(u => u.likes > 0).length,
      pctPresentearam: pct(pagantes.length, apareceram),
      pctComentaram: pct(ranking.filter(u => (u.comments || 0) > 0).length, apareceram),
      pctCurtiram: pct(ranking.filter(u => u.likes > 0).length, apareceram)
    };

    // gente que apareceu pela primeira vez nesta live
    const inicio = atual ? atual.comecouEm : null;
    const novos = inicio === null ? null : ranking.filter(u => (u.firstSeenAt || 0) >= inicio).length;

    // ---------- ritmo ----------
    const horas = (atual ? atual.duracaoSegundos : g.uptimeSeconds) / 3600;
    const diamantesDaJanela = atual ? atual.diamantes : g.totalDiamonds;
    const porHora = horas > 0.02 ? Math.round(diamantesDaJanela / horas) : null;

    // ---------- comparação com a live anterior ----------
    const anterior = sessoes[0] || null;
    const comparar = anterior && atual ? {
      diamantes:   variacao(atual.diamantes,   anterior.totalDiamonds),
      likes:       variacao(atual.likes,       anterior.totalLikes),
      comentarios: variacao(atual.comentarios, anterior.totalComments),
      seguidores:  variacao(atual.seguidores,  anterior.totalFollows),
      pico:        variacao(atual.pico,        anterior.peakViewers)
    } : null;

    // ---------- power-ups ----------
    const fichas = getEstoqueCartas();
    const estoqueTotal = {};
    fichas.forEach(f => {
      Object.entries(f.estoque || {}).forEach(([tipo, n]) => {
        estoqueTotal[tipo] = (estoqueTotal[tipo] || 0) + n;
      });
    });

    return {
      aoVivo: !!g.liveActive,
      atual,                       // null quando não tem live no ar
      acumulado: {
        diamantes: g.totalDiamonds,
        likes: g.totalLikes,
        comentarios: g.totalComments,
        seguidores: g.totalFollows,
        compartilhou: g.totalShares,
        pico: g.peakViewers,
        agora: g.currentViewers,
        pessoas: g.uniqueViewers,
        duracaoSegundos: g.uptimeSeconds
      },
      comparar,
      porHora,
      novos,
      concentracao,
      engajamento,
      presentes: presentes.slice(0, 12),
      presentesTipos: presentes.length,
      topDiamantes,
      topLikes,
      topComentarios,
      // as últimas lives, da mais antiga pra mais nova: é assim que um gráfico
      // de linha do tempo lê
      historico: sessoes.slice(0, 14).reverse(),
      batalhas: getBattleStats(),
      powerups: {
        estoque: estoqueTotal,
        pessoasComCarta: fichas.filter(f => f.premiacoes > 0).length,
        premiacoes: fichas.reduce((t, f) => t + f.premiacoes, 0),
        pendentes: fichas.reduce((t, f) => t + f.pendentes, 0)
      },
      tropa: state.tropa.length
    };
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

  return {
    addLikes, addGift, addPowerUp, getRanking, getUserProfile, resetAll,
    registrarCartaGanha, registrarCartaUsada, getEstoqueCartas, VALIDADE_CARTA_MS,
    definirItensDaPremiacao, definirItensDasPendentes,
    getGlobalStats, updateViewerCount, addComment, addFollow, addShare,
    markLiveOnline, markLiveOffline, checkLevelUp, getTropa, limparTropa, getSessions,
    heartbeat,
    registrarSuperfa, removerDaTropa, registrarSubidaDeNivel, setLogListener,
    iniciarBatalha, atualizarPlacarBatalha, finalizarBatalha, fecharBatalhaAbandonada,
    cancelarBatalhaEmAndamento, getBattleStats, getDashboard, getSerie, getRegistros, amostrar,
    saveToDisk, fechar, dono, espelharNoJson
  };
}

module.exports = { paraDono, gravarTodos, instancias };
