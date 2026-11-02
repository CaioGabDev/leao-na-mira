// ============================================================================
// CAMPANHA "TEM LEÃO NA MIRA! 🎯"
// ----------------------------------------------------------------------------
// Tudo o que muda de uma edição da campanha pra outra mora aqui: os valores da
// pontuação, o período e quem são os snipers. A conta em si está no
// pontuacao.js e não conhece nenhum número de cabeça.
//
// Período e snipers são o PADRÃO: o administrador muda os dois pela tela
// (periodo.js, snipers.js), e o que ele salva vence. Aceitam env var por cima
// do arquivo (Railway, em Variables):
//   MIRA_INICIO / MIRA_FIM   data ISO com fuso, ex.: 2026-11-01T00:00:00-03:00
//   MIRA_SNIPERS             @ separados por vírgula, ex.: fulano,ciclano
//   MIRA_CACHE_MS            de quanto em quanto tempo o ranking é recalculado
// ============================================================================

const regras = Object.freeze({
  PONTOS_POR_HORA: 10,         // cada 1h completa de live
  DIAMANTES_POR_BLOCO: 500,    // fração abaixo disso não conta
  PONTOS_POR_BLOCO: 30,
  PONTOS_POR_INDICACAO: 20     // indicado que entrou na MIRA e fez a 1ª live
});

// Fuso de Brasília escrito na data: sem ele, "meia-noite" seria a meia-noite
// de onde o servidor estiver rodando.
const PADRAO = {
  nome: 'TEM LEÃO NA MIRA! 🎯',
  inicio: '2026-11-01T00:00:00-03:00',
  fim: '2026-11-30T23:59:59-03:00',
  snipers: [
    // '@fulano',
  ],
  cacheMs: 60 * 1000
};

const normalizar = arroba => String(arroba || '').trim().replace(/^@+/, '').toLowerCase();

function lerData(texto, nome) {
  const ms = Date.parse(texto);
  // data torta derruba a subida: um período errado calado viraria ranking errado
  if (!Number.isFinite(ms)) throw new Error(`Campanha: ${nome} inválido (${texto}). Use ISO, ex.: 2026-11-01T00:00:00-03:00`);
  return ms;
}

const inicio = lerData(process.env.MIRA_INICIO || PADRAO.inicio, 'MIRA_INICIO');
const fim = lerData(process.env.MIRA_FIM || PADRAO.fim, 'MIRA_FIM');
if (fim <= inicio) throw new Error('Campanha: MIRA_FIM precisa ser depois de MIRA_INICIO.');

const snipers = [...new Set(
  (process.env.MIRA_SNIPERS ? process.env.MIRA_SNIPERS.split(',') : PADRAO.snipers)
    .map(normalizar)
    .filter(Boolean)
)];

const cacheMs = Math.max(5000, Number(process.env.MIRA_CACHE_MS) || PADRAO.cacheMs);

module.exports = { nome: PADRAO.nome, regras, inicio, fim, snipers, cacheMs, normalizar };
