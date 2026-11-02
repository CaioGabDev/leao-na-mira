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
const periodo = require('./periodo');
const snipers = require('./snipers');
const { calcularPontuacao, somarLivesNoPeriodo, ordenarRanking } = require('./pontuacao');

function criarCampanha({ clientes }) {
  let cache = null;               // { atualizadoEm, ranking, periodo }
  const ultimaBoa = new Map();    // sniper -> última linha calculada sem erro

  function linhaDoSniper(arroba, oficiais, agora, { inicio, fim }) {
    const { db } = clientes.abrir(arroba);
    const sessoes = db.getSessions();

    // a live que está no ar ainda não entrou no histórico: entra aqui até agora
    const atual = db.numerosDaLiveAtual();
    if (atual) sessoes.push({ startedAt: atual.comecouEm, endedAt: agora, totalDiamonds: atual.diamantes });

    const soma = somarLivesNoPeriodo(sessoes, inicio, fim);
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
    // lido a cada recálculo: o administrador pode mudar o período na tela
    const p = periodo.get();
    const oficiais = indicacoes.oficiaisPorIndicador();
    const linhas = [];
    for (const arroba of snipers.listar()) {
      try {
        const linha = linhaDoSniper(arroba, oficiais, agora, p);
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
      campanha: { nome: config.nome, inicio: p.inicio, fim: p.fim },
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

  // Status da conexão de cada sniper, pro admin (não passa pelo cache: é
  // barato e precisa estar fresco). "Atualizado em" é a última vez que o
  // servidor soube algo daquela live: com ela no ar, o último evento do
  // TikTok; fora do ar, a última checagem de se ela tinha começado.
  function status() {
    return snipers.listar().map(arroba => {
      try {
        const c = clientes.abrir(arroba).live.estadoDaConexao();
        const checagem = (c.ultimaTentativa && c.ultimaTentativa.em) || null;
        return {
          arroba,
          conectado: !!c.online,
          atualizadoEm: c.online ? Math.max(c.ultimoEventoEm || 0, checagem || 0) : checagem,
          // o recado é o texto pra gente ler ("não está ao vivo agora"…)
          recado: (!c.online && c.ultimaTentativa && c.ultimaTentativa.recado) || null
        };
      } catch (e) {
        console.error(`[MIRA] não li o status de @${arroba}:`, e.message);
        return { arroba, conectado: false, atualizadoEm: null, recado: 'Erro ao ler o status.' };
      }
    });
  }

  return { getRanking, invalidar, status, snipers: () => snipers.listar() };
}

module.exports = criarCampanha;
