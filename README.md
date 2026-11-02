# TEM LEÃO NA MIRA! 🎯

Ranking público da campanha dos snipers. O servidor fica conectado na live de
cada sniper no TikTok, guarda as horas de live e os diamantes de cada uma e
soma com as indicações que o administrador cadastra.

- **Visitante**: abre `/` (ou `/mira.html`) sem login, sem cadastro. Só leitura.
- **Administrador**: entra em `/login.html` e cuida das indicações e do status
  das lives em `/mira-admin.html`.

Este projeto nasceu de uma cópia do ranking de taps. O que era só de lá foi
removido; o módulo de coleta do TikTok (`live.js`, `db.js`, `banco.js`,
`assinatura.js`, `protocru.js`) veio inteiro e ainda grava coisas que a
campanha não lê (likes, power-ups, batalhas). Elas não aparecem em tela nenhuma.

---

## Como rodar

### Requisitos

**Node 24 ou mais novo.** Não é sugestão: o banco usa o SQLite que vem dentro do
Node (`node:sqlite`), que só existe do 24 pra frente. Numa versão mais velha o
servidor morre na subida com um recado explícito (`banco.js`), de propósito.

A versão fica travada em três lugares: `.node-version`, `engines` do
`package.json` e a checagem do `banco.js`.

### Passo a passo

```bash
npm install

# o primeiro administrador (só precisa na primeira vez)
node create-user.js caio umaSenhaBoa --admin

# os snipers da campanha (ou edite a lista no campanha.config.js)
export MIRA_SNIPERS=fulano,ciclano

# na sua máquina: DEV_LOCAL=1 (Git Bash / Linux / Mac)
DEV_LOCAL=1 npm start
```

No PowerShell, **não use `npm`**: ele roda por um `npm.ps1`, e a política de
execução padrão do Windows barra script `.ps1` com um erro que não tem nada a
ver com o projeto (`UnauthorizedAccess`). Chame o node direto:

```powershell
$env:DEV_LOCAL="1"; $env:MIRA_SNIPERS="fulano,ciclano"; node server.js
```

O site sobe em `http://localhost:3000` (ou na porta de `PORT`).

**`DEV_LOCAL=1` não é opcional na sua máquina.** Sem ela o servidor nem sobe
(exige `SESSION_SECRET`) e, se subisse, o cookie de sessão sairia `secure` — o
navegador não devolveria o cookie por HTTP puro e o login nunca passaria. Em
produção ela não existe: lá o padrão seguro é o certo.

Rode **de dentro da pasta do projeto**: os arquivos de dados (`users.json`,
`dados.db`, `sessions.json`) são relativos ao diretório de onde o processo subiu.

### Testes

```bash
npm test          # ou: node --test teste/pontuacao.js
```

Cobrem a conta nas bordas (0/499/500/999/1000 diamantes, 59/60 min de live),
o corte das lives no período e o desempate.

---

## Contas e acesso

**Só administrador entra.** O login confere a senha e depois a marca `admin`
do `users.json`; conta sem ela recebe "Esta conta não tem acesso" e não ganha
sessão. As contas antigas que vieram do ranking de taps continuam no arquivo,
só não entram. Sessão de quem perdeu o admin (ou teve a conta apagada) cai na
próxima requisição.

- Senha com hash (`scrypt` + salt), arquivo gravado com permissão 0600.
- Freio de tentativa: 10 erros em 15 min por IP e por usuário.
- Sessão de 30 dias sem acessar, renovada a cada visita; botão **Sair** destrói.
- Toda rota fora do ranking público passa pelo `requireAdmin` no servidor, e as
  rotas de indicação conferem de novo.

**Primeiro administrador:**

- na sua máquina: `node create-user.js <usuario> <senha> --admin`;
- em produção (onde não dá pra rodar script à mão): `ADMIN_USER` /
  `ADMIN_PASSWORD`. Só cria se ainda não existir — trocar a senha depois não é
  desfeito no restart. Se a conta já existe, ela é marcada como admin.

O servidor **não promove ninguém sozinho**: sem nenhum admin, ele avisa no log
e ninguém entra até você criar um.

---

## A campanha

**Pontuação** (só dentro do período da campanha), em `pontuacao.js`, com os
valores em `campanha.config.js`:

| Regra | Pontos |
|---|---|
| Cada 1h **completa** de live, somando todas as lives do período | 10 |
| Cada 500 diamantes: `floor(diamantes / 500) * 30` | 30 |
| Cada indicado que entrou oficialmente na MIRA e fez a 1ª live | 20 |

Empate: mais diamantes, depois mais horas.

**De onde vem cada número:**

- **Horas e diamantes**: do histórico de lives de cada sniper (`db.getSessions()`,
  mais a live que estiver no ar). Isso exige que o `@` esteja em `MIRA_SNIPERS`,
  porque só assim a live dele fica conectada. Live que não foi acompanhada (o
  servidor estava fora do ar, o sniper entrou depois) **não existe** pra conta.
- **Bordas do período**: a duração é cortada no início e no fim. O diamante vai
  pela live inteira, porque a sessão guarda o total e não a hora de cada presente.
- **Indicações**: entrada manual do administrador em `/mira-admin.html`, gravada
  na tabela `indicacoes` do `dados.db`. Um mesmo indicado só pode ser
  creditado uma vez.
- **Foto e nome**: do `roomInfo` que o `connect()` da lib já busca. É JSON cru do
  TikTok, e o caminho `data.owner.avatar_thumb.url_list` ainda **não foi
  conferido numa live real**. Sem foto, ou com foto vencida (a URL é assinada), a
  tela mostra o avatar padrão.

**Cache**: o ranking é recalculado no máximo a cada `MIRA_CACHE_MS`, e na hora
quando uma indicação muda. Se o cálculo de um sniper falha, ele fica com a
última linha boa. Se falha tudo, vale o último ranking.

**Status das lives** (no topo do `/mira-admin.html`, atualiza a cada 30s):
conectada ou desconectada, e a última vez que o servidor soube algo daquela
live — o último evento do TikTok com ela no ar, ou a última checagem de se ela
começou. Fora do ar, aparece também o motivo ("não está ao vivo agora",
"não achei essa live", limite do assinador…).

### Rotas

| Rota | Acesso |
|---|---|
| `GET /` | público — redireciona pro `/mira.html` |
| `GET /mira.html`, `GET /api/mira/ranking` | público, só leitura |
| `GET /login.html`, `POST /api/login` | público |
| `POST /api/logout` | administrador |
| `GET /mira-admin.html` | administrador |
| `GET /api/mira/status` | administrador |
| `GET/POST /api/mira/indicacoes`, `PUT/DELETE /api/mira/indicacoes/:id` | administrador |

---

## Assinatura da conexão (EulerStream)

Toda conexão com uma live passa por um servidor de assinatura — é ele que
devolve a URL do websocket que o TikTok aceita. O padrão é o
[EulerStream](https://api.eulerstream.com).

**Sem chave, a identificação é pelo IP, e o limite é por IP.** Como cada live e
cada reconexão pedem assinatura, com vários snipers esse é o primeiro gargalo.
Defina `EULERSTREAM_API_KEY` (ou `SIGN_API_KEY` — os dois nomes valem).

**Só o `connect()` custa cota.** O motor pergunta antes se o sniper está ao
vivo, por duas fontes grátis (HTML do TikTok e a API Live), e só conecta quando
existe live de verdade. Live parada custa zero de cota.

Um HTTP 429 do EulerStream chega disfarçado de
`TypeError: Cannot read properties of undefined (reading 'retry-after')` (bug da
`tiktok-live-connector@2.4.4`). Leia como **limite de assinatura estourado**; o
`assinatura.js` já reconhece.

Quando o `connect()` falha, a espera cresce (limite: 60s → 15 min; streamer
ainda não subiu: 10s → 60s; resto: 10s → 2 min), dobrando a cada falha com um
sorteio, pra várias lives não voltarem no mesmo instante.

---

## Variáveis de ambiente

| Variável | Pra que serve |
|---|---|
| `PORT` | Porta do servidor. Padrão: `3000`. |
| `SESSION_SECRET` | Segredo do cookie de sessão. **Obrigatória**: sem ela o servidor não sobe (só sobe com `DEV_LOCAL=1`, e aí com um segredo público). |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Cria o primeiro administrador na subida, se ele ainda não existir. |
| `MIRA_SNIPERS` | `@` dos snipers, separados por vírgula. Cada um vira uma live monitorada na subida. Sem ela, vale a lista do `campanha.config.js`. |
| `MIRA_INICIO` / `MIRA_FIM` | Período da campanha, em ISO com fuso (`2026-11-01T00:00:00-03:00`). Sem elas, vale o que está no `campanha.config.js`. |
| `MIRA_CACHE_MS` | De quanto em quanto tempo o ranking é recalculado. Padrão: `60000`. |
| `EULERSTREAM_API_KEY` / `SIGN_API_KEY` | Chave do assinador. Necessária na prática pra mais de uma live. |
| `SIGN_API_URL` | Aponta o assinador pra outro servidor. Serve pra investigação. |
| `INTERVALO_CHECAGEM_MS` | De quanto em quanto tempo perguntar se o sniper subiu. Padrão: `30000`. Não custa cota do assinador. |
| `DEV_LOCAL=1` | **Só na sua máquina.** Aceita rodar sem `SESSION_SECRET` e manda o cookie de sessão por HTTP. Em qualquer deploy, não defina. |
| `RAILWAY_ENVIRONMENT` | Quando existe, todos os arquivos de dados passam a morar em `/data`. |

Trocar os snipers ou o período pede restart: são lidos uma vez, na subida.

---

## Onde os dados moram

| Arquivo | O que guarda |
|---|---|
| `dados.db` | SQLite: as lives de cada sniper (uma linha por registro, com a coluna `dono`) e a tabela `indicacoes`. |
| `users.json` | Contas: usuário, salt, hash, `admin`. Gravado com permissão 0600. |
| `sessions.json` | Sessões abertas. |

Nada disso vai pro git (veja o `.gitignore`).

---

## Deploy (Railway)

Com `RAILWAY_ENVIRONMENT` presente, os arquivos de dados passam a morar em
**`/data`** — o disco persistente. Sem isso, cada deploy levaria junto o
`users.json`, o banco e as sessões.

O que configurar lá:

- um **volume montado em `/data`**;
- `SESSION_SECRET` (sem ela o servidor não sobe);
- `ADMIN_USER` / `ADMIN_PASSWORD` (pro primeiro acesso);
- `MIRA_SNIPERS`, e `MIRA_INICIO` / `MIRA_FIM` se o período mudar;
- `EULERSTREAM_API_KEY`;
- Node 24+ (o `.node-version` já pede).

Não precisa compilar nada: o SQLite vem dentro do Node.

---

## Mapa dos arquivos

```
server.js          rotas, sessão, login (só admin) e a subida das lives
clientes.js        o registro: @ do sniper -> { db, live }
live.js            o motor de uma live: conexão com o TikTok, eventos, reconexão
db.js              os dados de uma live, em memória, com o banco como espelho
banco.js           o SQLite (node:sqlite). Toda linha carrega o `dono`
assinatura.js      o estado do assinador da conexão
protocru.js        lê o protobuf cru pra achar campo que a lib não conhece
auth.js            contas, hash de senha, admin
session-store.js   sessões em arquivo
create-user.js     cadastro pela linha de comando
campanha.config.js valores da pontuação, período, snipers
pontuacao.js       a conta da campanha (pura, testada)
campanha.js        o ranking com cache e último dado bom, e o status das lives
indicacoes.js      quem indicou quem (tabela `indicacoes` no dados.db)

public/
  mira.html        ranking público (sem login)
  mira-admin.html  status das lives e indicações (só administrador)
  login.html       entrada do administrador
  assets/theme.css os tokens de tema

teste/
  pontuacao.js     a conta da campanha (node --test)
```

---

## Armadilhas conhecidas

- **Node 24.** Tentar rodar em 18 ou 20 falha na subida, com recado. É o
  `node:sqlite`.
- **Só conta live acompanhada.** Se o servidor estava fora do ar, ou o sniper
  entrou no `MIRA_SNIPERS` depois, aquela live não existe pra pontuação.
- **Uma chave de assinatura** antes de colocar vários snipers no ar. Sem ela o
  limite é por IP, e cada reconexão consome.
