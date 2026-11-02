// ============================================================================
// PONTUAÇÃO DA CAMPANHA — conta pura
// ----------------------------------------------------------------------------
// Nada aqui lê banco, relógio ou TikTok: entra número, sai número. É o que
// deixa testar a regra sem subir o servidor (teste/pontuacao.js), e o que
// garante que a tela e qualquer outro lugar façam a MESMA conta.
// ============================================================================
const { regras: regrasPadrao } = require('./campanha.config');

// número que veio torto (undefined, negativo, texto) conta como zero
const inteiro = n => Math.max(0, Math.floor(Number(n) || 0));

// Só hora completa conta, somando todas as lives: 59 min = 0, 60 min = 1h.
// Diamante só em bloco fechado: 499 = 0, 500 = 1 bloco, 999 = 1 bloco.
function calcularPontuacao({ segundosDeLive = 0, diamantes = 0, indicacoes = 0 } = {}, regras = regrasPadrao) {
  const horas = Math.floor(inteiro(segundosDeLive) / 3600);
  const blocos = Math.floor(inteiro(diamantes) / regras.DIAMANTES_POR_BLOCO);

  const pontosHoras = horas * regras.PONTOS_POR_HORA;
  const pontosDiamantes = blocos * regras.PONTOS_POR_BLOCO;
  const pontosIndicacoes = inteiro(indicacoes) * regras.PONTOS_POR_INDICACAO;

  return {
    horas,
    pontosHoras,
    pontosDiamantes,
    pontosIndicacoes,
    total: pontosHoras + pontosDiamantes + pontosIndicacoes
  };
}

// Soma as lives que tocam o período. A duração é cortada nas bordas (só o
// trecho dentro da campanha conta); o diamante vai pela live inteira, porque
// a sessão guarda o total dela e não a hora de cada presente.
function somarLivesNoPeriodo(sessoes, inicio, fim) {
  let segundos = 0;
  let diamantes = 0;
  let lives = 0;
  for (const s of sessoes || []) {
    const comeco = Number(s && s.startedAt);
    const termino = Number(s && s.endedAt);
    if (!Number.isFinite(comeco) || !Number.isFinite(termino)) continue;   // dado ausente: pula
    const de = Math.max(comeco, inicio);
    const ate = Math.min(termino, fim);
    if (ate <= de) continue;
    segundos += Math.floor((ate - de) / 1000);
    diamantes += inteiro(s.totalDiamonds);
    lives++;
  }
  return { segundos, diamantes, lives };
}

// Maior total primeiro; empate vai pra quem tem mais diamantes, depois mais
// tempo de live. O nome no fim só deixa a ordem estável entre recargas.
function ordenarRanking(linhas) {
  return [...(linhas || [])]
    .sort((a, b) =>
      (b.total - a.total)
      || (b.diamantes - a.diamantes)
      || (b.segundos - a.segundos)
      || String(a.arroba).localeCompare(String(b.arroba)))
    .map((linha, i) => ({ ...linha, posicao: i + 1 }));
}

module.exports = { calcularPontuacao, somarLivesNoPeriodo, ordenarRanking };
