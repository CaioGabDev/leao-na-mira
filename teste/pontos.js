// ============================================================================
// PONTOS MANUAIS — o que o administrador lança pra compensar live perdida
// ----------------------------------------------------------------------------
// Roda num dados.db de uma pasta temporária, com o db de verdade e uma live de
// mentira no lugar do TikTok.
//
// Roda com:  node --test teste/pontos.js
// ============================================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAIXA = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-pontos-'));
process.chdir(CAIXA);
delete process.env.RAILWAY_ENVIRONMENT;
process.env.MIRA_SNIPERS = 'ana,bia';

const raiz = arquivo => path.join(__dirname, '..', arquivo);
const dbFabrica = require(raiz('db.js'));
const pontos = require(raiz('pontos-manuais.js'));
const criarCampanha = require(raiz('campanha.js'));
const { calcularPontuacao } = require(raiz('pontuacao.js'));

function novaCampanha() {
  const abertos = new Map();
  const clientes = {
    abrir(dono) {
      if (!abertos.has(dono)) {
        const db = dbFabrica.paraDono(dono);
        abertos.set(dono, {
          db,
          live: { estadoDaConexao: () => ({ online: false }), sessaoReiniciada: () => false }
        });
      }
      return abertos.get(dono);
    }
  };
  return criarCampanha({ clientes });
}

const totalDe = (campanha, arroba) => campanha.getRanking().ranking.find(l => l.arroba === arroba).total;

beforeEach(() => {
  pontos.listar().forEach(p => pontos.remover(p.id));
});

test('a conta soma os pontos manuais no total', () => {
  const r = calcularPontuacao({ segundosDeLive: 3600, pontosManuais: 25 });
  assert.equal(r.pontosManuais, 25);
  assert.equal(r.total, r.pontosHoras + 25);
});

test('lançamento guarda quem, quanto, motivo e autor', () => {
  const { lancamento } = pontos.criar({ arroba: '@Ana', pontos: 30, motivo: '  live perdida  ' }, 'chefe');
  assert.equal(lancamento.arroba, 'ana');
  assert.equal(lancamento.pontos, 30);
  assert.equal(lancamento.motivo, 'live perdida');
  assert.equal(lancamento.autor, 'chefe');
  assert.deepEqual(pontos.listar().map(p => p.id), [lancamento.id]);
});

test('recusa o que não é lançamento de verdade', () => {
  const certo = { arroba: 'ana', pontos: 10, motivo: 'live perdida' };
  const casos = [
    { ...certo, arroba: 'ninguem' },
    { ...certo, pontos: 0 },
    { ...certo, pontos: -5 },
    { ...certo, pontos: 1.5 },
    { ...certo, pontos: 'muito' },
    { ...certo, pontos: 100001 },
    { ...certo, motivo: '' },
    { ...certo, motivo: '  a ' },
    { ...certo, motivo: 'x'.repeat(201) }
  ];
  for (const caso of casos) assert.ok(pontos.criar(caso, 'chefe').erro, JSON.stringify(caso).slice(0, 80));
  assert.equal(pontos.listar().length, 0);
});

test('entra no ranking na hora e sai ao remover', () => {
  const campanha = novaCampanha();
  assert.equal(totalDe(campanha, 'ana'), 0);

  const { lancamento } = pontos.criar({ arroba: 'ana', pontos: 40, motivo: 'live perdida' }, 'chefe');
  pontos.criar({ arroba: 'ana', pontos: 5, motivo: 'outra falha' }, 'chefe');
  campanha.invalidar();
  assert.equal(totalDe(campanha, 'ana'), 45);
  assert.equal(totalDe(campanha, 'bia'), 0);

  assert.equal(pontos.remover(lancamento.id), true);
  campanha.invalidar();
  assert.equal(totalDe(campanha, 'ana'), 5);
});

test('quem tem mais pontos manuais sobe no ranking', () => {
  const campanha = novaCampanha();
  pontos.criar({ arroba: 'bia', pontos: 10, motivo: 'live perdida' }, 'chefe');
  campanha.invalidar();
  assert.equal(campanha.getRanking().ranking[0].arroba, 'bia');
});

test('o ranking público mostra só o total, sem o motivo', () => {
  const campanha = novaCampanha();
  pontos.criar({ arroba: 'ana', pontos: 40, motivo: 'segredo do admin' }, 'chefe');
  campanha.invalidar();
  assert.doesNotMatch(JSON.stringify(campanha.getRanking()), /segredo do admin|pontosManuais/);
});

test('remover o que não existe devolve false', () => {
  assert.equal(pontos.remover('nao-existe'), false);
});

test('zerar um sniper leva os pontos manuais dele, e só dele', () => {
  const campanha = novaCampanha();
  pontos.criar({ arroba: 'ana', pontos: 40, motivo: 'live perdida' }, 'chefe');
  pontos.criar({ arroba: 'bia', pontos: 7, motivo: 'live perdida' }, 'chefe');

  const apagado = campanha.zerar('ana');
  assert.equal(apagado.pontosManuais, 40);
  assert.equal(totalDe(campanha, 'ana'), 0);
  assert.equal(totalDe(campanha, 'bia'), 7);
});

test('zerar todos leva os pontos manuais de todos', () => {
  const campanha = novaCampanha();
  pontos.criar({ arroba: 'ana', pontos: 40, motivo: 'live perdida' }, 'chefe');
  pontos.criar({ arroba: 'bia', pontos: 7, motivo: 'live perdida' }, 'chefe');
  campanha.zerarTodos();
  assert.deepEqual(pontos.listar(), []);
});
