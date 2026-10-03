// ============================================================================
// REGISTRO DE CLIENTES
// ----------------------------------------------------------------------------
// Passo 3 do multi-cliente: cada cliente vira uma SALA do socket.io, e o motor
// dele só fala dentro dessa sala. Antes disso o `emitir` era um `io.emit`, que
// manda pra todo navegador conectado — ou seja, dois clientes enxergariam a
// live um do outro em tempo real.
//
// Aqui mora a única resposta para "de quem é esta requisição?":
//   usuário logado -> dono (o @ da live) -> cliente { db, live, sala }
// Enquanto existir um cliente só, todo mundo cai no `donoPadrao` e nada muda
// de comportamento. Quando o cadastro existir (passo 4), cada usuário vem com
// o `dono` dele no users.json e este arquivo não precisa mudar.
// ============================================================================
const dbFabrica = require('./db');
const criarLive = require('./live');
const auth = require('./auth');

function criarRegistro({ io, donoPadrao }) {
  if (!io) throw new Error('criarRegistro precisa do io do socket.io.');
  if (!donoPadrao) throw new Error('criarRegistro precisa de um dono padrão.');

  const abertos = new Map();

  // Tira o @ TAMBEM na hora de resolver, e nao so na hora de gravar: assim
  // quem ja foi gravado como "@fulano" antes deste conserto volta a cair na
  // live certa, em vez de ficar num banco vazio pra sempre.
  const normalizar = dono => String(dono || '').trim().replace(/^@+/, '').toLowerCase();

  // Prefixo de propósito: o nome da sala nunca colide com um evento ou com
  // um id de socket.
  const salaDe = dono => 'dono:' + normalizar(dono);

  // Abre (ou reaproveita) o cliente. Não liga o motor — quem liga é `iniciar`,
  // porque abrir acontece a cada requisição e conectar no TikTok não pode.
  function abrir(dono) {
    const chave = normalizar(dono);
    if (!chave) throw new Error('abrir() precisa do @ do dono.');
    if (abertos.has(chave)) return abertos.get(chave);

    // A live da casa mantém o live.json atualizado no formato antigo: é o que
    // permite voltar pro código pré-SQLite sem perder nada. Clientes novos não
    // espelham — os dados deles nasceram no banco.
    const db = dbFabrica.paraDono(chave, { espelharJson: chave === normalizar(donoPadrao) });
    const sala = salaDe(chave);
    const live = criarLive({
      dono: chave,
      db,
      // ESTA linha é o passo 3 inteiro: o motor fala com a sala do cliente,
      // não com o servidor todo.
      emitir: (evento, dados) => io.to(sala).emit(evento, dados)
    });

    const cliente = { dono: chave, sala, db, live };
    abertos.set(chave, cliente);
    return cliente;
  }

  function iniciar(dono) {
    const cliente = abrir(dono);
    cliente.live.iniciar();
    return cliente;
  }

  // Desliga um cliente sem encostar nos outros: para o motor, grava o que
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

  // ---------- de quem é esta sessão ----------
  // Sem `dono` no cadastro, cai no padrão da instalação — que é o caso de
  // hoje, com um cliente só.
  function doUsuario(usuario) {
    let dono = null;
    try { dono = auth.donoDoUsuario(usuario); } catch (e) { dono = null; }
    return abrir(dono || donoPadrao);
  }

  // O administrador não tem live. Quando ele precisa olhar a de um cliente
  // (suporte, conferir se está contando), ele ESPIA: a sessão guarda de quem
  // é a live que ele está vendo, e sai disso com um clique.
  //
  // Só vale pra administrador: um cliente com `espiando` na sessão continua
  // caindo na live dele, porque a marca de admin é conferida aqui.
  function daSessao(sessao) {
    const usuario = sessao && sessao.user;
    if (usuario && sessao.espiando) {
      let ehDono = false;
      try { ehDono = auth.ehAdmin(usuario); } catch (e) { ehDono = false; }
      if (ehDono) return abrir(sessao.espiando);
    }
    return doUsuario(usuario);
  }

  function doPedido(req) {
    return daSessao(req && req.session);
  }

  function doSocket(socket) {
    return daSessao(socket && socket.request && socket.request.session);
  }

  function listar() {
    return [...abertos.values()];
  }

  return { abrir, iniciar, fechar, doUsuario, daSessao, doPedido, doSocket, listar, salaDe, donoPadrao };
}

module.exports = criarRegistro;
