// Script pra cadastrar (ou trocar a senha de) quem pode logar no site.
// Uso: node create-user.js <usuario> <senha> [--admin] [--dono=@fulano]
//   --admin        dá acesso à página de configuração (/admin.html)
//   --dono=@fulano amarra a pessoa à live daquele @: ela passa a ver os dados
//                  dessa live e só eles. Sem isso, cai na live padrão da
//                  instalação (a do TIKTOK_USERNAME).
const { upsertUser, USERS_FILE } = require('./auth');

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const argDono = args.find(a => a.startsWith('--dono='));
const dono = argDono ? argDono.slice('--dono='.length).replace(/^@+/, '') : undefined;
const [username, password] = args.filter(a => !a.startsWith('--'));

if (!username || !password) {
  console.log('Uso: node create-user.js <usuario> <senha> [--admin] [--dono=@fulano]');
  process.exit(1);
}

const opcoes = {};
if (admin) opcoes.admin = true;
if (dono !== undefined) opcoes.dono = dono;

upsertUser(username, password, Object.keys(opcoes).length ? opcoes : undefined);
console.log(
  `Usuário "${username}"` +
  (admin ? ' (administrador)' : '') +
  (dono ? ` — live @${dono}` : '') +
  ` salvo em ${USERS_FILE}`
);
if (dono) {
  console.log('Reinicie o servidor pra ele subir o motor dessa live.');
}
