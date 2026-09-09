// Script pra cadastrar (ou trocar a senha de) quem pode logar no site.
// Uso: node create-user.js <usuario> <senha>
const { upsertUser, USERS_FILE } = require('./auth');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.log('Uso: node create-user.js <usuario> <senha>');
  process.exit(1);
}

upsertUser(username, password);
console.log(`Usuário "${username}" salvo em ${USERS_FILE}`);
