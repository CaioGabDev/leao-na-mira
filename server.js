const express = require('express');
const http = require('http');
const session = require('express-session');
const path = require('path');
const criarRegistro = require('./clientes');
const assinatura = require('./assinatura');
const auth = require('./auth');
const { FileSessionStore } = require('./session-store');
const campanhaConfig = require('./campanha.config');
const criarCampanha = require('./campanha');
const indicacoes = require('./indicacoes');

const app = express();
const server = http.createServer(app);

// Uma live por sniper, cada uma com o próprio banco. O campanha.js lê delas.
const clientes = criarRegistro();
const campanha = criarCampanha({ clientes });

// ---------- Login / sessão ----------
// Só administrador entra: é quem cadastra as indicações. Contas são criadas com
// `node create-user.js <usuario> <senha> --admin` (gera/atualiza o users.json)
// ou pelas env vars ADMIN_USER/ADMIN_PASSWORD. Veja o README.
// As duas frouxuras que só fazem sentido numa máquina de desenvolvimento —
// segredo de sessão de brinquedo e cookie sem `secure` — ficam atrás desta
// variável, e de mais nada. Antes dependiam de `NODE_ENV`: esquecer a variável
// no deploy deixava a sessão com um segredo que está no git e o cookie viajando
// em HTTP, e o servidor subia igual, só com um aviso no log que ninguém lê.
// Agora o padrão é o seguro, e quem quer o frouxo pede.
const DEV_LOCAL = process.env.DEV_LOCAL === '1';

// Atrás de proxy (Railway) o `secure` do cookie só funciona com isto ligado,
// e é o que faz o req.ip ser o IP de quem pediu — o freio de tentativa conta
// por IP, então sem isto todo mundo viraria o mesmo IP do proxy.
if (!DEV_LOCAL) app.set('trust proxy', 1);

// ---------- cabeçalhos de segurança ----------
// À mão, e não com o helmet, pelo mesmo motivo do node:sqlite: dependência nova
// é coisa pra atualizar e auditar pra sempre, e o que se precisa aqui são sete
// cabeçalhos fixos. Primeiro middleware de propósito: assim até a resposta 401 e
// o arquivo estático saem com eles.
//
// A CSP não proíbe script inline: as páginas deste projeto têm o <script> no
// corpo. O que ela faz é o que dá pra fazer sem reescrever as telas: script só
// da própria origem, nada de <object>, nada de <base>, nenhum site pode
// embutir esta página num iframe e formulário só posta aqui dentro.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  // o googleapis é a folha do Google Fonts, que toda página carrega
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // os avatares vêm de vários domínios do TikTok, que mudam sem avisar
  "img-src 'self' data: https:",
  "connect-src 'self'",
  // o arquivo da fonte em si vem do gstatic, não do googleapis
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // só faz sentido onde já se está em HTTPS; em dev seria um tiro no pé, porque
  // o navegador passa a recusar http://localhost por meses
  if (!DEV_LOCAL) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

auth.seedFromEnv();
auth.avisarSemAdmin();

// Sem segredo não tem sessão: o cookie de sessão é o que separa o admin de
// qualquer visitante, e com um segredo conhecido dá pra forjar um.
// Então falta de SESSION_SECRET derruba a subida em vez de virar aviso.
const SESSION_SECRET = process.env.SESSION_SECRET
  || (DEV_LOCAL ? 'dev-only-secret-troque-em-producao' : null);
if (!SESSION_SECRET) {
  console.error(
    'ERRO: SESSION_SECRET não definido. Gere um segredo longo e aleatório e ' +
    'configure essa env var (no Railway, em Variables). Pra rodar na sua ' +
    'máquina sem ela, suba com DEV_LOCAL=1.'
  );
  process.exit(1);
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
    // padrão seguro: só uma subida com DEV_LOCAL=1 aceita cookie em HTTP
    secure: !DEV_LOCAL,
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 dias sem acessar
  }
});
app.use(sessionMiddleware);
app.use(express.json());

// ---------- freio de tentativa de senha ----------
// O login é público e senha é coisa que dá pra chutar — as senhas têm 6
// caracteres de mínimo.
//
// Conta por IP E por usuário, as duas contas no mesmo balde: só por IP, uma
// rede grande (ou um IP trocado a cada tentativa) passa por cima do freio; só
// por usuário, dá pra varrer uma lista de contas de um IP só sem nunca
// esbarrar. Acertar a senha zera as duas — quem entrou não está chutando.
const LOGIN_LIMITE = 10;
const LOGIN_JANELA = 15 * 60 * 1000;
const tentativasDeLogin = new Map();   // 'ip:x' | 'user:y' -> { contagem, ate }

function baldesDoLogin(req, usuario) {
  return ['ip:' + (req.ip || 'desconhecido'),
          'user:' + String(usuario || '').trim().toLowerCase()];
}

function loginTravado(req, usuario) {
  const agora = Date.now();
  return baldesDoLogin(req, usuario).some(balde => {
    const atual = tentativasDeLogin.get(balde);
    return !!atual && agora < atual.ate && atual.contagem >= LOGIN_LIMITE;
  });
}

function errouASenha(req, usuario) {
  const agora = Date.now();
  baldesDoLogin(req, usuario).forEach(balde => {
    const atual = tentativasDeLogin.get(balde);
    if (!atual || agora > atual.ate) {
      tentativasDeLogin.set(balde, { contagem: 1, ate: agora + LOGIN_JANELA });
    } else {
      atual.contagem++;
    }
  });
}

function acertouASenha(req, usuario) {
  baldesDoLogin(req, usuario).forEach(balde => tentativasDeLogin.delete(balde));
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (loginTravado(req, username)) {
    return res.status(429).json({ error: 'Muitas tentativas. Espere alguns minutos.' });
  }
  if (!auth.verifyCredentials(username, password)) {
    errouASenha(req, username);
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  // Senha certa não basta: o users.json veio do ranking de taps e ainda tem
  // as contas dos clientes de lá. Elas ficam no arquivo, mas não entram. Conta
  // no freio igual a uma senha errada, pra não virar um jeito de conferir
  // senha de conta alheia sem limite.
  if (!auth.ehAdmin(username)) {
    errouASenha(req, username);
    return res.status(403).json({ error: 'Esta conta não tem acesso. Só administradores entram.' });
  }
  acertouASenha(req, username);
  // troca o id da sessão ao logar, pra um id capturado antes do login não valer nada
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
    req.session.user = username;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: 'Erro ao iniciar a sessão.' });
      res.json({ ok: true, destino: '/mira-admin.html' });
    });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// O portão de tudo que não é público: sessão de um administrador que ainda
// existe e ainda é administrador.
//
// Sessão aberta não basta: a conta pode ter sido apagada (ou perdido o admin)
// depois do login, e as sessões vêm do disco — inclusive as dos clientes do
// ranking de taps, que logavam antes desta versão. Sem esta conferência, quem
// já estava com a aba aberta seguia navegando até o cookie vencer.
function requireAdmin(req, res, next) {
  const usuario = req.session && req.session.user;
  if (usuario && auth.ehAdmin(usuario)) return next();

  if (usuario) req.session.destroy(() => {});   // sessão sem admin não serve pra nada
  // req.path aqui pode vir sem o prefixo montado, então quem responde é o originalUrl
  if ((req.originalUrl || '').startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
}

// O que o visitante acessa sem login: o ranking (página e dados, SÓ leitura)
// e a porta de entrada do admin. Todo o resto — inclusive qualquer rota de
// escrita — passa pelo requireAdmin.
const PUBLICO = new Set([
  '/', '/mira.html', '/api/mira/ranking',
  '/login.html', '/api/login'
]);

app.use((req, res, next) => {
  if (PUBLICO.has(req.path)) return next();
  requireAdmin(req, res, next);
});

// a página inicial é o ranking
app.get('/', (req, res) => res.redirect('/mira.html'));

// pelo __dirname: subir o servidor de outra pasta não pode deixar o site sem páginas
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CAMPANHA "TEM LEÃO NA MIRA" ----------
// O ranking é público (está no PUBLICO) e sai do cache do campanha.js —
// visita nenhuma chega perto do TikTok. As indicações e o status passam pelo
// portão lá em cima E pelo requireAdmin de novo aqui: se um dia alguém mexer
// no portão, a rota de escrita continua fechada.
app.get('/api/mira/ranking', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(campanha.getRanking());
});

app.get('/api/mira/status', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ agora: Date.now(), snipers: campanha.status() });
});

app.get('/api/mira/indicacoes', requireAdmin, (req, res) => {
  res.json({ snipers: campanha.snipers(), indicacoes: indicacoes.listar() });
});

function respostaDaIndicacao(res, r) {
  if (r.erro) return res.status(r.status || 400).json({ error: r.erro });
  campanha.invalidar();
  res.json({ ok: true, indicacao: r.indicacao });
}

app.post('/api/mira/indicacoes', requireAdmin, (req, res) => {
  respostaDaIndicacao(res, indicacoes.criar(req.body, req.session.user));
});

app.put('/api/mira/indicacoes/:id', requireAdmin, (req, res) => {
  respostaDaIndicacao(res, indicacoes.atualizar(req.params.id, req.body, req.session.user));
});

app.delete('/api/mira/indicacoes/:id', requireAdmin, (req, res) => {
  if (!indicacoes.remover(req.params.id)) return res.status(404).json({ error: 'Indicação não encontrada.' });
  campanha.invalidar();
  res.json({ ok: true });
});

// Último a entrar de propósito: o Express só usa isto se nenhuma rota respondeu.
// Sem ele, um erro dentro de uma rota caía no handler padrão do Express, que
// manda a stack trace inteira pro navegador quando NODE_ENV não é 'production'
// — caminhos de arquivo, nomes de função e número de linha pra quem pediu.
// O log completo continua, só não vai mais pela resposta.
app.use((err, req, res, next) => {
  console.error(`Erro em ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  if ((req.originalUrl || '').startsWith('/api/')) {
    return res.status(500).json({ error: 'Algo deu errado aqui dentro.' });
  }
  res.status(500).type('text').send('Algo deu errado aqui dentro.');
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

  // Sobe a live de cada sniper: sem ela conectada não há o que pontuar.
  if (!campanhaConfig.snipers.length) {
    console.warn('AVISO: nenhum sniper na campanha. Defina MIRA_SNIPERS ou edite o campanha.config.js.');
  }
  campanhaConfig.snipers.forEach(sniper => {
    try {
      clientes.iniciar(sniper);
      console.log(`Motor da live @${sniper} de pé.`);
    } catch (e) {
      // um sniper com problema não pode impedir os outros de subir
      console.error(`Falhei ao subir a live @${sniper}:`, e.message);
    }
  });
});
