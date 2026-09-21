const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const ConnectionClass = TikTokLiveConnection;
const fs = require('fs');
const path = require('path');
const criarRegistro = require('./clientes');
const assinatura = require('./assinatura');
const auth = require('./auth');
const chaves = require('./chaves');
const config = require('./config');
const { FileSessionStore } = require('./session-store');

// @ da live: o que o dono configurou vence; sem config, a env var de sempre.
// Lido UMA vez, na subida do servidor, de propósito: trocar de live com a
// coisa rodando misturaria duas lives dentro dos dados do mesmo dono.
const TIKTOK_USERNAME = config.get().live.usuario || process.env.TIKTOK_USERNAME || 'vitorb0rba';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Quem é o dono de cada requisição, e em que sala cada navegador escuta.
// Enquanto houver um cliente só, todo mundo cai no TIKTOK_USERNAME e nada muda.
const clientes = criarRegistro({ io, donoPadrao: TIKTOK_USERNAME });

// ---------- Login / sessão ----------
// Quem pode logar é cadastrado com `node create-user.js <usuario> <senha>`
// (gera/atualiza o users.json). Veja o README.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

auth.seedFromEnv();
// Quem vem da versão antiga não tem `admin` em ninguém. Isto resolve uma vez,
// antes de qualquer requisição, pra ninguém ficar trancado pra fora.
auth.garantirDono();

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-troque-em-producao';
if (!process.env.SESSION_SECRET) {
  console.warn('AVISO: SESSION_SECRET não definido. Configure essa env var em produção (Railway).');
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // em arquivo, senão todo restart do servidor desloga todo mundo
  store: new FileSessionStore(),
  // cada visita renova o prazo: quem usa o site com frequência não reloga
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 dias sem acessar
  }
});
app.use(sessionMiddleware);
app.use(express.json());

// mesma sessão do Express também vale pra conexão de socket
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  // mesma regra do HTTP: a conta precisa existir, não só a sessão
  const usuario = socket.request.session && socket.request.session.user;
  if (usuario && auth.existe(usuario)) return next();
  next(new Error('unauthorized'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  // troca o id da sessão ao logar, pra um id capturado antes do login não valer nada
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
    req.session.user = username;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
      // o administrador não cai no ranking: a casa dele é o painel
      res.json({ ok: true, destino: auth.ehAdmin(username) ? '/admin.html' : '/index.html' });
    });
  });
});

// A mesma régua pra quem se cadastra por chave e pro que o administrador cria
// na mão — senão dá pra criar pela porta dos fundos uma conta que a outra
// porta recusaria.
const MIN_SENHA = 6;
function validarCredenciais(usuario, senha) {
  const nome = String(usuario || '').trim();
  if (!nome) return 'Escolha um nome de usuário.';
  if (nome.length < 3) return 'O usuário precisa de pelo menos 3 caracteres.';
  if (nome.length > 40) return 'O usuário passou de 40 caracteres.';
  if (!/^[a-zA-Z0-9._-]+$/.test(nome)) {
    return 'No usuário valem letras, números, ponto, hífen e sublinhado.';
  }
  if (!senha || String(senha).length < MIN_SENHA) {
    return `A senha precisa de pelo menos ${MIN_SENHA} caracteres.`;
  }
  if (String(senha).length > 200) return 'Essa senha é longa demais.';
  return null;
}

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAuth(req, res, next) {
  const usuario = req.session && req.session.user;

  // Sessão aberta não basta: a conta pode ter sido apagada depois do login.
  // Sem esta conferência, "tirar o acesso" só impedia entrar DE NOVO — quem
  // já estava com a aba aberta seguia navegando até o cookie vencer.
  if (usuario && auth.existe(usuario)) return next();

  if (usuario) req.session.destroy(() => {});   // sessão órfã não serve pra nada
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
}

// Quem chega com uma chave ainda NÃO tem conta — se estas rotas ficassem
// atrás do login, ativar seria impossível.
const SEM_LOGIN = new Set([
  '/login.html', '/api/login',
  '/ativar.html', '/api/ativar', '/api/ativar/info'
]);

app.use((req, res, next) => {
  if (SEM_LOGIN.has(req.path)) return next();
  requireAuth(req, res, next);
});

// ---------- ATIVAÇÃO POR CHAVE ----------
// O administrador gera a chave e diz de qual live ela é. Quem recebe escolhe o
// próprio usuário e a própria senha: a senha não passa pela mão de ninguém e o
// administrador nunca fica sabendo dela.

// Freio de tentativa. A rota é pública e chave é coisa que dá pra chutar:
// 12 caracteres num alfabeto de 31 são ~59 bits, então força bruta não ia
// longe — mas sem freio ela vira um jeito barato de fazer barulho no servidor.
const chutes = new Map();   // ip -> { contagem, ate }
const LIMITE_DE_CHUTES = 15;
const JANELA_DE_CHUTES = 10 * 60 * 1000;

// O freio conta UMA coisa: chave rejeitada.
//
// Contar toda requisição parecia mais seguro e era pior: consultar a chave
// certa, errar o formato do usuário ou repetir um nome já usado somavam no
// mesmo balde, e o cliente legítimo travava no meio do próprio cadastro. Quem
// tem uma chave válida na mão já provou que não está chutando — e chutar é a
// única coisa contra a qual este freio serve.
function chuteiAChave(req) {
  const ip = req.ip || 'desconhecido';
  const agora = Date.now();
  const atual = chutes.get(ip);
  if (!atual || agora > atual.ate) {
    chutes.set(ip, { contagem: 1, ate: agora + JANELA_DE_CHUTES });
    return;
  }
  atual.contagem++;
}

function estaDeCastigo(req) {
  const atual = chutes.get(req.ip || 'desconhecido');
  if (!atual || Date.now() > atual.ate) return false;
  return atual.contagem > LIMITE_DE_CHUTES;
}

// Acertou a chave: o IP volta a ter crédito. Senão, ativar vários clientes da
// mesma rede (o mesmo escritório, o mesmo celular) esbarraria no freio.
function limparChutes(req) {
  chutes.delete(req.ip || 'desconhecido');
}

// Diz de qual live a chave é, sem gastar ela. É o que a tela mostra antes da
// pessoa escolher usuário e senha — pra ela saber que caiu no lugar certo.
app.get('/api/ativar/info', (req, res) => {
  if (estaDeCastigo(req)) {
    return res.status(429).json({ error: 'Muitas chaves erradas. Espere alguns minutos.' });
  }
  const conferida = chaves.conferir((req.query && req.query.chave) || '');
  if (!conferida.ok) {
    chuteiAChave(req);
    return res.status(404).json({ error: conferida.motivo });
  }
  limparChutes(req);
  res.json({ ok: true, dono: conferida.dono, expiraEm: conferida.expiraEm });
});

app.post('/api/ativar', (req, res) => {
  if (estaDeCastigo(req)) {
    return res.status(429).json({ error: 'Muitas chaves erradas. Espere alguns minutos.' });
  }
  const { chave, usuario, senha } = req.body || {};
  const nome = String(usuario || '').trim();

  const conferida = chaves.conferir(chave);
  if (!conferida.ok) {
    chuteiAChave(req);
    return res.status(400).json({ error: conferida.motivo });
  }
  // chave boa: daqui pra frente os erros são de formulário, não de chute
  limparChutes(req);

  const problema = validarCredenciais(nome, senha);
  if (problema) return res.status(400).json({ error: problema });
  if (auth.loadUsers().some(u => u.username === nome)) {
    return res.status(409).json({ error: 'Já existe alguém com esse nome de usuário.' });
  }

  // Gastar a chave ANTES de criar a conta. Se o cadastro falhar depois, o
  // prejuízo é uma chave queimada; na ordem inversa, duas ativações
  // simultâneas criariam duas contas com a mesma chave.
  const gasto = chaves.usar(chave, nome);
  if (!gasto.ok) return res.status(400).json({ error: gasto.motivo });

  auth.upsertUser(nome, String(senha), { dono: gasto.dono });

  let ligado = false;
  try {
    clientes.iniciar(gasto.dono);
    ligado = true;
  } catch (e) {
    console.error(`Não consegui subir a live @${gasto.dono}:`, e.message);
  }


  // Já entra logado: pedir pra digitar de novo o que acabou de escolher é
  // só um jeito a mais de errar.
  req.session.regenerate(err => {
    if (err) return res.json({ ok: true, dono: gasto.dono, ligado, entrou: false });
    req.session.user = nome;
    req.session.save(() => res.json({ ok: true, dono: gasto.dono, ligado, entrou: true }));
  });
});

// Quais cartas (e quantas) uma premiação deu. O TikTok não manda isso pela
// live — mostra no painel dele — então quem informa é quem está assistindo.
// O restante do estoque é automático: o uso desconta e os 5 dias vencem.
app.post('/api/powerup/itens', (req, res) => {
  const { uniqueId, ganhaEm, itens } = req.body || {};
  if (!uniqueId || !ganhaEm) {
    return res.status(400).json({ error: 'uniqueId e ganhaEm são obrigatórios.' });
  }
  if (itens && typeof itens !== 'object') {
    return res.status(400).json({ error: 'itens deve ser um objeto { tipo: quantidade }.' });
  }
  const { db, live } = clientes.doPedido(req);
  const ok = db.definirItensDaPremiacao(uniqueId, ganhaEm, itens || {});
  if (!ok) return res.status(404).json({ error: 'Premiação não encontrada.' });

  live.broadcastPowerUps();
  res.json({ ok: true });
});

// O mesmo item em TODAS as premiações pendentes de alguém. Existe porque a
// fila de "a informar" chega a dezenas, e na prática são quase sempre a mesma
// carta — quem joga luva ganha luva. Uma a uma é trabalho que ninguém faz.
app.post('/api/powerup/itens-pendentes', (req, res) => {
  const { uniqueId, itens } = req.body || {};
  if (!uniqueId) return res.status(400).json({ error: 'uniqueId é obrigatório.' });
  if (!itens || typeof itens !== 'object' || !Object.keys(itens).length) {
    return res.status(400).json({ error: 'Escolha pelo menos um item.' });
  }

  const { db, live } = clientes.doPedido(req);
  const quantas = db.definirItensDasPendentes(uniqueId, itens);
  if (!quantas) {
    return res.status(404).json({ error: 'Essa pessoa não tem premiação pendente no prazo.' });
  }

  live.broadcastPowerUps();
  res.json({ ok: true, quantas });
});


// ---------- SÓ O DONO DA INSTALAÇÃO ----------
// A página de configuração e a API dela ficam atrás de um segundo portão, além
// do login. Quem é dono está explicado no auth.ehAdmin().
function requireAdmin(req, res, next) {
  const usuario = req.session && req.session.user;
  if (usuario && auth.ehAdmin(usuario)) return next();
  // req.path aqui vem sem o prefixo montado, então quem responde é o originalUrl
  if ((req.originalUrl || '').startsWith('/api/')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return res.status(403).send(
    '<!doctype html><meta charset="utf-8"><title>Sem acesso</title>' +
    '<body style="font-family:system-ui;background:#0a0807;color:#f3e9dc;padding:40px">' +
    '<h1>Essa parte é do dono do site</h1>' +
    '<p>Sua conta não tem acesso à configuração.</p>' +
    '<p><a style="color:#ffb03a" href="/">Voltar</a></p>');
}
// O painel e o cadastro são do dono do negócio. A APARÊNCIA não: o cliente
// mexe na cara da live dele (o /api/config decide o escopo por quem pediu).
app.use(['/admin.html', '/api/clientes', '/api/chaves', '/api/espiar'], requireAdmin);

// De quem é a cara que esta requisição pode mexer.
//
// Administrador escolhe: `?dono=@fulano` pra um cliente, vazio pra a
// instalação. Cliente só mexe na live DELE — e se pedir outra, leva 403 em
// vez de ter o pedido redirecionado calado (redirecionar fazia ele
// sobrescrever a própria cara com um texto destinado a outro lugar).
function escopoDoPedido(req) {
  const usuario = (req.session && req.session.user) || null;
  const bruto = (req.query && req.query.dono) || (req.body && req.body.dono) || '';
  const pedido = config.usuarioTikTok(bruto);

  if (auth.ehAdmin(usuario)) return { dono: pedido, permitido: true };

  const meu = clientes.doPedido(req).dono;
  // `dono` vazio quer dizer "a minha", não "a da casa" — então não é recusa
  const pediuOutra = !!bruto && pedido !== meu;
  return { dono: meu, permitido: !pediuOutra };
}

app.get('/api/config', (req, res) => {
  const { dono, permitido } = escopoDoPedido(req);
  if (!permitido) return res.status(403).json({ error: 'Você só pode ver a cara da sua live.' });
  res.json({
    dono,                                                // '' = a instalação
    ehAdmin: auth.ehAdmin((req.session && req.session.user) || null),
    config: config.get(dono),
    instalacao: config.get(),                            // o que o cliente herda
    padrao: config.PADRAO,                               // pro botão "voltar ao padrão"
    clientes: config.listarClientes(),
    liveEmUso: TIKTOK_USERNAME,                          // o @ que o servidor está usando agora
    liveDoAmbiente: process.env.TIKTOK_USERNAME || '',   // o que veio da env var, se veio
    assinatura: assinatura.estado(),                     // com ou sem chave (nunca a chave)
    livesLigadas: clientes.listar().length
  });
});

app.post('/api/config', (req, res) => {
  const { dono, permitido } = escopoDoPedido(req);
  if (!permitido) return res.status(403).json({ error: 'Você só pode mexer na cara da sua live.' });
  let salvo;
  try {
    salvo = config.salvar(req.body || {}, dono);
  } catch (e) {
    console.error('Erro ao salvar config:', e.message);
    return res.status(500).json({ error: 'Não deu pra gravar a configuração.' });
  }
  // só a live da CASA depende de restart; a de um cliente é o @ dele
  const efetivo = dono ? TIKTOK_USERNAME
                       : (salvo.live.usuario || process.env.TIKTOK_USERNAME || 'vitorb0rba');
  res.json({ ok: true, dono, config: salvo, precisaReiniciar: efetivo !== TIKTOK_USERNAME });
});

// ---------- CLIENTES ----------
// Cadastrar um cliente é: criar o login dele e amarrar ao @ da live dele. O
// motor sobe na hora — sem reiniciar o servidor.
app.get('/api/clientes', (req, res) => {
  const usuarios = auth.loadUsers();
  const donos = new Set(config.listarClientes());
  usuarios.forEach(u => { if (u.dono) donos.add(u.dono); });
  donos.add(TIKTOK_USERNAME);

  const abertos = new Map(clientes.listar().map(c => [c.dono, c]));
  const comConfig = config.listarClientes();

  res.json({
    padrao: TIKTOK_USERNAME,
    // administradores não pertencem a live nenhuma: são as contas da casa
    admins: usuarios.filter(u => u.admin === true).map(u => u.username),
    eu: (req.session && req.session.user) || null,
    clientes: [...donos].sort().map(dono => {
      const c = abertos.get(dono);
      const ficha = {
        dono,
        daCasa: dono === TIKTOK_USERNAME,
        ligado: !!c,
        temConfig: comConfig.includes(dono),
        // só quem está amarrado ÀQUELA live; admin não entra na conta de ninguém
        usuarios: usuarios.filter(u => !u.admin && (u.dono || TIKTOK_USERNAME) === dono)
                          .map(u => u.username)
      };

      // Os números de cada live, pro painel mostrar tudo de uma vez sem o
      // administrador ter que entrar em cada uma.
      if (c) {
        try {
          const g = c.db.getGlobalStats();
          ficha.aoVivo = c.live.estaOnline();
          ficha.conexao = c.live.estadoDaConexao();
          ficha.numeros = {
            espectadores: g.currentViewers || 0,
            pico: g.peakViewers || 0,
            diamantes: g.totalDiamonds || 0,
            comentarios: g.totalComments || 0,
            seguiram: g.totalFollows || 0,
            pessoas: c.db.getRanking().length,
            duracaoSegundos: g.uptimeSeconds || 0
          };
        } catch (e) {
          // uma live com problema não pode derrubar a listagem inteira
          ficha.erro = e.message;
        }
      }
      return ficha;
    })
  });
});

app.post('/api/clientes', (req, res) => {
  const { usuario, senha } = req.body || {};
  const ehAdministrador = !!(req.body && req.body.administrador);
  const dono = config.usuarioTikTok((req.body && req.body.dono) || '');

  // administrador é conta da casa: não pertence a live nenhuma
  if (!ehAdministrador && !dono) return res.status(400).json({ error: 'O @ da live do cliente é obrigatório.' });
  const problema = validarCredenciais(usuario, senha);
  if (problema) return res.status(400).json({ error: problema });
  if (auth.loadUsers().some(u => u.username === usuario)) {
    return res.status(409).json({ error: 'Já existe alguém com esse nome de usuário.' });
  }

  if (ehAdministrador) {
    auth.upsertUser(String(usuario).trim(), String(senha), { admin: true, dono: '' });
    return res.json({ ok: true, administrador: true, usuario: String(usuario).trim() });
  }

  auth.upsertUser(String(usuario).trim(), String(senha), { dono });

  // sobe o motor desse cliente agora; se falhar, o cadastro continua valendo
  let ligado = false;
  try {
    clientes.iniciar(dono);
    ligado = true;
  } catch (e) {
    console.error(`Não consegui subir a live @${dono}:`, e.message);
  }

  res.json({ ok: true, dono, ligado });
});

// Promove ou rebaixa um administrador.
//
// Duas travas: ninguém se rebaixa sozinho (evita o clique que tranca a pessoa
// pra fora da própria configuração) e a instalação nunca fica sem nenhum dono.
app.post('/api/clientes/admin', (req, res) => {
  const { usuario } = req.body || {};
  const virar = !!(req.body && req.body.administrador);
  const eu = (req.session && req.session.user) || null;

  if (!usuario) return res.status(400).json({ error: 'Qual usuário?' });
  if (!auth.loadUsers().some(u => u.username === usuario)) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }
  if (!virar) {
    if (usuario === eu) {
      return res.status(400).json({ error: 'Não dá pra tirar o seu próprio acesso de administrador.' });
    }
    const admins = auth.loadUsers().filter(u => u.admin === true).map(u => u.username);
    if (admins.length <= 1 && admins.includes(usuario)) {
      return res.status(400).json({ error: 'Esse é o único administrador — a configuração ficaria inacessível.' });
    }
  }

  auth.setAdmin(usuario, virar);
  // Promover solta a pessoa da live dela: administrador não é de live nenhuma.
  // O caminho de volta NÃO devolve o @ antigo — quem é rebaixado cai na live da
  // casa até alguém amarrar noutra. Por isso a tela avisa disso antes de promover.
  if (virar) auth.setDono(usuario, '');

  res.json({ ok: true, usuario, administrador: virar });
});

// Tira o ACESSO de alguém. Os dados da live não são apagados aqui de
// propósito: apagar é irreversível e não pode sair de um clique na lista.
app.post('/api/clientes/remover-acesso', (req, res) => {
  const { usuario } = req.body || {};
  if (!usuario) return res.status(400).json({ error: 'Qual usuário?' });
  if (usuario === (req.session && req.session.user)) {
    return res.status(400).json({ error: 'Não dá pra remover o seu próprio acesso.' });
  }
  const users = auth.loadUsers();
  const alvo = users.find(u => u.username === usuario);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (alvo.admin === true && users.filter(u => u.admin === true).length <= 1) {
    return res.status(400).json({ error: 'Esse é o único administrador — apagar deixaria a configuração inacessível.' });
  }

  auth.saveUsers(users.filter(u => u.username !== usuario));
  res.json({ ok: true });
});

// ---------- CHAVES ----------
app.get('/api/chaves', (req, res) => {
  res.json({ chaves: chaves.listar(), padrao: TIKTOK_USERNAME });
});

app.post('/api/chaves', (req, res) => {
  const dono = config.usuarioTikTok((req.body && req.body.dono) || '');
  if (!dono) return res.status(400).json({ error: 'A chave precisa do @ da live.' });

  const registro = chaves.gerar({
    dono,
    criadaPor: (req.session && req.session.user) || null,
    validadeDias: req.body && req.body.validadeDias,
    observacao: req.body && req.body.observacao
  });
  res.json({ ok: true, ...registro });
});

app.post('/api/chaves/revogar', (req, res) => {
  const ok = chaves.revogar((req.body && req.body.chave) || '');
  if (!ok) return res.status(404).json({ error: 'Chave não encontrada, ou já usada.' });
  res.json({ ok: true });
});

app.post('/api/chaves/apagar', (req, res) => {
  const ok = chaves.apagar((req.body && req.body.chave) || '');
  if (!ok) return res.status(404).json({ error: 'Chave não encontrada.' });
  res.json({ ok: true });
});

// ---------- ESPIAR ----------
// O administrador não tem live própria. Pra dar suporte, ele entra na de um
// cliente — e isso fica guardado na sessão dele, não na do cliente.
app.get('/api/espiar', (req, res) => {
  const dono = config.usuarioTikTok((req.query && req.query.dono) || '');
  if (!dono) return res.status(400).json({ error: 'Qual live?' });
  req.session.espiando = dono;
  req.session.save(() => res.redirect('/index.html'));
});

app.get('/api/espiar/sair', (req, res) => {
  delete req.session.espiando;
  req.session.save(() => res.redirect('/admin.html'));
});

// ---------- PÁGINAS COM A MARCA DO CLIENTE ----------
// As páginas continuam sendo arquivos estáticos. A única coisa que acontece
// aqui é trocar os {{marcadores}} pelo config antes de entregar. Vem ANTES do
// express.static de propósito: senão ele entrega o arquivo cru.
// Lista fechada de nomes — nada de montar caminho com o que veio na URL.
const PAGINAS = new Set(['index.html', 'mural.html', 'login.html', 'ativar.html',
                         'painel.html', 'diagnostico.html', 'admin.html', 'config.html']);
// as telas que pertencem a UMA live — o administrador não mora nelas
const PAGINAS_DE_CLIENTE = new Set(['index.html', 'mural.html', 'painel.html', 'diagnostico.html']);
const cachePagina = new Map();   // nome|variante -> { mtimeMs, versao, html }

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const nome = req.path === '/' ? 'index.html' : req.path.slice(1);
  if (!PAGINAS.has(nome)) return next();

  // A casa do administrador é o painel, não o ranking de uma live: ele é o
  // dono do negócio, não um streamer. Se quiser ver a live de um cliente,
  // entra por "espiar" — e aí a sessão diz de quem é a tela.
  const souDono = !!(req.session && req.session.user && auth.ehAdmin(req.session.user));
  if (souDono && PAGINAS_DE_CLIENTE.has(nome) && !(req.session && req.session.espiando)) {
    return res.redirect('/admin.html');
  }

  const arquivo = path.join(__dirname, 'public', nome);
  let stat;
  try { stat = fs.statSync(arquivo); } catch (e) { return next(); }

  // A cara da página é a do cliente de quem está logado; o link da engrenagem
  // só existe pro dono. O cache guarda uma versão por combinação dos dois,
  // senão um cliente serviria a página pintada do outro.
  const ehAdmin = souDono;
  const espiando = !!(req.session && req.session.espiando);
  let dono = '';
  try { dono = clientes.doPedido(req).dono; } catch (e) { dono = ''; }
  const chave = nome + '|' + dono + (ehAdmin ? '|dono' : '|comum') + (espiando ? '|espiando' : '');

  const guardado = cachePagina.get(chave);
  if (guardado && guardado.mtimeMs === stat.mtimeMs && guardado.versao === config.getVersao()) {
    res.type('html');
    return res.send(guardado.html);
  }

  let html;
  try { html = fs.readFileSync(arquivo, 'utf-8'); } catch (e) { return next(); }
  html = config.aplicar(html, { ehAdmin, dono, espiando });
  cachePagina.set(chave, { mtimeMs: stat.mtimeMs, versao: config.getVersao(), html });
  res.type('html');
  res.send(html);
});

app.use(express.static('public'));

app.post('/api/reset', (req, res) => {
  const { db, live } = clientes.doPedido(req);
  db.resetAll();
  live.broadcastRanking();
  res.json({ ok: true });
});

// Limpa só o mural da tropa (o print da semana recomeça do zero). Ranking,
// likes, presentes e os níveis já conhecidos ficam de pé — diferente do
// /api/reset, que apaga tudo.
app.post('/api/tropa/limpar', (req, res) => {
  const { db, sala } = clientes.doPedido(req);
  db.limparTropa();
  io.to(sala).emit('tropa_limpa');
  res.json({ ok: true });
});

app.post('/api/tropa/remover', (req, res) => {
  const { nome, tipo } = req.body || {};
  if (!nome || !tipo) return res.status(400).json({ error: 'nome e tipo são obrigatórios' });
  const { db, sala } = clientes.doPedido(req);
  const removeu = db.removerDaTropa(nome, tipo);
  if (removeu) io.to(sala).emit('tropa_removida', { nome, tipo });
  res.json({ ok: true, removeu });
});

// Tudo que o streamer quer ver da live dele, num pedido só. O escopo vem do
// clientes.doPedido: cada um enxerga a própria live e nada mais.
app.get('/api/dashboard', (req, res) => {
  const { db } = clientes.doPedido(req);
  res.json(db.getDashboard());
});

// A curva da live, minuto a minuto. `agrupar` junta N minutos num ponto só —
// quem desenha sabe quantos pixels tem, o servidor não.
app.get('/api/serie', (req, res) => {
  const { db } = clientes.doPedido(req);
  const q = req.query || {};
  res.json(db.getSerie({
    desde: Number(q.desde) || undefined,
    ate: Number(q.ate) || undefined,
    agrupar: Number(q.agrupar) || undefined
  }));
});

// O olhar longo: melhores dias, dia da semana, horário e recordes.
app.get('/api/registros', (req, res) => {
  const { db } = clientes.doPedido(req);
  const dias = Number(req.query && req.query.dias);
  res.json(db.getRegistros({ dias: dias > 0 ? Math.min(dias, 400) : undefined }));
});

app.get('/api/batalhas', (req, res) => {
  res.json(clientes.doPedido(req).db.getBattleStats());
});

app.get('/api/ranking', (req, res) => {
  res.json(clientes.doPedido(req).db.getRanking());
});

app.get('/api/sessions', (req, res) => {
  res.json(clientes.doPedido(req).db.getSessions());
});

app.get('/api/user/:uniqueId', (req, res) => {
  const profile = clientes.doPedido(req).db.getUserProfile(req.params.uniqueId);
  if (!profile.user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(profile);
});

io.on('connection', socket => {
  // A sala é o que faz este navegador receber SÓ os eventos da live dele.
  // Sem o join, o socket fica surdo — e é assim que tem que ser: melhor uma
  // tela parada do que a tela com os dados de outro cliente.
  const { db, live, sala } = clientes.doSocket(socket);
  socket.join(sala);

  socket.emit('ranking', db.getRanking());
  socket.emit('live_status', { online: live.estaOnline() });
  socket.emit('live_feed_init', live.feed());
  socket.emit('global_stats', db.getGlobalStats());
  socket.emit('tropa_init', db.getTropa());
  socket.emit('battle_stats', db.getBattleStats());
  socket.emit('powerup_estoque', db.getEstoqueCartas());
  socket.emit('diagnostico_init', live.diagnostico());
});


process.on('uncaughtException', (err) => {
  console.error('Exceção não tratada:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Promise rejeitada sem tratamento:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(assinatura.resumo());

  // A live da casa sempre sobe. Além dela, sobe uma por cliente cadastrado —
  // quem tem `dono` no users.json (ver create-user.js --dono). Enquanto não
  // existir nenhum, isto é um laço vazio e nada muda.
  const donos = new Set([TIKTOK_USERNAME]);
  try {
    auth.loadUsers().forEach(u => { if (u.dono) donos.add(u.dono); });
  } catch (e) {
    console.error('Não consegui ler os clientes cadastrados:', e.message);
  }

  donos.forEach(dono => {
    try {
      clientes.iniciar(dono);
      console.log(`Motor da live @${dono} de pé.`);
    } catch (e) {
      // um cliente com problema não pode impedir os outros de subir
      console.error(`Falhei ao subir a live @${dono}:`, e.message);
    }
  });
});