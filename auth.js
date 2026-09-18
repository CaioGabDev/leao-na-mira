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

// `admin` e `dono` só entram no registro quando têm valor, pra não reescrever
// os usuarios antigos com campo a mais sem necessidade.
function upsertUser(username, password, opcoes) {
  const users = loadUsers();
  const { salt, hash } = hashPassword(password);
  const idx = users.findIndex(u => u.username === username);
  const record = { username, salt, hash };
  // quem já era admin continua sendo, a menos que se diga o contrário agora
  const eraAdmin = idx >= 0 && users[idx].admin === true;
  const querAdmin = opcoes && opcoes.admin !== undefined ? !!opcoes.admin : eraAdmin;
  if (querAdmin) record.admin = true;

  // `dono` é o @ da live que esta pessoa acompanha. Quem não tem cai no dono
  // padrão da instalação (ver clientes.js) — que é o caso de todo mundo hoje.
  const eraDono = idx >= 0 ? users[idx].dono : null;
  const querDono = opcoes && opcoes.dono !== undefined ? opcoes.dono : eraDono;
  const dono = String(querDono || '').trim().toLowerCase();
  if (dono) record.dono = dono;
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

// Quem pode abrir a página de configuração.
//
// A regra tem duas saídas de emergência porque o users.json que já está
// rodando em produção não tem campo `admin` nenhum — sem elas, ninguém
// conseguiria entrar na config da própria instalação:
//   1. alguém marcado explicitamente com admin: true
//   2. se NINGUÉM está marcado, vale o ADMIN_USER das env vars
//   3. se ainda assim ninguém, e só existe um usuário, é ele (instalação de
//      um dono só, que é o caso de toda instância hoje)
function ehAdmin(username) {
  if (!username) return false;
  const users = loadUsers();
  const eu = users.find(u => u.username === username);
  if (!eu) return false;
  if (eu.admin === true) return true;

  if (users.some(u => u.admin === true)) return false;   // já tem dono definido
  if (process.env.ADMIN_USER) return username === process.env.ADMIN_USER;
  return users.length === 1;
}

function verifyCredentials(username, password) {
  if (!username || !password) return false;
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  if (!user) return false;
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

// De qual live este usuário é. null = usa o dono padrão da instalação.
function donoDoUsuario(username) {
  if (!username) return null;
  const u = loadUsers().find(x => x.username === username);
  if (!u || !u.dono) return null;
  return String(u.dono).trim().toLowerCase() || null;
}

// Amarra um usuário a uma live (ou solta ele, com dono vazio).
function setDono(username, dono) {
  const users = loadUsers();
  const u = users.find(x => x.username === username);
  if (!u) return false;
  const limpo = String(dono || '').trim().toLowerCase();
  if (limpo) u.dono = limpo; else delete u.dono;
  saveUsers(users);
  return true;
}

module.exports = { USERS_FILE, loadUsers, saveUsers, hashPassword, upsertUser, setAdmin, ehAdmin,
                   donoDoUsuario, setDono, verifyCredentials, seedFromEnv };
