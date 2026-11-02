// ============================================================================
// PERÍODO DA CAMPANHA — início e fim, decididos pelo administrador
// ----------------------------------------------------------------------------
// O padrão vem do campanha.config.js (ou de MIRA_INICIO/MIRA_FIM). Quando o
// administrador salva um período na tela, ele VENCE o padrão — senão uma env
// var esquecida no Railway desfaria calada o que foi decidido na tela. "Voltar
// ao padrão" apaga o salvo e a env var volta a valer.
//
// Mora no dados.db, na tabela de ajustes (ajustes.js).
// ============================================================================
const ajustes = require('./ajustes');
const campanha = require('./campanha.config');

const DIA = 24 * 60 * 60 * 1000;
const MAIS_ANTIGO = Date.parse('2020-01-01T00:00:00Z');
const MAIS_NOVO = Date.parse('2100-01-01T00:00:00Z');
const DURACAO_MAXIMA = 366 * DIA;

// Conta pura: devolve o texto do erro, ou null se o período serve.
function validar(inicio, fim) {
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return 'Informe a data de início e a de fim.';
  if (inicio < MAIS_ANTIGO || fim > MAIS_NOVO) return 'Data fora do intervalo aceito.';
  if (fim <= inicio) return 'O fim precisa ser depois do início.';
  if (fim - inicio > DURACAO_MAXIMA) return 'O período não pode passar de um ano.';
  return null;
}

function salvo() {
  const p = ajustes.ler('periodo');
  if (!p) return null;
  // linha torta (editada à mão, versão antiga) não pode virar período errado
  return validar(p.inicio, p.fim) ? null : p;
}

// { inicio, fim, origem: 'admin' | 'padrao', autor?, em? }
// Banco fora do ar não derruba o ranking: cai no padrão e avisa no log.
function get() {
  try {
    const p = salvo();
    if (p) return { inicio: p.inicio, fim: p.fim, origem: 'admin', autor: p.autor, em: p.em };
  } catch (e) {
    console.error('[MIRA] não li o período salvo, usando o padrão:', e.message);
  }
  return { inicio: campanha.inicio, fim: campanha.fim, origem: 'padrao' };
}

function salvar(corpo, autor) {
  const inicio = Number(corpo && corpo.inicio);
  const fim = Number(corpo && corpo.fim);
  const erro = validar(inicio, fim);
  if (erro) return { erro };
  const item = { inicio, fim, autor: String(autor || ''), em: Date.now() };
  ajustes.gravar('periodo', item);
  return { periodo: get() };
}

function voltarAoPadrao() {
  ajustes.apagar('periodo');
  return { periodo: get() };
}

module.exports = { get, salvar, voltarAoPadrao, validar };
