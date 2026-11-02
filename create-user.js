// Script pra cadastrar (ou trocar a senha de) quem pode logar no site.
// Uso: node create-user.js <usuario> <senha> [--admin]
//   --admin  marca a conta como administradora. Só administrador entra no
//            site (área de indicações da campanha); conta sem isso fica
//            barrada no login.
const { upsertUser, USERS_FILE } = require('./auth');

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const [username, password] = args.filter(a => !a.startsWith('--'));

if (!username || !password) {
  console.log('Uso: node create-user.js <usuario> <senha> [--admin]');
  process.exit(1);
}

// sem --admin, quem já era admin continua sendo (ver upsertUser)
const registro = upsertUser(username, password, admin ? { admin: true } : undefined);
console.log(
  `Usuário "${username}"` +
  (registro.admin ? ' (administrador)' : ' (sem acesso: falta --admin)') +
  ` salvo em ${USERS_FILE}`
);
