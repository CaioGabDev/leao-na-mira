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
const indicacoes = require('./indicacoes');
const { calcularPontuacao, somarLivesNoPeriodo, ordenarRanking } = require('./pontuacao');

function criarCampanha({ clientes }) {
  let cache = null;               // { atualizadoEm, ranking }
  const ultimaBoa = new Map();    // sniper -> última linha calculada sem erro

  function linhaDoSniper(arroba, oficiais, agora) {
    const { db } = clientes.abrir(arroba);
    const sessoes = db.getSessions();

    // a live que está no ar ainda não entrou no histórico: entra aqui até agora
    const atual = db.numerosDaLiveAtual();
    if (atual) sessoes.push({ startedAt: atual.comecouEm, endedAt: agora, totalDiamonds: atual.diamantes });

    const soma = somarLivesNoPeriodo(sessoes, config.inicio, config.fim);
    const nIndicacoes = oficiais.get(arroba) || 0;
    const pontos = calcularPontuacao({ segundosDeLive: soma.segundos, diamantes: soma.diamantes, indicacoes: nIndicacoes });
    const perfil = db.getPerfilDoStreamer();

    return {
      arroba,
      nome: (perfil && perfil.nome) || arroba,
      avatar: (perfil && perfil.avatar) || null,
      aoVivo: !!atual,
      segundos: soma.segundos,
      diamantes: soma.diamantes,
      indicacoes: nIndicacoes,
      ...pontos
    };
  }

  function recalcular() {
    const agora = Date.now();
    const oficiais = indicacoes.oficiaisPorIndicador();
    const linhas = [];
    for (const arroba of config.snipers) {
      try {
        const linha = linhaDoSniper(arroba, oficiais, agora);
        ultimaBoa.set(arroba, linha);
        linhas.push(linha);
      } catch (e) {
        console.error(`[MIRA] não consegui calcular @${arroba}:`, e.message);
        if (ultimaBoa.has(arroba)) linhas.push(ultimaBoa.get(arroba));
      }
    }
    return { atualizadoEm: agora, ranking: ordenarRanking(linhas) };
  }

  // O que sai pro público: só o que a tela mostra. Diamante e horas ficam de
  // fora de propósito — servem pro desempate, não pra vitrine.
  function publico({ atualizadoEm, ranking }) {
    return {
      campanha: { nome: config.nome, inicio: config.inicio, fim: config.fim },
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
      if (!cache) return publico({ atualizadoEm: null, ranking: [] });
    }
    return publico(cache);
  }

  // indicação mudou: o próximo pedido recalcula em vez de esperar o cache vencer
  function invalidar() { cache = null; }

  return { getRanking, invalidar, snipers: () => [...config.snipers] };
}

module.exports = criarCampanha;
