const fs = require('fs');
const crypto = require('crypto');

// Em produção (Railway) usa o disco persistente /data, igual ao live.json.
const USERS_FILE = process.env.RAILWAY_ENVIRONMENT ? '/data/users.json' : 'users.json';

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch (e) {
    console.error('Erro ao ler users.json:', e.message);
    return [];
  }
}

function saveUsers(users) {
  // 0600: só o dono do processo lê o arquivo com os hashes
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

// Troca só a senha e a marca de admin. O resto do registro antigo fica como
// estava: o users.json veio do ranking de taps, com campos (`dono`, `aceite`)
// que este site não usa mais, e trocar uma senha não é motivo pra apagá-los.
function upsertUser(username, password, opcoes) {
  const users = loadUsers();
  const { salt, hash } = hashPassword(password);
  const idx = users.findIndex(u => u.username === username);
  const record = { ...(idx >= 0 ? users[idx] : {}), username, salt, hash };
  // quem já era admin continua sendo, a menos que se diga o contrário agora
  const eraAdmin = idx >= 0 && users[idx].admin === true;
  const querAdmin = opcoes && opcoes.admin !== undefined ? !!opcoes.admin : eraAdmin;
  if (querAdmin) record.admin = true; else delete record.admin;
  if (idx >= 0) users[idx] = record;
  else users.push(record);
  saveUsers(users);
  return record;
}

// Marca alguém como dono do site sem mexer na senha dele.
function setAdmin(username, admin) {
  const users = loadUsers();
  const u = users.find(x => x.username === username);
  if (!u) return false;
  if (admin) u.admin = true; else delete u.admin;
  saveUsers(users);
  return true;
}

// Quem pode entrar no site: quem tem `admin: true`. Só isso. As outras contas
// do users.json (clientes do ranking de taps) continuam lá, mas não entram.
function ehAdmin(username) {
  if (!username) return false;
  const eu = loadUsers().find(u => u.username === username);
  return !!(eu && eu.admin === true);
}

// Roda na subida. Não promove ninguém sozinho: o users.json pode ter vindo
// do ranking de taps, e eleger uma conta qualquer como admin abriria a área
// de indicações pra um cliente antigo. Sem admin, só avisa alto.
function avisarSemAdmin() {
  if (loadUsers().some(u => u.admin === true)) return;
  console.warn(
    'AVISO: nenhuma conta é administradora, então ninguém consegue entrar. ' +
    'Rode: node create-user.js <usuario> <senha> --admin ' +
    '(ou defina ADMIN_USER/ADMIN_PASSWORD).'
  );
}

// O salt de mentira serve pra uma coisa só: gastar o mesmo tempo quando o
// usuário não existe. Sem isso, a resposta voltava na hora pra nome
// desconhecido e devagar pra nome conhecido — e essa diferença conta quais
// contas existem pra quem estiver medindo.
const SALT_DE_MENTIRA = crypto.randomBytes(16).toString('hex');

function verifyCredentials(username, password) {
  if (!username || typeof password !== 'string' || !password) return false;
  // senha maior que o máximo do cadastro não é senha de ninguém: recusar antes
  // do scrypt evita gastar CPU com um corpo grande de propósito
  if (password.length > 200) return false;
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  if (!user) {
    hashPassword(password, SALT_DE_MENTIRA);
    return false;
  }
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// No Railway não dá pra rodar o create-user.js à mão, e o users.json não vai
// no git. Então o primeiro usuário vem das env vars ADMIN_USER/ADMIN_PASSWORD.
// Só cria se ainda não existir: trocar a senha depois não é desfeito no restart.
function seedFromEnv() {
  const username = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  if (loadUsers().some(u => u.username === username)) {
    // já existe: não toca na senha, só garante que ele é o dono
    if (setAdmin(username, true)) {
      console.log(`Usuário "${username}" (ADMIN_USER) marcado como administrador.`);
    }
    return;
  }

  upsertUser(username, password, { admin: true });
  console.log(`Usuário "${username}" criado a partir de ADMIN_USER/ADMIN_PASSWORD.`);
}

// A conta ainda existe? Apagar alguém tem que valer pra quem já está logado,
// então isto é conferido a cada requisição. O arquivo é pequeno (dezenas de
// linhas), então ler e parsear sai mais barato que manter cache coerente.
function existe(username) {
  if (!username) return false;
  return loadUsers().some(u => u.username === username);
}

module.exports = { USERS_FILE, loadUsers, saveUsers, hashPassword, upsertUser, setAdmin, ehAdmin, existe,
                   avisarSemAdmin, verifyCredentials, seedFromEnv };
