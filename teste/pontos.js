// ============================================================================
// PONTOS MANUAIS — os lançados antes das correções continuam valendo
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
const banco = require(raiz('banco.js'));
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

// Não existe mais lançar ponto: isto é o que ficou gravado de antes.
let proximo = 0;
function jaLancado({ arroba, pontos: quantos, motivo }) {
  pontos.listar();   // garante que a tabela existe
  const item = { id: 'antigo' + (++proximo), arroba, pontos: quantos, motivo, criadoEm: proximo, autor: 'chefe' };
  banco.abrir().prepare('INSERT INTO pontos_manuais (id, dados) VALUES (?, ?)').run(item.id, JSON.stringify(item));
  return item;
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

test('seguem no ranking e saem ao remover', () => {
  const campanha = novaCampanha();
  assert.equal(totalDe(campanha, 'ana'), 0);

  const lancamento = jaLancado({ arroba: 'ana', pontos: 40, motivo: 'live perdida' });
  jaLancado({ arroba: 'ana', pontos: 5, motivo: 'outra falha' });
  campanha.invalidar();
  assert.equal(totalDe(campanha, 'ana'), 45);
  assert.equal(totalDe(campanha, 'bia'), 0);

  assert.equal(pontos.remover(lancamento.id), true);
  campanha.invalidar();
  assert.equal(totalDe(campanha, 'ana'), 5);
});

test('quem tem mais pontos manuais sobe no ranking', () => {
  const campanha = novaCampanha();
  jaLancado({ arroba: 'bia', pontos: 10, motivo: 'live perdida' });
  campanha.invalidar();
  assert.equal(campanha.getRanking().ranking[0].arroba, 'bia');
});

test('o ranking público mostra só o total, sem o motivo', () => {
  const campanha = novaCampanha();
  jaLancado({ arroba: 'ana', pontos: 40, motivo: 'segredo do admin' });
  campanha.invalidar();
  assert.doesNotMatch(JSON.stringify(campanha.getRanking()), /segredo do admin|pontosManuais/);
});

test('remover o que não existe devolve false', () => {
  assert.equal(pontos.remover('nao-existe'), false);
});

test('zerar um sniper leva os pontos manuais dele, e só dele', () => {
  const campanha = novaCampanha();
  jaLancado({ arroba: 'ana', pontos: 40, motivo: 'live perdida' });
  jaLancado({ arroba: 'bia', pontos: 7, motivo: 'live perdida' });

  const apagado = campanha.zerar('ana');
  assert.equal(apagado.pontosManuais, 40);
  assert.equal(totalDe(campanha, 'ana'), 0);
  assert.equal(totalDe(campanha, 'bia'), 7);
});

test('zerar todos leva os pontos manuais de todos', () => {
  const campanha = novaCampanha();
  jaLancado({ arroba: 'ana', pontos: 40, motivo: 'live perdida' });
  jaLancado({ arroba: 'bia', pontos: 7, motivo: 'live perdida' });
  campanha.zerarTodos();
  assert.deepEqual(pontos.listar(), []);
});
