// ============================================================================
// RANKING DA CAMPANHA — junta as lives de cada sniper com as indicações
// ----------------------------------------------------------------------------
// Não fala com o TikTok: quem fala é o live.js de cada sniper, que já está
// conectado e grava as lives no db. Aqui só se lê o que ele guardou.
//
// Mesmo assim o ranking fica em cache: a página é pública e cada visita
// recalcularia tudo. E se o cálculo de um sniper falhar, ele fica com a última
// linha boa em vez de sumir da tabela — e se tudo falhar, vale o último ranking.
// ============================================================================
const config = require('./campanha.config');
const correcoes = require('./correcoes');
const indicacoes = require('./indicacoes');
const pontosManuais = require('./pontos-manuais');
const periodo = require('./periodo');
const snipers = require('./snipers');
const { calcularPontuacao, somarLivesNoPeriodo, ordenarRanking } = require('./pontuacao');

function criarCampanha({ clientes }) {
  let cache = null;               // { atualizadoEm, ranking, periodo }
  const ultimaBoa = new Map();    // sniper -> última linha calculada sem erro

  // a live que está no ar ainda não entrou no histórico: entra aqui até agora
  function livesDoSniper(db, agora) {
    const sessoes = db.getSessions();
    const atual = db.numerosDaLiveAtual();
    if (atual) sessoes.push({ startedAt: atual.comecouEm, endedAt: agora, totalDiamonds: atual.diamantes });
    return { sessoes, atual };
  }

  // o que vem de outras tabelas: lido uma vez por recálculo, não uma por sniper
  function dadosDaCampanha() {
    return {
      oficiais: indicacoes.oficiaisPorIndicador(),
      manuais: pontosManuais.somaPorSniper(),
      corrigidos: correcoes.somaPorSniper()
    };
  }

  // A correção é uma diferença. Se o período mudar depois, a soma pode ficar
  // abaixo de zero, e número negativo não existe aqui.
  function corrigido(soma, correcao) {
    return {
      segundos: Math.max(0, soma.segundos + (correcao ? correcao.segundos : 0)),
      diamantes: Math.max(0, soma.diamantes + (correcao ? correcao.diamantes : 0)),
      lives: soma.lives
    };
  }

  function linhaDoSniper(arroba, { oficiais, manuais, corrigidos }, agora, { inicio, fim }) {
    const { db } = clientes.abrir(arroba);
    const { sessoes, atual } = livesDoSniper(db, agora);

    const soma = corrigido(somarLivesNoPeriodo(sessoes, inicio, fim), corrigidos.get(arroba));
    const nIndicacoes = oficiais.get(arroba) || 0;
    const pontos = calcularPontuacao({
      segundosDeLive: soma.segundos,
      diamantes: soma.diamantes,
      indicacoes: nIndicacoes,
      pontosManuais: manuais.get(arroba) || 0
    });
    const perfil = db.getPerfilDoStreamer();

    return {
      arroba,
      nome: (perfil && perfil.nome) || arroba,
      avatar: (perfil && perfil.avatar) || null,
      aoVivo: !!atual,
      segundos: soma.segundos,
      diamantes: soma.diamantes,
      lives: soma.lives,
      indicacoes: nIndicacoes,
      ...pontos
    };
  }

  function recalcular() {
    const agora = Date.now();
    // lido a cada recálculo: o administrador pode mudar o período na tela
    const p = periodo.get();
    const dados = dadosDaCampanha();
    const linhas = [];
    for (const arroba of snipers.listar()) {
      try {
        const linha = linhaDoSniper(arroba, dados, agora, p);
        ultimaBoa.set(arroba, linha);
        linhas.push(linha);
      } catch (e) {
        console.error(`[MIRA] não consegui calcular @${arroba}:`, e.message);
        if (ultimaBoa.has(arroba)) linhas.push(ultimaBoa.get(arroba));
      }
    }
    return { atualizadoEm: agora, ranking: ordenarRanking(linhas), periodo: p };
  }

  // O que sai pro público: só o que a tela mostra. Diamante e horas ficam de
  // fora de propósito — servem pro desempate, não pra vitrine.
  function publico({ atualizadoEm, ranking, periodo: p }) {
    return {
      // as regras vão junto pra tela mostrar "1h = 10 pts" sem repetir os números
      campanha: { nome: config.nome, inicio: p.inicio, fim: p.fim, regras: config.regras },
      atualizadoEm,
      ranking: ranking.map(l => ({
        posicao: l.posicao, arroba: l.arroba, nome: l.nome, avatar: l.avatar, aoVivo: l.aoVivo, total: l.total
      }))
    };
  }

  function getRanking() {
    if (cache && Date.now() - cache.atualizadoEm < config.cacheMs) return publico(cache);
    try {
      cache = recalcular();
    } catch (e) {
      // sem cache nenhum ainda, não há o que mostrar além da lista vazia
      console.error('[MIRA] falhou o recálculo do ranking:', e.message);
      if (!cache) return publico({ atualizadoEm: null, ranking: [], periodo: periodo.get() });
    }
    return publico(cache);
  }

  // indicação ou período mudou: o próximo pedido recalcula em vez de esperar o cache vencer
  function invalidar() { cache = null; }

  // O número digitado vale sobre o que o ranking usa agora, com a live no ar e
  // as correções anteriores incluídas. Devolve a linha nova pra tela mostrar a
  // pontuação que deu.
  function corrigir(corpo, autor) {
    const arroba = config.normalizar(corpo && corpo.arroba);
    if (!snipers.inclui(arroba)) return { erro: `@${arroba} não é sniper da campanha.` };
    const p = periodo.get();
    const atual = linhaDoSniper(arroba, dadosDaCampanha(), Date.now(), p);
    const r = correcoes.criar({ ...corpo, arroba, atual }, autor);
    if (r.erro) return r;
    invalidar();
    return { ...r, linha: linhaDoSniper(arroba, dadosDaCampanha(), Date.now(), p) };
  }

  // Status da conexão de cada sniper, pro admin (não passa pelo cache: é
  // barato e precisa estar fresco). "Atualizado em" é a última vez que o
  // servidor soube algo daquela live: com ela no ar, o último evento do
  // TikTok; fora do ar, a última checagem de se ela tinha começado.
  //
  // `numeros` é a conferência do admin, e só sai por aqui: a tela pública não
  // mostra diamante nem horas (ver publico()). `noPeriodo` é o que o ranking
  // usa; `tudo` conta também o que ficou fora das datas, senão uma live fora do
  // período apareceria como zero e pareceria que nada foi registrado.
  function status() {
    const agora = Date.now();
    const p = periodo.get();
    const dados = dadosDaCampanha();
    return snipers.listar().map(arroba => {
      try {
        const { db, live } = clientes.abrir(arroba);
        const c = live.estadoDaConexao();
        const { sessoes } = livesDoSniper(db, agora);
        const checagem = (c.ultimaTentativa && c.ultimaTentativa.em) || null;
        const linha = linhaDoSniper(arroba, dados, agora, p);
        return {
          arroba,
          conectado: !!c.online,
          atualizadoEm: c.online ? Math.max(c.ultimoEventoEm || 0, checagem || 0) : checagem,
          // o recado é o texto pra gente ler ("não está ao vivo agora"…)
          recado: (!c.online && c.ultimaTentativa && c.ultimaTentativa.recado) || null,
          numeros: {
            noPeriodo: { segundos: linha.segundos, diamantes: linha.diamantes, lives: linha.lives },
            tudo: corrigido(somarLivesNoPeriodo(sessoes, -Infinity, Infinity), dados.corrigidos.get(arroba)),
            pontos: linha.total,
            gravacao: db.ultimaGravacao()
          }
        };
      } catch (e) {
        console.error(`[MIRA] não li o status de @${arroba}:`, e.message);
        return { arroba, conectado: false, atualizadoEm: null, recado: 'Erro ao ler o status.' };
      }
    });
  }

  // Apaga de vez as lives, os diamantes, as indicações feitas por este sniper, os
  // pontos manuais e as correções dele.
  // Devolve o que foi apagado, pro log: é o único rastro que sobra.
  //
  // Com a live no ar, ela volta a contar do zero a partir de agora: o resetAll
  // leva a sessão junto, e sem o sessaoReiniciada() o resto dela não contaria.
  function zerarUm(arroba) {
    const { db, live } = clientes.abrir(arroba);
    const { sessoes } = livesDoSniper(db, Date.now());
    const apagado = somarLivesNoPeriodo(sessoes, -Infinity, Infinity);
    db.resetAll();
    live.sessaoReiniciada();
    ultimaBoa.delete(arroba);
    return {
      arroba,
      ...apagado,
      indicacoes: indicacoes.removerDoIndicador(arroba),
      pontosManuais: pontosManuais.removerDoSniper(arroba),
      correcoes: correcoes.removerDoSniper(arroba)
    };
  }

  function zerar(arroba) {
    const apagado = zerarUm(arroba);
    invalidar();
    return apagado;
  }

  // Só quem está na lista. O dados.db pode guardar outros donos (sniper que saiu,
  // clientes do ranking de taps), e nada disso é pontuação desta campanha.
  // Um sniper com erro não pode deixar os outros pela metade.
  function zerarTodos() {
    const apagados = [];
    const falhas = [];
    for (const arroba of snipers.listar()) {
      try {
        apagados.push(zerarUm(arroba));
      } catch (e) {
        console.error(`[MIRA] não consegui zerar @${arroba}:`, e.message);
        falhas.push(arroba);
      }
    }
    invalidar();
    return { apagados, falhas };
  }

  return { getRanking, invalidar, corrigir, status, zerar, zerarTodos, snipers: () => snipers.listar() };
}

module.exports = criarCampanha;
