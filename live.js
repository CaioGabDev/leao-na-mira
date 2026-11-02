// ============================================================================
// O MOTOR DA LIVE
// ----------------------------------------------------------------------------
// Passo 2 do multi-cliente: isto era o miolo do server.js, com o estado da
// conexão em variáveis soltas do módulo — ou seja, UMA live por processo.
// Agora é uma fábrica: cada chamada de `criarLive()` devolve um motor
// independente, com a conexão, o feed, o diagnóstico e os relógios dele.
//
// Duas coisas entram de fora de propósito:
//   `db`     — os dados daquele dono (ver db.js / banco.js)
//   `emitir` — como o motor fala com os navegadores. Hoje o servidor passa um
//              `io.emit` (todo mundo recebe, como sempre foi). No passo 3 isso
//              vira `io.to(sala).emit` e é a ÚNICA troca necessária pra um
//              cliente parar de enxergar a live do outro.
// ============================================================================
const { TikTokLiveConnection, IsLiveRouteConfig } = require('tiktok-live-connector');
const ConnectionClass = TikTokLiveConnection;
const assinatura = require('./assinatura');

// ============================================================================
// A CHECAGEM DE "ELE TÁ AO VIVO?" NÃO PODE CUSTAR ASSINATURA
// ----------------------------------------------------------------------------
// Dado do painel do EulerStream em 28/09, janela de 6h: 5.356 requisições,
// TODAS na mesma rota — `GET /webcast/rooms/{room_id}/connect` — com 0,2% de
// sucesso (10 de 5.356). O plano Community dá 2.500 POR DIA. Ou seja: a cota
// inteira do dia ia embora tentando abrir uma live que nem estava no ar.
//
// O `connect()` é caro: cada chamada gasta uma assinatura, o streamer estando
// ao vivo ou não. Já o `fetchIsLive()` do conector responde a mesma pergunta
// de graça, em cascata:
//
//     1. HTML do TikTok (SIGI_STATE status)   <- não custa cota
//     2. API Live do TikTok (liveRoom.status) <- não custa cota
//     3. EulerStream (is_live)                <- CUSTA, e é o que desligamos
//
// Sem desligar a fonte 3, um tropeço nas duas primeiras cairia calado no Euler
// e a economia viraria pó justamente no dia em que o TikTok resolvesse variar
// o HTML. Melhor falhar visível do que gastar escondido.
IsLiveRouteConfig.skipFetchRoomIdFromEulerRoute = true;

// `criarConexao` existe pro teste: o bug do prêmio perdido é sobre ORDEM DE
// CHEGADA dos eventos, e sem poder mandá-los na ordem que eu quero o teste
// não testaria o que quebrou. Em produção ninguém passa, e cai no TikTok.
function criarLive({ dono, db, emitir, criarConexao }) {
  if (!dono) throw new Error('criarLive precisa do @ da live.');
  if (!db) throw new Error('criarLive precisa do db daquele dono.');
  if (typeof emitir !== 'function') throw new Error('criarLive precisa de uma função emitir().');

  let liveOnline = false;

  // Como foi a última tentativa de conectar. Sem isto, "não aparece online"
  // é indistinguível de "@ escrito errado", "streamer ainda não subiu" e
  // "o assinador recusou" — e o dono fica sem saber o que fazer.
  let ultimaTentativa = null;   // { em, ok, motivo, recado }
  let tentativasSeguidas = 0;
  let currentConnection = null;
  let lastEventAt = Date.now();
  let reconnecting = false;
  let connectionCounter = 0;
  let activeConnectionId = 0;
  let disconnectedSince = null; // marca quando a conexão caiu, sem ainda considerar a live encerrada

  // ---------- UMA cadeia de reconexão, e só uma ----------
  // Três lugares pedem "tenta de novo": a falha do connect, o evento
  // `disconnected` e o forceReconnect do vigia. Cada um agendava o seu próprio
  // setTimeout, sem cancelar o do outro — então uma queda podia deixar duas
  // cadeias vivas, a seguinte deixava três, e elas se somavam. No dia 28/09 o
  // log do Railway mostrava conn #29511, #29577 e #29578 tentando no MESMO
  // segundo, com o contador em ~29.500 conexões: várias cadeias batendo de 10
  // em 10s no assinador, o que mantinha o limite dele estourado pra sempre.
  //
  // Agora o agendamento é um só: quem quiser remarcar cancela o que estava
  // marcado. `parar()` limpa o timer — sem isso, um cliente fechado continuava
  // reconectando até o processo morrer.
  let timerReconexao = null;
  let conectando = false;       // tem um connect() em voo?
  let conectandoDesde = 0;

  // Insistir de 10 em 10s é o que mantém um limite de assinatura estourado:
  // cada tentativa conta pro limite, e a janela nunca respira. Agora a espera
  // dobra a cada falha seguida, em três faixas — porque as três recusas pedem
  // paciências diferentes:
  //
  //   limite estourado — insistir é o que mantém o problema de pé. Começa
  //     longe e vai até 15 min, que é o que dá pra janela do Euler respirar.
  //   streamer offline — é o estado NORMAL de quem espera a live começar. O
  //     teto é curto de propósito: quem sobe a live quer ser visto em menos de
  //     um minuto. (Não é de graça: essa checagem também pede o room_id ao
  //     assinador, então ela conta pro limite — daí o teto e não os 10s fixos.)
  //   o resto — queda de rede, @ errado, erro do TikTok: meio-termo.
  const ESPERA_BASE_MS = 10 * 1000;
  const ESPERA_TETO_MS = 2 * 60 * 1000;
  const ESPERA_OFFLINE_TETO_MS = 60 * 1000;
  const ESPERA_LIMITE_BASE_MS = 60 * 1000;
  const ESPERA_LIMITE_TETO_MS = 15 * 60 * 1000;

  function esperaDaTentativa(err) {
    const limite = assinatura.ehLimiteEstourado(err);
    const offline = !limite && classificarFalha(err).motivo === 'offline';
    const base = limite ? ESPERA_LIMITE_BASE_MS : ESPERA_BASE_MS;
    const teto = limite ? ESPERA_LIMITE_TETO_MS
      : offline ? ESPERA_OFFLINE_TETO_MS
      : ESPERA_TETO_MS;
    const expoente = Math.min(Math.max(tentativasSeguidas - 1, 0), 10);
    const cheia = Math.min(base * Math.pow(2, expoente), teto);
    // Sorteio entre 50% e 100% da espera: várias lives que caíram juntas (um
    // deploy, uma queda de rede) não voltam todas no mesmo instante.
    return Math.round(cheia * (0.5 + Math.random() * 0.5));
  }

  function cancelarReconexao() {
    if (timerReconexao) clearTimeout(timerReconexao);
    timerReconexao = null;
  }

  function agendarReconexao(ms, motivo, silencioso) {
    cancelarReconexao();
    const segundos = Math.round(ms / 1000);
    if (!silencioso) console.log(`Tentando novamente em ${segundos}s (${motivo})...`);
    timerReconexao = setTimeout(() => {
      timerReconexao = null;
      reconnecting = false;
      startTikTokConnection();
    }, ms);
  }

  function broadcastLiveStatus() {
    emitir('live_status', { online: liveOnline });
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
    // O raio vem em tres cartas ("no. 1/2/3 booster") = raio 1x, 2x e 3x. O
    // protocolo so tem campo pro 2 e pro 3; o de 1x nao existe aqui, entao ele
    // chega pelo balde generico (msgType 6) e quem identifica e o texto.
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
    // o (?!\d) impede que "top 10" / "no. 20" caiam num dos raios
    [/no[\s._-]*1(?!\d)|top.?1(?!\d)/i,        'booster1' ], // "no. 1 booster" = raio 1x
    [/no[\s._-]*2(?!\d)|top.?2(?!\d)/i,        'booster2' ], // "no. 2 booster" = raio 2x
    [/no[\s._-]*3(?!\d)|top.?3(?!\d)/i,        'booster3' ], // "no. 3 booster" = raio 3x
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

  // O texto da carta traz a quantidade. A carta JOGADA diz "sent 1 boosting
  // glove"; a GANHA diz "got 1 no. 2 booster" — verbo diferente, mesma frase.
  // Ler só o "sent" fazia todo prêmio de 2+ entrar como 1.
  const VERBO_DA_CARTA = /\b(?:got|sent|won|received?|ganhou|recebeu|usou)\s+(\d{1,2})\b/i;

  // Quantidade quando o texto REALMENTE diz; null quando não diz nada.
  function quantidadeDoTextoOuNada(texto) {
    const m = VERBO_DA_CARTA.exec(String(texto || ''));
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 50 ? n : null;   // teto de sanidade
  }

  // Mesma leitura, mas assumindo 1 quando o texto não diz.
  function quantidadeDoTexto(texto) {
    return quantidadeDoTextoOuNada(texto) ?? 1;
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
    [/top1_buffer|top_?1(?!\d)/i, 'booster1' ],
    [/top2_buffer|top_?2(?!\d)/i, 'booster2' ],
    [/top3_buffer|top_?3(?!\d)/i, 'booster3' ],
    [/hammer/i,             'martelo'  ],
    [/heart_?me/i,          'coracao'  ],
    [/smoke|fog/i,          'nevoa'    ],
    [/extra_?time|timer/i,  'tempo'    ],
    [/potion/i,             'pocao'    ],
    [/wave/i,               'onda'     ]
  ];

  // ---------- VARREDURA: achar a frase do item em QUALQUER campo ----------
  // Um print de outra ferramenta mostrou, no mesmo payload, a frase que o TikTok
  // desenha na tela: "got 1 no. 2 booster". Ou seja, o nome do item ESTÁ na
  // mensagem — só não num campo fixo que dê pra apontar com o dedo. Então, como
  // ÚLTIMO recurso (depois de todos os campos conhecidos), varre o objeto
  // inteiro atrás dessa frase.
  //
  // Duas travas pra não pescar besteira, porque aqui passa dado de usuário
  // (um apelido "Tempo" ou "Top 1 da Tropa" viraria carta):
  //   1. frase de premiação/uso: precisa de verbo + número ("got 1 ...")
  //   2. ou chave de i18n: sem espaço, com "_", falando de power-up/carta
  // URL de imagem fica de fora: a imagem já mentiu uma vez em live.
  function pareceChaveDeI18n(t) {
    return !/\s/.test(t) && t.includes('_') && /power.?up|booster|card|match|boost/i.test(t);
  }

  function frasesDaMensagem(raiz) {
    const achadas = [];
    const vistos = new Set();
    const fila = [[raiz, 0]];                 // largura primeiro: campo raso antes
    while (fila.length && achadas.length < 200) {
      const [no, nivel] = fila.shift();
      if (no === null || no === undefined || nivel > 8) continue;

      if (typeof no === 'string') {
        const t = no.trim();
        if (t && t.length <= 160 && !/^https?:/i.test(t) &&
            (VERBO_DA_CARTA.test(t) || pareceChaveDeI18n(t))) achadas.push(t);
        continue;
      }
      if (typeof no !== 'object' || ArrayBuffer.isView(no)) continue;  // bytes do proto, não
      if (vistos.has(no)) continue;
      vistos.add(no);
      for (const v of Object.values(no)) fila.push([v, nivel + 1]);
    }
    return achadas;
  }

  // Devolve { tipo, qtd, frase } quando o payload aponta pra UMA carta só.
  // qtd vem null quando a frase não diz quantidade.
  //
  // Trava importante: se aparecer mais de um item DIFERENTE, a varredura não
  // responde nada. Pode ser catálogo de cartas viajando junto, ou a carta do
  // adversário na mesma mensagem — em nenhum dos dois casos o payload está
  // dizendo "foi esta". Aí é melhor ficar pendente e a pessoa informar do que
  // carimbar o item errado no estoque.
  function varreduraDaCarta(raiz) {
    const achados = [];
    for (const frase of frasesDaMensagem(raiz)) {
      const tipo = tipoPelasPalavras(frase);
      if (tipo) achados.push({ tipo, qtd: quantidadeDoTextoOuNada(frase), frase });
    }
    if (!achados.length) return null;
    if (new Set(achados.map(a => a.tipo)).size > 1) return null;   // ambíguo: não chuta
    return achados[0];
  }

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
        || varreduraDaCarta(data)?.tipo
        || mapa.tipo;
  }

  // (saíram daqui `descobrirCartaGanha`, `descobrirCartaDoPremiado` e
  // `quantidadeDoPremiado`: existiam só pra adivinhar o item do prêmio, e a
  // premiação agora nasce vazia por decisão, não por falta de tentativa.)

  // Quantos segundos o efeito da carta dura. Mesmo aninhamento torto do
  // sendUser: uns põem em cardInfo, outros em cardInfo.common.
  function duracaoDoEfeito(carta) {
    const info = carta?.cardInfo;
    const bruto = info?.effectLastDuration ?? info?.common?.effectLastDuration;
    const n = Number(bruto);
    // teto de sanidade: efeito de PK dura dezenas de segundos, não horas
    return Number.isFinite(n) && n > 0 && n <= 600 ? Math.round(n) : 0;
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
  // O nosso exercito da batalha atual, COM pontuacao, na ordem em que o TikTok
  // manda (maior primeiro). Serve so pro diagnostico do premio: o item ganho
  // parece depender da posicao, e sem guardar isto nao da pra conferir.
  let meuExercito = [];
  // O último exército que chegou antes de sabermos quem somos. Sem isto, um
  // linkMicArmies anterior ao primeiro linkMicBattle é jogado fora — e foi
  // assim que um prêmio de produção se perdeu (ver guardarContribuintes).
  let exercitosPendentes = null;
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
    emitir('powerup_estoque', db.getEstoqueCartas());
  }

  function broadcastRanking() {
    emitir('ranking', db.getRanking());
  }

  let liveFeed = [];
  function pushFeed(event) {
    event.timestamp = Date.now();
    liveFeed.push(event);
    if (liveFeed.length > 50) liveFeed.shift();
    emitir('live_feed_event', event);
  }

  function broadcastGlobalStats() {
    emitir('global_stats', db.getGlobalStats());
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
  // 1200 e nao 400 por causa da janela do premio: um despejo de JSON inteiro
  // ocupa varias linhas e com 400 ele se comia sozinho antes de ser lido.
  const MAX_DIAGNOSTICO = 1200;

  function registrarDiagnostico(canal, texto) {
    const linha = { canal, texto, em: Date.now() };
    diagnostico.push(linha);
    if (diagnostico.length > MAX_DIAGNOSTICO) diagnostico.shift();
    emitir('diagnostico', linha);
  }

  db.setLogListener(registrarDiagnostico);

  function broadcastBattles() {
    emitir('battle_stats', db.getBattleStats());
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
    return (anfitriao.displayId || '').toLowerCase() === dono.toLowerCase();
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
    subidas.forEach(item => emitir('tropa_add', item));
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

  // O /api/reset zera o banco inteiro, e a sessão da live que está rolando vai
  // junto (`currentSessionSnapshot` volta a null). O `liveOnline` daqui é de
  // memória e NÃO some junto — e `markLiveOnline()` só é chamado na transição
  // de offline pra online, que já aconteceu. Resultado: quem resetava no meio
  // da live ficava com o painel dizendo offline e a duração parada até a
  // próxima reconexão. Quem está no ar precisa se reapresentar ao banco.
  function sessaoReiniciada() {
    if (!liveOnline) return false;
    db.markLiveOnline();
    broadcastLiveStatus();
    return true;
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

    agendarReconexao(5000, motivo);
  }

  function getAvatar(data) {
    return data.profilePictureUrl
      || data.user?.avatarThumb?.urlList?.[0]
      || data.user?.profilePicture?.url
      || null;
  }

  // A foto do próprio streamer vem no roomInfo que o connect() já busca
  // (fetchRoomInfoOnConnect, ligado por padrão na lib) — nenhuma chamada a
  // mais pro TikTok. Só que é o JSON cru do TikTok, sem tipo na lib: por isso
  // a leitura defensiva. Faltou o campo, fica sem foto e a tela usa a padrão.
  function guardarPerfilDoStreamer(roomInfo) {
    try {
      const owner = roomInfo?.data?.owner || roomInfo?.owner;
      if (!owner) return;
      db.setPerfilDoStreamer({
        avatar: owner.avatar_thumb?.url_list?.[0] || owner.avatar_medium?.url_list?.[0]
          || owner.avatarThumb?.urlList?.[0] || null,
        nome: owner.nickname || null
      });
    } catch (e) {
      // perfil é enfeite: não pode atrapalhar a conexão
      console.error(`[MIRA] não li o perfil de @${dono}:`, e.message);
    }
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

  // Um connect() que ainda não respondeu não pode ganhar um irmão: seria outra
  // conexão de verdade pedindo outra assinatura, e as duas contariam pro limite.
  // O teto de 2 min é a saída de emergência pro caso de o connect() nunca
  // responder — sem ele, um único travamento deixaria a live sem reconectar.
  const CONNECT_TRAVADO_MS = 2 * 60 * 1000;

  // Esperar a live começar agora é de graça (ver o bloco no topo do arquivo),
  // então a checagem pode ser frequente sem torrar cota: o streamer sobe e o
  // ranking aparece em menos de um minuto.
  const INTERVALO_CHECAGEM_MS = Number(process.env.INTERVALO_CHECAGEM_MS) || 30 * 1000;

  // Se as duas fontes gratuitas caírem, a alternativa seria ficar sem conectar
  // NUNCA — o que é pior do que gastar. Depois de tantas falhas seguidas a
  // gente tenta às cegas, gastando uma assinatura, e volta a perguntar depois.
  const MAX_FALHAS_CHECAGEM = 3;
  let falhasDeChecagem = 0;

  // true = tem live no ar | false = não tem | 'incerto' = não deu pra saber
  async function conferirAoVivo(connection) {
    // conexão de teste (criarConexao) não tem o método: segue o baile
    if (typeof connection.fetchIsLive !== 'function') return true;
    try {
      const vivo = await connection.fetchIsLive();
      falhasDeChecagem = 0;
      return !!vivo;
    } catch (err) {
      falhasDeChecagem++;
      console.error(`Não consegui checar se @${dono} está ao vivo ` +
        `(${falhasDeChecagem}/${MAX_FALHAS_CHECAGEM}):`, err?.message || err);
      if (falhasDeChecagem >= MAX_FALHAS_CHECAGEM) {
        falhasDeChecagem = 0;
        registrarDiagnostico('assinatura',
          'As fontes gratuitas de "está ao vivo?" falharam seguidas vezes. ' +
          'Vou tentar conectar às cegas desta vez, o que gasta uma assinatura.');
        return true;
      }
      return 'incerto';
    }
  }

  // Nada a conectar: remarca a próxima pergunta sem ter gasto assinatura
  // nenhuma. Isto é o caminho normal quando o streamer não está transmitindo,
  // e ele tem que ser barato — é nele que a live passa a maior parte do dia.
  function aguardarLiveComecar(motivo, recado, espera) {
    ultimaTentativa = { em: Date.now(), ok: false, motivo, recado };
    // "streamer offline" não é falha de conexão: zerar aqui evita que o painel
    // mostre milhares de "tentativas" pra uma live que simplesmente não subiu.
    tentativasSeguidas = 0;
    if (!disconnectedSince) disconnectedSince = Date.now();
    agendarReconexao(espera, motivo === 'offline' ? 'streamer fora do ar' : 'checagem inconclusiva');
  }

  function esperaDaChecagem(multiplicador) {
    const cheia = INTERVALO_CHECAGEM_MS * (multiplicador || 1);
    return Math.round(cheia * (0.6 + Math.random() * 0.4));
  }

  function startTikTokConnection() {
    cancelarReconexao();
    if (conectando && Date.now() - conectandoDesde < CONNECT_TRAVADO_MS) {
      // Voltar sem remarcar nada mataria a cadeia: se esse connect() nunca
      // responder, ninguém mais tentaria. Remarca curto e sai.
      agendarReconexao(15000, 'esperando a tentativa anterior responder');
      return;
    }
    conectando = true;
    conectandoDesde = Date.now();
    // Rede de segurança: um connect() que nunca responde não cai no .catch, e
    // o vigia só age com a live JÁ no ar — ou seja, ninguém remarcaria a
    // próxima tentativa e a live ficaria parada pra sempre. Este agendamento
    // sai de cena sozinho assim que o connect() responde, pra um lado ou pro
    // outro, então não aparece no log.
    agendarReconexao(CONNECT_TRAVADO_MS + 5000, 'connect sem resposta', true);

    const myId = ++connectionCounter;
    const connection = criarConexao
      ? criarConexao(dono)
      : new ConnectionClass(dono, { signApiKey: process.env.EULERSTREAM_API_KEY });
    currentConnection = connection;

    // A pergunta barata vem ANTES da cara: o connect() só sai se o TikTok
    // confirmar que existe live no ar pra assinar.
    conferirAoVivo(connection).then(aoVivo => {
      if (aoVivo === false) {
        conectando = false;
        aguardarLiveComecar('offline',
          'O streamer não está ao vivo agora. Assim que subir, conecta sozinho.',
          esperaDaChecagem());
        return null;
      }
      if (aoVivo === 'incerto') {
        conectando = false;
        aguardarLiveComecar('erro',
          'Não consegui confirmar se a live está no ar. Tentando de novo em instantes.',
          esperaDaChecagem(1 + falhasDeChecagem));
        return null;
      }
      return connection.connect();
    }).then(state => {
      if (state === null) return;   // não tinha live pra conectar
      conectando = false;
      cancelarReconexao();   // desarma a rede de segurança: conectou
      console.log(`Conectado à live de @${dono} (roomId ${state.roomId}) [conn #${myId}]`);
      activeConnectionId = myId;
      lastEventAt = Date.now();
      disconnectedSince = null;
      // Se já estava "ao vivo" (foi só uma reconexão rápida), mantém a mesma
      // sessão rodando — só abre uma sessão nova quando a live tinha mesmo
      // sido dada como encerrada.
      ultimaTentativa = { em: Date.now(), ok: true, motivo: 'conectado', recado: '' };
      tentativasSeguidas = 0;
      guardarPerfilDoStreamer(state.roomInfo);
      if (!liveOnline) {
        liveOnline = true;
        db.markLiveOnline();
        broadcastLiveStatus();
      }
    }).catch(err => {
      conectando = false;
      tentativasSeguidas++;
      ultimaTentativa = { em: Date.now(), ok: false, ...classificarFalha(err) };
      console.error('Erro ao conectar na live:', err?.message || err);

      // Falha de assinatura não é queda de rede: a rede pode estar ótima e a
      // live não conectar porque o assinador recusou (limite estourado, por
      // exemplo). Sem separar os dois, isso vira "sei lá, não conecta".
      if (assinatura.ehErroDeAssinatura(err)) {
        const recado = assinatura.explicar(err);
        console.error('[ASSINATURA] ' + recado);
        registrarDiagnostico('assinatura', recado);
      }

      if (!disconnectedSince) disconnectedSince = Date.now();
      agendarReconexao(esperaDaTentativa(err), `${tentativasSeguidas}ª falha seguida`);
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

      // O linkMicBattle TAMBÉM traz os exércitos, e é ele quem define o
      // meuUserId. Preencher aqui resolve a ordem de chegada de uma vez.
      aproveitarExercitoGuardado();
      guardarContribuintes(data);

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
          }, fimPrevisto(data.battleSettings), {
            meuTimeId: meuTime.teamId,
            timeRivalId: timeRival.teamId,
            // 2v2 e 1v2 são o mesmo caminho: o que muda é o tamanho dos times
            formato: `${meuTime.membros.length}v${timeRival.membros.length}`
          });

          const comoE = `${meuTime.membros.length}v${timeRival.membros.length}`;
          console.log(`Batalha ${comoE} começou contra ${rivais.map(nomeDe).join(' + ')}`);
          broadcastBattles();
          return;
        }

        const rivais = anfitrioes.filter(a => !souEu(a));
        if (!rivais.length) return;

        // ---- 1v1 ----
        if (anfitrioes.length <= 2) {
          const adversario = rivais[0];
          db.iniciarBatalha(battleId, {
            uniqueId: adversario.displayId || adversario.userId,
            nickname: nomeDe(adversario),
            avatar: adversario.avatar
          }, fimPrevisto(data.battleSettings), { formato: '1v1' });
          console.log(`Batalha começou contra ${nomeDe(adversario)}`);
          broadcastBattles();
          return;
        }

        // ---- TODOS CONTRA TODOS (1v1v1, 1v1v1v1) ----
        // Isto era jogado fora com um console.log. O Borba faz PK em grupo com
        // frequência, e a batalha inteira sumia do histórico.
        //
        // Aqui não existe "o adversário": são vários, cada um por si. Por isso
        // o oponente registrado é o conjunto, e o placar se compara com o
        // MELHOR deles (ver o linkMicArmies e o fim da batalha).
        if (!eu) {
          console.log(`Batalha de ${anfitrioes.length} anfitriões sem mim: ignorada`);
          return;
        }
        db.iniciarBatalha(battleId, {
          uniqueId: 'todos:' + rivais.map(r => r.userId).slice().sort().join('+'),
          nickname: rivais.map(nomeDe).join(' · '),
          avatar: rivais[0].avatar
        }, fimPrevisto(data.battleSettings), {
          formato: Array(anfitrioes.length).fill('1').join('v'),
          rivaisIds: rivais.map(r => r.userId)
        });
        console.log(`Batalha ${Array(anfitrioes.length).fill('1').join('v')} `
          + `começou contra ${rivais.map(nomeDe).join(', ')}`);
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
          // battleResult é um mapa userId -> { result, score }
          const resultados = data.battleResult || {};
          const meu = meuUserId ? resultados[meuUserId] : null;
          if (meu) {
            veredito = RESULTADO[Number(meu.result)];
            meuScore = Number(meu.score) || 0;
          }
          // O MELHOR dos outros. Em 1v1 é o único que tem; num 1v1v1 é quem
          // decide se você ganhou — pegar "o primeiro que não é você" dava
          // vitória fácil contra quem ficou em último.
          const outros = Object.entries(resultados)
            .filter(([uid]) => uid !== meuUserId)
            .map(([, r]) => Number(r && r.score) || 0);
          if (outros.length) scoreRival = Math.max(...outros);
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
        const pontos = uid => Number(armies[uid]?.hostscore) || 0;

        // Quem são os outros: no todos-contra-todos vem da lista guardada na
        // abertura; no 1v1 é simplesmente quem não sou eu.
        const outros = (emCurso.rivaisIds && emCurso.rivaisIds.length)
          ? emCurso.rivaisIds.filter(uid => armies[uid])
          : entradas.map(([uid]) => uid).filter(uid => uid !== meuUserId);
        if (!outros.length) return;

        meuPlacar = pontos(meuUserId);
        // o placar que vale é o do líder entre eles
        placarRival = Math.max(...outros.map(pontos));
      }

      const atual = db.atualizarPlacarBatalha(battleId, meuPlacar, placarRival);
      if (atual) emitir('battle_live', atual);
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
      if (item) emitir('tropa_add', item);
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
    // Nome forte de item. Os padrões de PALAVRAS_DA_CARTA foram feitos pra ler
    // FRASE do TikTok ("got 1 no. 2 booster"); soltos em cima de bytes crus ou
    // de JSON inteiro eles casam com lixo — uma URL de avatar terminada em
    // "idc=no1a" já virou "raio 1x". Aqui só vale nome forte.
    //
    // Declarado ANTES das duas sondas que o usam: ele estava 118 linhas depois
    // do primeiro uso e só funcionava porque a função que o chama roda depois
    // da subida. Zona morta de `const` já me derrubou duas vezes neste arquivo.
    const NOME_FORTE = new RegExp(
      'stun_?hammer|vault_?glove|boosting_?glove|glove|hammer' +
      '|smoke_?card|extra_?time|critical_?strike|potion_?card|wave_?card' +
      '|power_?up|booster|card_?name|card_?award', 'i');

    // ---------- JANELA DO PRÊMIO ----------
    // Um prêmio chega sem dizer o item. Se o TikTok conta isso pra alguém, é numa
    // mensagem que chega por perto — então aqui a gente grava TUDO que passar
    // logo depois, sem filtro de tipo nenhum, e marca o que cheirar a item.
    const JANELA_MS = 30000;
    const LIMITE_DE_JANELAS = 6;
    const TETO_JSON = 6000;        // por mensagem (sem avatar, cabe muita coisa)
    const TETO_JSON_BARULHO = 240; // tipos que a gente ja conhece de cor
    const PEDACO = 300;            // uma linha do diagnostico
    const QUANTAS_ANTES = 15;

    // Tipos que enchem a live e ja foram lidos mil vezes. NAO ficam de fora:
    // so aparecem encurtados, pra nao empurrar o resto pra fora do buffer.
    const BARULHO = new Set([
      'WebcastRoomUserSeqMessage', 'WebcastChatMessage', 'WebcastGiftMessage',
      'WebcastLikeMessage', 'WebcastMemberMessage', 'WebcastSocialMessage',
      'WebcastEmoteChatMessage', 'WebcastRoomMessage'
    ]);

    let janelaAte = 0;
    let janelaNum = 0;
    let tiposJaDespejados = new Set();

    // Anel das ultimas mensagens. Guarda a referencia, nao o texto: so vira
    // JSON quando um premio acontece, entao nao custa nada na live normal.
    const ultimasMensagens = [];

    // Avatar e 80% do peso de qualquer mensagem do TikTok: sao 6 URLs assinadas
    // por pessoa. Tirando eles, uma mensagem de 18 mil chars vira uma que cabe
    // inteira no despejo. cardImage NAO entra aqui de proposito -- se a carta
    // tiver imagem propria, o nome do item pode estar no caminho dela.
    const SEM_GRACA = new Set(['avatarThumb', 'avatarLarge', 'avatarMedium', 'avatar']);

    function jsonDaMensagem(d) {
      try {
        return JSON.stringify(d, (k, v) => {
          if (SEM_GRACA.has(k)) return '[avatar cortado]';
          return typeof v === 'bigint' ? String(v) : v;
        });
      } catch (e) {
        return '(nao deu pra serializar: ' + e.message + ')';
      }
    }

    // Todo texto legivel da mensagem, em qualquer profundidade. Diferente da
    // varredura do estoque, aqui nao filtra nada: e investigacao, nao decisao.
    function textosParaInvestigar(obj, achados = [], nivel = 0) {
      if (!obj || typeof obj !== 'object' || nivel > 8) return achados;
      if (ArrayBuffer.isView(obj)) return achados;
      for (const [chave, valor] of Object.entries(obj)) {
        if (SEM_GRACA.has(chave)) continue;   // 6 URLs por pessoa, zero conteudo
        if (typeof valor === 'string') {
          const t = valor.trim();
          if (t && t.length <= 160 && !/^https?:/i.test(t)) achados.push(chave + '=' + t);
        } else if (valor && typeof valor === 'object') {
          textosParaInvestigar(valor, achados, nivel + 1);
        }
        if (achados.length > 400) break;
      }
      return achados;
    }

    function despejarMensagem(marca, tipo, dados) {
      const textos = textosParaInvestigar(dados);
      // NOME_FORTE e nao tipoPelasPalavras: os padroes de contagem ("no. 2",
      // "top 3") so fazem sentido dentro da frase da carta. Soltos na sonda,
      // casaram com "defaultPattern=No. 3" de um LikeMessage (posicao no
      // ranking de espectador) e com "idc=no1a" no fim de uma URL de avatar.
      const comItem = textos.filter(t => NOME_FORTE.test(t));

      if (comItem.length) {
        registrarDiagnostico('premio', `  [${marca}] >>> ${tipo} CITA ITEM <<<`);
        comItem.slice(0, 8).forEach(t => registrarDiagnostico('premio', '      ' + t));
      }

      // JSON inteiro UMA vez por tipo em cada janela: repetir o mesmo tipo dez
      // vezes so empurraria o que importa pra fora do buffer.
      if (tiposJaDespejados.has(tipo)) {
        registrarDiagnostico('premio', `  [${marca}] ${tipo} (tipo ja despejado nesta janela)`);
        return;
      }
      tiposJaDespejados.add(tipo);

      const teto = BARULHO.has(tipo) ? TETO_JSON_BARULHO : TETO_JSON;
      const json = jsonDaMensagem(dados);
      registrarDiagnostico('premio',
        `  [${marca}] ${tipo} -- JSON (${json.length} chars${json.length > teto ? ', cortado' : ''})`);
      for (let i = 0; i < json.length && i < teto; i += PEDACO) {
        registrarDiagnostico('premio', '    ' + json.slice(i, i + PEDACO));
      }
      if (json.length > teto) {
        registrarDiagnostico('premio', `    ...faltaram ${json.length - teto} chars`);
      }
    }

    // O premio e A mensagem do caso: vai inteira, sem teto nenhum.
    function despejarPremioInteiro(dados) {
      const json = jsonDaMensagem(dados);
      registrarDiagnostico('premio',
        `  >>> O PREMIO, INTEIRO e sem avatar (${json.length} chars) <<<`);
      for (let i = 0; i < json.length; i += PEDACO) {
        registrarDiagnostico('premio', '    ' + json.slice(i, i + PEDACO));
      }
    }

    function abrirJanelaDoPremio(quem, dadosDoPremio) {
      if (janelaNum >= LIMITE_DE_JANELAS) return;
      janelaNum++;
      janelaAte = Date.now() + JANELA_MS;
      tiposJaDespejados = new Set();

      registrarDiagnostico('premio',
        `===== JANELA ${janelaNum}/${LIMITE_DE_JANELAS}: "${quem}" ganhou algo =====`);
      if (dadosDoPremio) despejarPremioInteiro(dadosDoPremio);

      // e pergunta pra API HTTP, que é onde o item aparece — mas só enquanto
      // a comemoração do prêmio está passando
      perguntarNaJanelaDoPremio(quem);

      // ANTES: o item pode ser anunciado antes do aviso de premio, e a sonda
      // velha so olhava pra frente.
      registrarDiagnostico('premio',
        `----- as ${ultimasMensagens.length} mensagens ANTES do premio -----`);
      const agora = Date.now();
      ultimasMensagens.forEach(m => {
        despejarMensagem('-' + ((agora - m.em) / 1000).toFixed(1) + 's', m.tipo, m.dados);
      });

      // e os quadros CRUS de antes, que mostram ate o que foi descartado
      quadrosRecentes.forEach(b => esmiucarQuadro('cru-', b));

      registrarDiagnostico('premio',
        `----- e os ${JANELA_MS / 1000}s DEPOIS -----`);
    }

    connection.on('decodedData', (metodo, decodificada) => {
      if (myId !== activeConnectionId) return;
      const tipo = decodificada?.type || metodo;
      const dados = decodificada?.data ?? decodificada;

      // dentro da janela: despeja. fora dela: so guarda pro proximo premio.
      if (Date.now() <= janelaAte) {
        despejarMensagem('+', tipo, dados);
        return;
      }
      ultimasMensagens.push({ tipo, dados, em: Date.now() });
      if (ultimasMensagens.length > QUANTAS_ANTES) ultimasMensagens.shift();
    });


    // ---------- SONDA HTTP: O ITEM DO PRÊMIO ----------
    // O print de um site que consegue puxar o item mostra campos em
    // snake_case (`card_award_name`, `visible_score`, `top_fans`), e o
    // websocket entrega camelCase. Aquilo veio da API HTTP do webcast — e
    // trazia "got 1 no. 2 booster" escrito por extenso.
    //
    // A janela é curta: quem mandou o print disse que só aparece "no período
    // de comemoração", ou seja, enquanto a animação do prêmio está rodando.
    // Por isso a consulta sai NA HORA do prêmio e se repete umas vezes logo
    // depois, em vez de uma vez só.
    //
    // Sem cookie de ninguém: `getJsonObjectFromWebcastApi` assina pelo Euler,
    // o mesmo caminho que o conector já usa pra abrir o socket.
    // O room/info/ é o do print (visible_score, top_fans e
    // with_ecommerce_permission são campos dele) E é o único que o conector
    // busca SEM assinatura — ou seja, o único garantidamente de graça. Ele
    // tem orçamento próprio e folgado, porque não custa nada.
    const CAMINHO_GRATIS = 'room/info/';
    // Estes dois são palpite meu e podem exigir assinatura paga, então andam
    // num orçamento à parte. Antes os três dividiam um teto de 8: o primeiro
    // prêmio gastava 12 (3 caminhos x 4 tentativas) e as janelas 2 a 6 do log
    // de 22/09 não fizeram UMA consulta.
    // Nao sobrou palpite nenhum. O linkmic/battle_info/ deu 404 (rota nao
    // existe) e o ranklist/online_audience/ respondeu, em 122 chars,
    // {"message":"User doesn't login","status_code":20003}. O conector so
    // conhece gift/list/, room/info/ e user/room/.
    const CAMINHOS_PALPITE = [];
    // Uma tentativa so. As cinco de antes serviram pra provar que o campo
    // nao aparece em momento nenhum da comemoracao (22/09): as cinco
    // responderam 47k chars com o link_mic certo e sem card_award_*.
    // Fica uma, barata, caso o TikTok volte a servir o campo.
    const TENTATIVAS_APOS_PREMIO = [2500];
    let sondasGratis = 0;
    let sondasPalpite = 0;
    const LIMITE_GRATIS = 40;    // 6 janelas x 5 tentativas, com folga
    const LIMITE_PALPITE = 1;    // uma vez so, e so
    // Caminho que respondeu "precisa de plano pago" nao volta a ser tentado.
    // Antes isso desligava a sonda INTEIRA, entao um palpite pago matava junto
    // o room/info/, que e de graca.
    const caminhosProibidos = new Set();

    // Todo texto da resposta que cheire a nome de carta, com o CAMINHO até
    // ele: saber que existe não basta, eu preciso saber onde ler.
    function caminhosComItem(obj, caminho = '$', achados = [], nivel = 0) {
      if (!obj || typeof obj !== 'object' || nivel > 9 || achados.length > 40) return achados;
      for (const [chave, valor] of Object.entries(obj)) {
        const aqui = caminho + '.' + chave;
        if (typeof valor === 'string') {
          if (!valor || valor.length > 200) continue;
          // o nome do campo já é pista: card_award_name foi o do print
          const chaveInteressa = /card|award|booster|glove|power/i.test(chave);
          const valorInteressa = NOME_FORTE.test(valor) || tipoPelasPalavras(valor);
          if (chaveInteressa || valorInteressa) achados.push(aqui + ' = ' + valor);
        } else if (valor && typeof valor === 'object') {
          caminhosComItem(valor, aqui, achados, nivel + 1);
        }
      }
      return achados;
    }

    // SEM ASSINAR PRIMEIRO. O conector busca o room/info/ com signRequest
    // false, e só o gift/list/ com true — ou seja, o caminho mais provável de
    // ter o item nunca precisou de assinatura. A sonda pedia tudo assinado,
    // o Euler cobrou o plano Business, e eu reportei como se fosse o TikTok
    // exigindo. Era eu forçando.
    //
    // A assinatura só entra se a chamada limpa for recusada por autenticação.
    async function pedir(cliente, caminho) {
      const params = { ...(cliente.clientParams || {}), room_id: cliente.roomId };
      try {
        return await cliente.getJsonObjectFromWebcastApi(caminho, params, false);
      } catch (e) {
        const recado = (e && e.message) || '';
        // recusa por falta de assinatura: aí sim vale tentar assinado
        if (!/sign|403|401|unauthor/i.test(recado)) throw e;
        registrarDiagnostico('premio',
          `  HTTP ${caminho}: sem assinatura nao passou (${recado.slice(0, 60)}), tentando assinado`);
        return await cliente.getJsonObjectFromWebcastApi(caminho, params, true);
      }
    }

    async function perguntarAoHttp(quem, rodada) {
      if (sondasGratis >= LIMITE_GRATIS) return;
      const cliente = connection && connection.webClient;
      if (!cliente || typeof cliente.getJsonObjectFromWebcastApi !== 'function') {
        registrarDiagnostico('premio',
          'sonda HTTP DESLIGADA: este conector não expõe o webClient');
        sondasGratis = LIMITE_GRATIS;
        return;
      }

      // o de graca SEMPRE; os palpites so enquanto o troco deles durar
      const desta = [CAMINHO_GRATIS].concat(
        sondasPalpite < LIMITE_PALPITE ? CAMINHOS_PALPITE : []);

      for (const caminho of desta) {
        if (caminhosProibidos.has(caminho)) continue;
        if (caminho === CAMINHO_GRATIS) {
          if (sondasGratis >= LIMITE_GRATIS) return;
          sondasGratis++;
        } else {
          if (sondasPalpite >= LIMITE_PALPITE) continue;
          sondasPalpite++;
        }
        try {
          const resposta = await pedir(cliente, caminho);

          const achados = caminhosComItem(resposta);
          const bruto = JSON.stringify(resposta);
          if (achados.length) {
            registrarDiagnostico('premio',
              `  >>> HTTP ${caminho} (+${rodada}ms) TEM O ITEM <<< ${achados.length} campo(s)`);
            achados.slice(0, 12).forEach(a =>
              registrarDiagnostico('premio', '      ' + a.slice(0, 220)));
          } else {
            // NAO basta dizer "nao achei". O print poe o item em
            // data.link_mic.card_award_info: se nem link_mic vier, a rota esta
            // errada; se vier link_mic sem card_award_*, a rota esta certa e o
            // que falta e o momento. Sem este retrato eu nao sei qual dos dois.
            const d = (resposta && resposta.data) || {};
            const lm = d.link_mic || d.linkMic;
            const retrato = lm
              ? 'link_mic tem: ' + Object.keys(lm).join(',')
              : 'SEM link_mic | data tem: ' + Object.keys(d).slice(0, 30).join(',');
            registrarDiagnostico('premio',
              `  HTTP ${caminho} (+${rodada}ms): respondeu ${bruto.length} chars, ` +
              'nenhum campo de carta | ' + retrato);
            // resposta curta demais e quase sempre envelope de erro
            if (bruto.length < 600) {
              registrarDiagnostico('premio', '      corpo inteiro: ' + bruto);
            }
          }
        } catch (e) {
          const recado = (e && e.message) || '';
          // O plano do Euler assina o websocket de graça mas cobra pra assinar
          // chamada à API. Isso não melhora tentando de novo: desliga a sonda
          // e diz o porquê UMA vez, em vez de repetir 12 linhas por prêmio.
          if (/Business plan|requires a .*plan/i.test(recado)) {
            // SO este caminho. Desligar a sonda toda era o que matava o
            // room/info/, que nem precisa de assinatura.
            caminhosProibidos.add(caminho);
            registrarDiagnostico('premio',
              `  HTTP ${caminho} DESLIGADO: o Euler cobra plano Business pra ` +
              'assinar este caminho. Os outros continuam.');
            continue;
          }
          registrarDiagnostico('premio',
            `  HTTP ${caminho} (+${rodada}ms) falhou: ${recado}`);
        }
      }
    }

    function perguntarNaJanelaDoPremio(quem) {
      TENTATIVAS_APOS_PREMIO.forEach(atraso => {
        const t = setTimeout(() => {
          perguntarAoHttp(quem, atraso).catch(e =>
            registrarDiagnostico('premio', '  sonda HTTP estourou: ' + (e && e.message)));
        }, atraso);
        if (t.unref) t.unref();
      });
    }

    // ---------- SONDA CRUA (o que o conector joga fora) ----------
    // O tiktok-live-connector descarta toda mensagem cujo tipo o
    // tiktok-live-proto nao conhece -- ela nunca chega no `decodedData`:
    //
    //     if (!hasProtoName(message.method)) continue;
    //
    // Entao a sonda de cima e cega, POR CONSTRUCAO, pros tipos que a
    // biblioteca nao conhece. Como ela corre atras do TikTok e nao na frente,
    // um aviso publico novo cai bem ai. Aqui a gente pega o quadro cru do
    // websocket e decodifica na mao, pra ver o que foi jogado fora.
    const zlib = require('zlib');
    const caminho = require('path');

    function abrirProto() {
      // o pacote nao exporta os subcaminhos, entao vou no arquivo direto
      const tentativas = [
        caminho.join(__dirname, 'node_modules/tiktok-live-proto/dist/node/v3.js'),
        caminho.join(process.cwd(), 'node_modules/tiktok-live-proto/dist/node/v3.js')
      ];
      for (const t of tentativas) {
        try { return require(t); } catch (e) { /* tenta o proximo */ }
      }
      return null;
    }
    const proto = abrirProto();

    // mesmo problema do abrirProto: `require('./protocru')` resolveria
    // relativo a quem chama, e ha teste que roda este bloco de outra pasta
    function abrirProtocru() {
      const tentativas = [
        caminho.join(__dirname, 'protocru.js'),
        caminho.join(process.cwd(), 'protocru.js')
      ];
      for (const t of tentativas) {
        try { return require(t); } catch (e) { /* tenta o proximo */ }
      }
      return null;
    }
    const protocru = abrirProtocru();
    if (!proto) {
      registrarDiagnostico('premio',
        'sonda crua DESLIGADA: nao achei o tiktok-live-proto pra decodificar o quadro');
    }

    // As mensagens dentro de um quadro do websocket, SEM filtro de tipo.
    function mensagensDoQuadro(bytes) {
      if (!proto) return [];
      try {
        const quadro = proto.WebcastPushFrame.decode(bytes);
        let carga = quadro.payload;
        if (!carga || !carga.length) return [];
        // gzip: 1f 8b 08
        if (carga.length > 2 && carga[0] === 0x1f && carga[1] === 0x8b && carga[2] === 0x08) {
          carga = zlib.gunzipSync(Buffer.from(carga));
        }
        return proto.ProtoMessageFetchResult.decode(Buffer.from(carga)).messages || [];
      } catch (e) {
        return [];
      }
    }

    // Texto legivel dentro do protobuf cru. Funciona mesmo sem decodificador:
    // string em protobuf vai como ASCII no meio dos bytes.
    // corridas de 4+ caracteres imprimíveis (espaço até "~" é o ASCII visível)
    const LEGIVEL = /[ -~]{4,}/g;
    function textosCrus(bytes) {
      try {
        return Buffer.from(bytes).toString('latin1').match(LEGIVEL) || [];
      } catch (e) { return []; }
    }

    // URL é prova mais fraca (o nome pode estar no caminho da imagem do card,
    // que vale — mas também pode ser coincidência), então vai marcada.
    const ehUrl = t => /https?:|x-signature|refresh_token/i.test(t);

    function itensNoCru(textos) {
      const achados = [];
      for (const t of textos) {
        const m = t.match(NOME_FORTE);
        if (!m) continue;
        achados.push(ehUrl(t) ? `${m[0]} (em URL: ...${t.slice(-60)})` : t.slice(0, 100));
        if (achados.length >= 6) break;
      }
      return [...new Set(achados)];
    }

    // A biblioteca sabe decodificar este tipo?
    const conhecido = metodo => !!(proto && proto[metodo] && typeof proto[metodo].decode === 'function');

    const quadrosRecentes = [];      // anel dos quadros crus, pro "antes"
    const tiposJaVistos = new Set();    // censo: cada tipo e anunciado uma vez
    const tiposDescartados = new Set(); // ...destes o conector nao sabe nada
    let ultimoCenso = 0;
    let primeiroQuadro = 0;
    let censoFechado = false;
    const PRAZO_DO_CENSO = 90000;

    // ---- campos que o proto instalado NAO conhece ----
    // Decodificar e re-codificar: o que nao volta, a biblioteca nao sabe ler.
    // Mensagem grande e cara de conferir, entao cada TIPO e conferido uma vez
    // -- menos a carta de PK, que e o que interessa e vai toda vez.
    const perdaVerificada = new Set();
    const perdaJaDita = new Set();
    let perdasConferidas = 0;
    const LIMITE_PERDA = 300;

    function conferirCamposPerdidos(marca, metodo, carga) {
      if (!proto || !protocru || !carga || !carga.length) return;
      if (perdasConferidas >= LIMITE_PERDA) return;
      const sempre = metodo === 'WebcastLinkMicBattleItemCard';
      if (!sempre && perdaVerificada.has(metodo)) return;
      perdaVerificada.add(metodo);
      perdasConferidas++;

      let r, qual = '';
      try {
        r = protocru.camposQueOProtoNaoConhece(proto[metodo], Buffer.from(carga));
        // De qual mensagem veio? Na janela do premio chega a carta usada E o
        // premio, as duas com o mesmo `method`. Sem o msgType eu nao sei em
        // qual das duas o campo apareceu -- e essa era a duvida inteira.
        const d = proto[metodo].decode(Buffer.from(carga));
        if (d && d.msgType !== undefined) qual = ` msgType=${d.msgType}`;
      } catch (e) { if (!r) return; }
      if (!r || r.erro || !r.perdidos || !r.perdidos.length) return;

      const assinatura = metodo + qual + '|' + r.perdidos.map(p => p.caminho).join(',');
      if (perdaJaDita.has(assinatura)) return;
      perdaJaDita.add(assinatura);

      registrarDiagnostico('premio',
        `  [${marca}] >>> CAMPO QUE O PROTO NAO CONHECE em ${metodo}${qual} <<< ` +
        `${r.perdidos.length} campo(s)`);
      r.perdidos.slice(0, 12).forEach(p => {
        registrarDiagnostico('premio',
          `      ${p.caminho} (fio ${p.fio}) = ${p.valor}`.slice(0, 300));
        // o conteudo do campo desconhecido, aberto
        if (p.dentro) registrarDiagnostico('premio',
          `        dentro: ${p.dentro}`.slice(0, 900));
      });
    }

    function esmiucarQuadro(marca, bytes) {
      mensagensDoQuadro(bytes).forEach(m => {
        const metodo = m.method || '(sem metodo)';
        const sabe = conhecido(metodo);
        // antes de qualquer coisa: o tipo e conhecido mas veio campo a mais?
        if (sabe) conferirCamposPerdidos(marca, metodo, m.payload);
        const textos = textosCrus(m.payload || []);
        const achados = itensNoCru(textos);

        if (achados.length) {
          registrarDiagnostico('premio',
            (`  [${marca}] >>> CRU: ${metodo} CITA ITEM <<< ` +
             `${sabe ? '' : '(tipo DESCARTADO pelo conector) '}` +
             achados.join(' | ')).slice(0, 400));
          return;
        }
        if (!sabe) {
          // o achado mais valioso: uma mensagem que a biblioteca joga no lixo
          const limpos = textos.filter(t => !ehUrl(t)).map(t => t.slice(0, 60));
          registrarDiagnostico('premio',
            `  [${marca}] CRU: ${metodo} -- TIPO DESCARTADO PELO CONECTOR, ` +
            `${(m.payload || []).length} bytes :: ${limpos.slice(0, 8).join(' | ').slice(0, 240)}`);
        }
      });
    }

    connection.on('websocketData', bytes => {
      if (myId !== activeConnectionId) return;

      if (Date.now() <= janelaAte) { esmiucarQuadro('cru+', bytes); return; }

      quadrosRecentes.push(bytes);
      if (quadrosRecentes.length > QUANTAS_ANTES) quadrosRecentes.shift();

      // CENSO: fora da janela, no maximo 1 quadro por segundo, so pra anunciar
      // tipo novo. E de graca saber que o TikTok manda algo que a gente perde.
      const agora = Date.now();
      if (agora - ultimoCenso < 1000) return;
      ultimoCenso = agora;
      mensagensDoQuadro(bytes).forEach(m => {
        const metodo = m.method || '(sem metodo)';
        if (tiposJaVistos.has(metodo)) return;
        tiposJaVistos.add(metodo);
        if (!conhecido(metodo)) {
          tiposDescartados.add(metodo);
          registrarDiagnostico('premio',
            `CENSO: o TikTok manda "${metodo}" e o conector DESCARTA ` +
            `(sem decodificador). Texto cru: ` +
            textosCrus(m.payload || []).filter(t => !ehUrl(t))
              .map(t => t.slice(0, 60)).slice(0, 8).join(' | ').slice(0, 240));
        }
      });

      // Fechamento do censo: sem isto, "não apareceu nada" fica ambíguo entre
      // "não tem tipo descartado" e "o log foi cortado". Uma linha só, no fim.
      if (!primeiroQuadro) primeiroQuadro = agora;
      if (!censoFechado && agora - primeiroQuadro > PRAZO_DO_CENSO) {
        censoFechado = true;
        registrarDiagnostico('premio',
          `CENSO FECHADO (${PRAZO_DO_CENSO / 1000}s de live): ${tiposJaVistos.size} tipos vistos, ` +
          (tiposDescartados.size
            ? `${tiposDescartados.size} DESCARTADOS pelo conector -> ${[...tiposDescartados].join(', ')}`
            : 'nenhum descartado - a biblioteca conhece tudo que passou aqui'));
      }
    });

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

      const d = decodificada?.data ?? decodificada;
      const ehPremio = Number(d?.msgType) === PK_MSG_GANHOU;

      // Num PK em grupo a sala recebe as cartas de TODOS os anfitrioes. No log
      // de 22/09 foram 11 cartas de outros hosts em 12: cada uma comia uma das
      // 40 vagas e despejava o JSON inteiro, e o PREMIO -- a unica mensagem
      // que eu preciso ver -- corria o risco de chegar com o teto ja gasto.
      //
      // Carta de outro anfitriao sai de graca aqui: o handler de baixo ja
      // escreve uma linha "IGNORADO" pra ela, entao nem precisa de dump.
      if (!ehPremio) {
        const mapa = PK_CARTA_POR_MSGTYPE[d?.msgType];
        const carta = mapa && d?.[mapa.campo];
        if (carta && ehDoNossoLado(carta) === false) return;
        if (sondaPowerUp >= LIMITE_SONDA) return;
      }
      sondaPowerUp++;

      let json;
      try {
        json = JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? String(v) : v));
      } catch (e) { return; }

      const rotulo = CARTAS_PK[d?.msgType] || `msgType desconhecido (${d?.msgType})`;
      const selo = sondaPowerUp > LIMITE_SONDA
        ? 'PREMIO fora do teto' : `${sondaPowerUp}/${LIMITE_SONDA}`;
      registrarDiagnostico('powerup', `[${selo}] CARTA DE PK → ${rotulo}`);
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
      // O QUE A VARREDURA ENXERGA. Um print de outra ferramenta mostrou a frase
      // "got 1 no. 2 booster" solta no payload; isto aqui mostra, em live real,
      // quais frases o nosso lado acha e o que ele decidiu com elas.
      frasesDaMensagem(d).slice(0, 8).forEach((fr, i) => {
        registrarDiagnostico('powerup', '  frase[' + i + '] "' + fr + '"');
      });
      const decidido = varreduraDaCarta(d);
      registrarDiagnostico('powerup', '  VARREDURA -> ' + (decidido
        ? decidido.tipo + (decidido.qtd ? ' x' + decidido.qtd : '') + ' (de "' + decidido.frase + '")'
        : 'nenhuma frase de item no payload'));

      registrarDiagnostico('powerup', (json || '').slice(0, 3000));
      console.log(`[POWERUP] ${rotulo} :: ${(json || '').slice(0, 2000)}`);
    });

    // ---------- QUEM É DO NOSSO LADO ----------
    // O prêmio do PK não diz de que lado a pessoa é. Quem diz é o exército —
    // e ele vem em DOIS eventos, em formatos diferentes:
    //
    //   linkMicArmies -> armies é um MAPA   { anfitriao: { userArmies } }
    //   linkMicBattle -> armies é uma LISTA [ { key, value: { userArmies } } ]
    //
    // Ler os dois não é redundância: é o conserto de um prêmio perdido em
    // produção (21/09 02:31). O Armies chegou às 02:31:18, o Battle às
    // 02:31:22 — e é o Battle que define quem somos. O Armies foi descartado
    // por chegar cedo demais, e o prêmio das 02:31:24 caiu como "lista vazia".
    // O prêmio sai quando a batalha ACABA, que é justo quando o Armies para
    // de chegar; numa reconexão no meio da batalha isso se repetiria sempre.
    function exercitoDoAnfitriao(armies, anfitriao) {
      if (!armies || !anfitriao) return null;
      if (Array.isArray(armies)) {
        const achado = armies.find(e => String(e?.key || '') === String(anfitriao));
        return achado?.value || null;
      }
      return armies[String(anfitriao)] || null;
    }

    // Devolve quantos entraram, pra quem chama poder dizer se valeu.
    function guardarContribuintes(data) {
      if (!meuUserId) {
        // Ainda não sabemos quem somos: guarda pra quando souber, em vez de
        // jogar fora. Era exatamente aqui que o exército se perdia.
        exercitosPendentes = data;
        return 0;
      }

      const battleId = String(data?.battleId || '');
      if (battleId && battleId !== batalhaDosContribuintes) {
        batalhaDosContribuintes = battleId;
        meusContribuintes = new Set();          // batalha nova, lista nova
      }

      const meu = exercitoDoAnfitriao(data?.armies, meuUserId);
      let entraram = 0;
      const lista = [];
      (meu?.userArmies || []).forEach(ua => {
        const id = String(ua?.userIdStr || ua?.userId || '');
        if (!id) return;
        lista.push({ id, nick: ua?.nickname || '?', pontos: Number(ua?.score || 0) });
        if (!meusContribuintes.has(id)) { meusContribuintes.add(id); entraram++; }
      });
      // so troca se veio exercito; um linkMicBattle de encerramento sem armies
      // nao pode apagar o que a gente ja sabia
      if (lista.length) meuExercito = lista;
      return entraram;
    }

    // O QUE A GENTE AINDA NAO SABE: qual carta cada um ganhou.
    //
    // A API nao entrega (o room/info/ traz o link_mic certo e sem
    // card_award_info; o ranklist responde "User doesn't login"). A unica
    // pista de graca e que o item parece sair da POSICAO no exercito: o icone
    // do print que o Caio mandou e `webcast-sg/top2_3_scores` e o nome e
    // "got 1 no. 2 booster".
    //
    // Isto aqui NAO decide nada e NAO grava nada -- so escreve no diagnostico
    // o rank completo junto de quem foi premiado, pra hipotese poder ser
    // conferida com varias amostras em vez de chutada com uma.
    function registrarRankDoPremio(premiados) {
      if (!meuExercito.length) return;
      const ganhou = new Set((premiados || [])
        .map(b => String(b?.user?.userId || ''))
        .filter(Boolean));
      const linhas = meuExercito.map((m, i) =>
        `    #${i + 1} ${m.pontos} pts  ${ganhou.has(m.id) ? 'GANHOU' : '  -   '}  ${m.nick}`);
      registrarDiagnostico('powerup',
        `  RANK do nosso exercito no momento do premio (${ganhou.size} premiado(s)):`);
      linhas.forEach(l => registrarDiagnostico('powerup', l));
    }

    // Chamado assim que o meuUserId fica conhecido.
    function aproveitarExercitoGuardado() {
      if (!meuUserId || !exercitosPendentes) return;
      const guardado = exercitosPendentes;
      exercitosPendentes = null;
      const entraram = guardarContribuintes(guardado);
      if (entraram) {
        registrarDiagnostico('powerup',
          `contribuintes: ${entraram} do exército que tinha chegado antes de eu saber quem sou`);
      }
    }

    // Mantém a lista de contribuintes do nosso lado. Fica separado da sonda de
    // baixo porque a sonda tem teto de logs e isto precisa rodar sempre.
    connection.on('linkMicArmies', data => {
      if (myId !== activeConnectionId) return;
      guardarContribuintes(data);
    });

    // ---------- SONDA 2: EFEITOS POR USUÁRIO (linkMicArmies) ----------
    // O linkMicArmies traz effectInfos.effectInfoList = [{type, uidList,
    // effectExtra}] — QUAL efeito está ativo em QUAIS usuários. Se viesse
    // preenchido, seria a fonte certa pra saber o que cada um ganhou.
    //
    // NÃO VEM. Confirmado 30 vezes num log de produção de 21/09: vazio em
    // todas. A sonda antiga imprimia esse vazio junto com o ranking de
    // contribuintes a cada vez — ~200 linhas repetindo o mesmo negativo, que
    // empurraram a janela do prêmio e o censo pra fora da tela no dia em que
    // eles finalmente tinham o que dizer.
    //
    // Então ela fica calada. Só fala se o effectInfoList vier PREENCHIDO, que
    // é o único caso que ainda traz informação nova. E aí fala alto.
    let efeitosVistos = 0;
    const LIMITE_EFEITOS = 10;

    connection.on('linkMicArmies', data => {
      if (myId !== activeConnectionId) return;
      if (efeitosVistos >= LIMITE_EFEITOS) return;

      const lista = data?.effectInfos?.effectInfoList || [];
      if (!lista.length) return;          // o caso de sempre: silêncio

      efeitosVistos++;
      registrarDiagnostico('powerup',
        `>>> effectInfoList APARECEU (${efeitosVistos}/${LIMITE_EFEITOS})! ` +
        `versao=${data?.effectInfos?.effectListVersion || ''} — ` +
        'este campo diz QUAL efeito está em QUEM, e nunca tinha vindo preenchido.');
      lista.forEach((ef, i) => {
        registrarDiagnostico('powerup',
          `  efeito[${i}] type="${ef?.type || ''}" uids=[${(ef?.uidList || []).join(',')}] ` +
          `extra="${(ef?.effectExtra || '').slice(0, 300)}"`);
      });
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
        // grava o que vier logo depois: e a chance de achar quem nomeia o item
        abrirJanelaDoPremio(
          premiados.map(b => b?.user?.nickName).filter(Boolean).join(', ') || '?', data);
        registrarRankDoPremio(premiados);
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
          // A PREMIAÇÃO NASCE VAZIA, SEMPRE.
          //
          // Seis amostras de produção: o aviso do prêmio vem com `tags: []`,
          // `pieces: []` e o texto genérico "Contributors got match
          // power-ups." — ele nunca diz qual carta foi.
          //
          // O que havia aqui era uma cadeia de adivinhação que acabava numa
          // varredura da MENSAGEM INTEIRA. Numa janela onde chega um USO junto
          // (e o uso, esse sim, nomeia a carta), ela etiquetava o prêmio com o
          // item do uso de outra pessoa. Item errado é pior que item vazio: o
          // streamer nem fica sabendo que tem o que corrigir.
          //
          // Quantidade também não vem — uma mensagem pode valer 2 cartas. Uma
          // entrada por premiado é o piso honesto (a tela mostra "≥N"), e quem
          // informa o item informa a quantidade junto.
          //
          // Quem preenche isto depois: a aba de power-ups (na mão) ou o USO,
          // que o TikTok confirma e o `resolverPendenteComUso` aproveita.
          if (db.registrarCartaGanha(p.uniqueId, p.nickname, p.avatar, null, p.handle, 1)) {
            mexeu = true;
            // Sem pushFeed de propósito: o feedLine() do front não conhece esses
            // tipos e renderizaria uma linha sem texto. O lugar deles é a aba.
            console.log(`[POWERUP] ${p.nickname} GANHOU power-up (item a informar)`);
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

          // O EFEITO ESTÁ CORRENDO AGORA. A carta diz quantos segundos ele
          // dura (30 na luva e no martelo, 10 no tempo — dado de produção), e
          // isso ia pro lixo. Durante a batalha é o que mais importa: saber
          // que a luva está valendo e por mais quanto tempo.
          const segundos = duracaoDoEfeito(carta);
          if (segundos > 0) {
            emitir('powerup_efeito', {
              // De QUAL batalha é este efeito. A carta costuma ser jogada no
              // fim, e o efeito de 30s passa do encerramento: sem isto a tela
              // mostraria efeito de uma batalha que já acabou.
              battleId: String(data?.battleId || ''),
              uniqueId: p.uniqueId,
              nickname: p.nickname,
              avatar: p.avatar,
              tipo: tipoUsado,
              quantos: qtdUsada,
              segundos,
              acabaEm: Date.now() + segundos * 1000
            });
          }
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
      emitir('viewer_count', { count });
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
      agendarReconexao(5000, 'queda de conexão');
    });
  }

  // Uma carta vence 5 dias depois de ganha, possivelmente sem live rolando. Este
  // tick só reavalia o estoque (getEstoqueCartas já expira o que passou do prazo)
  // e reemite pra quem estiver com a aba aberta.

  const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
  function vigia() {
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
  }

  // Traduz a falha pra algo acionável. São três coisas bem diferentes que o
  // log tratava igual, e cada uma pede uma atitude do dono.
  function classificarFalha(err) {
    const msg = String((err && err.message) || err || '');
    const nome = String((err && err.name) || '');

    if (/UserOffline|isn't online|nao esta online/i.test(nome + ' ' + msg)) {
      return { motivo: 'offline', recado: 'O streamer não está ao vivo agora. Assim que subir, conecta sozinho.' };
    }
    if (assinatura.ehErroDeAssinatura(err)) {
      return { motivo: 'assinatura', recado: assinatura.explicar(err) };
    }
    if (/Room ID|room_id/i.test(msg)) {
      return { motivo: 'arroba', recado: 'Não achei essa live. Confira se o @ está escrito exatamente como no TikTok.' };
    }
    return { motivo: 'erro', recado: msg.slice(0, 200) };
  }

  // ---------- liga e desliga ----------
  let relogios = [];

  function iniciar() {
    if (relogios.length) return;   // já está de pé
    relogios.push(setInterval(broadcastPowerUps, 5 * 60 * 1000));
    relogios.push(setInterval(vigia, 30000));
    startTikTokConnection();
  }

  // Desligar de verdade importa: sem isso, um cliente removido continuaria
  // com relógio batendo e conexão aberta no TikTok até o processo morrer.
  function parar() {
    relogios.forEach(clearInterval);
    relogios = [];
    // O timer de reconexão não é relógio: ficava de fora do clearInterval e
    // seguia ressuscitando a conexão de um cliente já fechado.
    cancelarReconexao();
    conectando = false;
    activeConnectionId = -1;
    try { if (currentConnection) currentConnection.disconnect(); } catch (e) { /* já caiu */ }
    currentConnection = null;
    liveOnline = false;
  }

  return {
    dono,
    iniciar, parar, forceReconnect, sessaoReiniciada,
    broadcastRanking, broadcastBattles, broadcastPowerUps,
    broadcastGlobalStats, broadcastLiveStatus,
    estaOnline: () => liveOnline,
    // o que contar pro painel sobre a conexão desta live
    estadoDaConexao: () => ({
      online: liveOnline,
      ligado: relogios.length > 0,
      tentativasSeguidas,
      ultimaTentativa,
      // nasce com a hora da criação do motor: só quer dizer algo com a live no ar
      ultimoEventoEm: lastEventAt
    }),
    feed: () => liveFeed,
    diagnostico: () => diagnostico
  };
}

module.exports = criarLive;
