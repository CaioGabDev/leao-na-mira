// ============================================================================
// SNIPERS DA CAMPANHA — quem está no ranking
// ----------------------------------------------------------------------------
// O administrador adiciona e remove pela tela. Enquanto ninguém mexeu, vale a
// lista padrão (MIRA_SNIPERS ou campanha.config.js); na primeira mudança, a
// lista inteira vai pro dados.db e passa a ser a fonte da verdade — senão
// remover alguém que veio da env var não teria efeito nenhum.
//
// Tirar um sniper da lista NÃO apaga nada: o histórico de lives dele e as
// indicações ficam no banco. Ele só deixa de ser acompanhado e de aparecer no
// ranking; se voltar pra lista, volta com tudo.
// ============================================================================
const ajustes = require('./ajustes');
const campanha = require('./campanha.config');

// mesmo formato de @ que o TikTok aceita (igual ao indicacoes.js)
const ARROBA_VALIDO = /^[a-z0-9._]{2,24}$/;
// cada sniper é uma conexão aberta com o TikTok e gasta cota do assinador
const MAXIMO = 50;

function salvos() {
  const s = ajustes.ler('snipers');
  return s && Array.isArray(s.lista) ? s.lista.map(campanha.normalizar).filter(Boolean) : null;
}

// Banco fora do ar não derruba o ranking: cai na lista padrão e avisa no log.
function listar() {
  try {
    const s = salvos();
    if (s) return [...new Set(s)];
  } catch (e) {
    console.error('[MIRA] não li a lista de snipers salva, usando a padrão:', e.message);
  }
  return [...campanha.snipers];
}

function gravar(lista, autor) {
  ajustes.gravar('snipers', { lista, autor: String(autor || ''), em: Date.now() });
}

function adicionar(bruto, autor) {
  const arroba = campanha.normalizar(bruto);
  if (!ARROBA_VALIDO.test(arroba)) return { erro: 'Esse @ é inválido. Use letras, números, ponto e sublinhado.' };
  const lista = listar();
  if (lista.includes(arroba)) return { erro: `@${arroba} já está na campanha.` };
  if (lista.length >= MAXIMO) return { erro: `A campanha já tem o máximo de ${MAXIMO} snipers.` };
  gravar([...lista, arroba], autor);
  return { arroba };
}

function remover(bruto, autor) {
  const arroba = campanha.normalizar(bruto);
  const lista = listar();
  if (!lista.includes(arroba)) return { erro: `@${arroba} não está na campanha.`, status: 404 };
  gravar(lista.filter(a => a !== arroba), autor);
  return { arroba };
}

const inclui = arroba => listar().includes(campanha.normalizar(arroba));

module.exports = { listar, adicionar, remover, inclui, ARROBA_VALIDO };
