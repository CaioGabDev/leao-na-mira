// ============================================================================
// CORREÇÕES — o admin digita o número real e a pontuação sai da conta normal
// ----------------------------------------------------------------------------
// Roda num dados.db de uma pasta temporária, com lives de mentira no lugar do
// TikTok: nada aqui abre conexão.
//
// Roda com:  node --test teste/correcoes.js
// ============================================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-correcoes-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;
process.env.MIRA_SNIPERS = 'ana,bia';

const raiz = arquivo => path.join(__dirname, '..', arquivo);
const correcoes = require(raiz('correcoes.js'));
const periodo = require(raiz('periodo.js'));
const criarCampanha = require(raiz('campanha.js'));

const MIN = 60 * 1000;
const AGORA = Date.now();
periodo.salvar({ inicio: AGORA - 24 * 60 * MIN, fim: AGORA + 24 * 60 * MIN }, 'chefe');

// live de 55 min com 300 diamantes, o caso real
const LIVE_DA_ANA = { startedAt: AGORA - 120 * MIN, endedAt: AGORA - 65 * MIN, totalDiamonds: 300 };

function campanhaCom(sessoesPorSniper = {}) {
  const sessoes = { ana: [LIVE_DA_ANA], bia: [], ...sessoesPorSniper };
  const clientes = {
    abrir: arroba => ({
      db: {
        getSessions: () => [...sessoes[arroba]],
        numerosDaLiveAtual: () => null,
        getPerfilDoStreamer: () => null,
        ultimaGravacao: () => ({ em: null, erro: null }),
        resetAll: () => { sessoes[arroba] = []; }
      },
      live: { estadoDaConexao: () => ({ online: false }), sessaoReiniciada: () => false }
    })
  };
  return { campanha: criarCampanha({ clientes }), sessoes };
}

const linhaDe = (campanha, arroba) => {
  campanha.invalidar();
  return campanha.getRanking().ranking.find(l => l.arroba === arroba);
};
const numerosDe = (campanha, arroba) => campanha.status().find(s => s.arroba === arroba).numeros;

beforeEach(() => {
  correcoes.listar().forEach(c => correcoes.remover(c.id));
});

test('o caso real: 300 corrigidos pra 500 fecham o bloco e dão 30 pontos', () => {
  const { campanha } = campanhaCom();
  assert.equal(linhaDe(campanha, 'ana').total, 0);

  const r = campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'combo no fim da live' }, 'chefe');
  assert.equal(r.erro, undefined);
  assert.equal(r.linha.diamantes, 500);
  assert.equal(r.linha.total, 30);
  assert.equal(linhaDe(campanha, 'ana').total, 30);
});

test('minutos: 55 corrigidos pra 60 fecham a hora e dão 10 pontos', () => {
  const { campanha } = campanhaCom();
  const { linha } = campanha.corrigir({ arroba: 'ana', minutos: 60, motivo: 'live perdida' }, 'chefe');
  assert.equal(linha.segundos, 3600);
  assert.equal(linha.total, 10);
});

test('diamantes e minutos juntos somam as duas partes', () => {
  const { campanha } = campanhaCom();
  const { linha } = campanha.corrigir({ arroba: 'ana', diamantes: 1000, minutos: 120, motivo: 'live perdida' }, 'chefe');
  assert.equal(linha.total, 60 + 20);
});

test('corrigir pra baixo também vale', () => {
  const { campanha } = campanhaCom({ ana: [{ ...LIVE_DA_ANA, totalDiamonds: 1000 }] });
  assert.equal(linhaDe(campanha, 'ana').total, 60);
  const { linha } = campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'contou em dobro' }, 'chefe');
  assert.equal(linha.diamantes, 500);
  assert.equal(linha.total, 30);
});

test('as lives seguintes continuam somando por cima da correção', () => {
  const { campanha, sessoes } = campanhaCom();
  campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'combo no fim da live' }, 'chefe');
  sessoes.ana.push({ startedAt: AGORA - 60 * MIN, endedAt: AGORA - 30 * MIN, totalDiamonds: 500 });
  assert.equal(numerosDe(campanha, 'ana').noPeriodo.diamantes, 1000);
  // 1000 diamantes dão 60, e 55 + 30 min fecham 1h, que dá 10
  assert.equal(linhaDe(campanha, 'ana').total, 70);
});

test('corrigir de novo parte do número já corrigido', () => {
  const { campanha } = campanhaCom();
  campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'primeira' }, 'chefe');
  const { linha, correcao } = campanha.corrigir({ arroba: 'ana', diamantes: 700, motivo: 'segunda' }, 'chefe');
  assert.equal(linha.diamantes, 700);
  assert.equal(correcao.de.diamantes, 500);
  assert.equal(correcao.diamantes, 200);
});

test('campo que não veio não muda, mesmo com a live andando', () => {
  const { campanha } = campanhaCom();
  const { linha } = campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'live perdida' }, 'chefe');
  assert.equal(linha.segundos, 55 * 60);
});

test('mesmo minuto não mexe nos segundos', () => {
  const longa = { ...LIVE_DA_ANA, endedAt: LIVE_DA_ANA.endedAt + 30 * 1000 };   // 55min30s
  const { campanha } = campanhaCom({ ana: [longa] });
  const { linha } = campanha.corrigir({ arroba: 'ana', diamantes: 500, minutos: 55, motivo: 'live perdida' }, 'chefe');
  assert.equal(linha.segundos, 55 * 60 + 30);
});

test('guarda de onde veio, pra onde foi, motivo e autor', () => {
  const { campanha } = campanhaCom();
  const { correcao } = campanha.corrigir({ arroba: '@Ana', diamantes: 500, motivo: '  combo perdido  ' }, 'chefe');
  assert.equal(correcao.arroba, 'ana');
  assert.deepEqual(correcao.de, { diamantes: 300, minutos: 55 });
  assert.deepEqual(correcao.para, { diamantes: 500, minutos: null });
  assert.equal(correcao.motivo, 'combo perdido');
  assert.equal(correcao.autor, 'chefe');
});

test('remover desfaz a correção', () => {
  const { campanha } = campanhaCom();
  const { correcao } = campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'live perdida' }, 'chefe');
  assert.equal(correcoes.remover(correcao.id), true);
  assert.equal(numerosDe(campanha, 'ana').noPeriodo.diamantes, 300);
  assert.equal(correcoes.remover(correcao.id), false);
});

test('recusa o que não é correção de verdade', () => {
  const { campanha } = campanhaCom();
  const certo = { arroba: 'ana', diamantes: 500, motivo: 'live perdida' };
  const casos = [
    { ...certo, arroba: 'ninguem' },
    { ...certo, diamantes: -1 },
    { ...certo, diamantes: 1.5 },
    { ...certo, diamantes: 'muito' },
    { ...certo, diamantes: 100000001 },
    { ...certo, minutos: -1 },
    { ...certo, minutos: 100001 },
    { ...certo, motivo: '' },
    { ...certo, motivo: ' a ' },
    { ...certo, motivo: 'x'.repeat(201) },
    { arroba: 'ana', motivo: 'sem número nenhum' },
    { ...certo, diamantes: 300 },
    { arroba: 'ana', diamantes: 300, minutos: 55, motivo: 'nada mudou' }
  ];
  for (const caso of casos) assert.ok(campanha.corrigir(caso, 'chefe').erro, JSON.stringify(caso).slice(0, 80));
  assert.equal(correcoes.listar().length, 0);
});

test('o painel mostra os números corrigidos e a pontuação', () => {
  const { campanha } = campanhaCom();
  campanha.corrigir({ arroba: 'ana', diamantes: 500, minutos: 60, motivo: 'live perdida' }, 'chefe');
  const numeros = numerosDe(campanha, 'ana');
  assert.deepEqual(numeros.noPeriodo, { segundos: 3600, diamantes: 500, lives: 1 });
  assert.deepEqual(numeros.tudo, numeros.noPeriodo);
  assert.equal(numeros.pontos, 40);
});

test('o desempate usa o número corrigido', () => {
  const { campanha } = campanhaCom();
  campanha.corrigir({ arroba: 'bia', diamantes: 400, motivo: 'live perdida' }, 'chefe');
  assert.equal(linhaDe(campanha, 'bia').posicao, 1);
});

test('o ranking público não mostra diamantes nem o motivo', () => {
  const { campanha } = campanhaCom();
  campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'segredo do admin' }, 'chefe');
  const publico = JSON.stringify(campanha.getRanking().ranking);
  assert.doesNotMatch(publico, /segredo do admin|diamantes/);
});

test('zerar um sniper leva as correções dele, e só dele', () => {
  const { campanha } = campanhaCom();
  campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'live perdida' }, 'chefe');
  campanha.corrigir({ arroba: 'bia', diamantes: 500, motivo: 'live perdida' }, 'chefe');

  const apagado = campanha.zerar('ana');
  assert.equal(apagado.correcoes, 1);
  assert.equal(numerosDe(campanha, 'ana').noPeriodo.diamantes, 0);
  assert.equal(numerosDe(campanha, 'bia').noPeriodo.diamantes, 500);
});

test('zerar todos leva as correções de todos', () => {
  const { campanha } = campanhaCom();
  campanha.corrigir({ arroba: 'ana', diamantes: 500, motivo: 'live perdida' }, 'chefe');
  campanha.corrigir({ arroba: 'bia', diamantes: 500, motivo: 'live perdida' }, 'chefe');
  campanha.zerarTodos();
  assert.deepEqual(correcoes.listar(), []);
});
