// ============================================================================
// REGISTRO DAS LIVES
// ----------------------------------------------------------------------------
// Uma live por sniper: `abrir('@fulano')` devolve { db, live } daquele @, e é
// por aqui que o campanha.js lê as sessões e os diamantes de cada um.
//
// O motor (live.js) ainda avisa cada evento por `emitir` — era assim que as
// telas do ranking de taps se atualizavam ao vivo. Aqui nenhuma tela escuta:
// a campanha lê o que ficou gravado no db, então o aviso vai pro vazio.
// ============================================================================
const dbFabrica = require('./db');
const criarLive = require('./live');

const nada = () => {};

function criarRegistro() {
  const abertos = new Map();

  // Tira o @ TAMBEM na hora de resolver, e nao so na hora de gravar: assim
  // quem ja foi gravado como "@fulano" volta a cair na live certa, em vez de
  // ficar num banco vazio pra sempre.
  const normalizar = dono => String(dono || '').trim().replace(/^@+/, '').toLowerCase();

  // Abre (ou reaproveita) a live. Não liga o motor — quem liga é `iniciar`,
  // porque abrir acontece a cada leitura do ranking e conectar no TikTok não pode.
  function abrir(dono) {
    const chave = normalizar(dono);
    if (!chave) throw new Error('abrir() precisa do @ do dono.');
    if (abertos.has(chave)) return abertos.get(chave);

    const db = dbFabrica.paraDono(chave);
    const live = criarLive({ dono: chave, db, emitir: nada });

    const cliente = { dono: chave, db, live };
    abertos.set(chave, cliente);
    return cliente;
  }

  function iniciar(dono) {
    const cliente = abrir(dono);
    cliente.live.iniciar();
    return cliente;
  }

  // Desliga uma live sem encostar nas outras: para o motor, grava o que
  // estava em memória e solta a instância.
  function fechar(dono) {
    const chave = normalizar(dono);
    const cliente = abertos.get(chave);
    if (!cliente) return false;
    cliente.live.parar();
    try { cliente.db.saveToDisk(); } catch (e) { console.error('Erro ao gravar:', e.message); }
    abertos.delete(chave);
    return true;
  }

  function listar() {
    return [...abertos.values()];
  }

  return { abrir, iniciar, fechar, listar };
}

module.exports = criarRegistro;
