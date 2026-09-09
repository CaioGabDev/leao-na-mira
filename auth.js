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
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function upsertUser(username, password) {
  const users = loadUsers();
  const { salt, hash } = hashPassword(password);
  const idx = users.findIndex(u => u.username === username);
  const record = { username, salt, hash };
  if (idx >= 0) users[idx] = record;
  else users.push(record);
  saveUsers(users);
  return record;
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

module.exports = { USERS_FILE, loadUsers, saveUsers, hashPassword, upsertUser, verifyCredentials };
