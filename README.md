# Ranking da Live

Painel em tempo real para lives do TikTok. Ele fica conectado na live, escuta o
que acontece lá (likes, presentes, comentários, seguidores, batalhas de PK) e
transforma isso em ranking, mural da tropa, estoque de power-ups e histórico.

Um servidor só atende **vários clientes ao mesmo tempo**: cada cliente é o `@`
de uma live, com os dados dele, a marca dele e as pessoas dele — sem enxergar
a live de ninguém.

---

## Sumário

- [Como rodar](#como-rodar)
- [As telas](#as-telas)
- [Contas e acesso](#contas-e-acesso)
- [Multi-cliente: como um servidor segura várias lives](#multi-cliente-como-um-servidor-segura-várias-lives)
- [O que o motor da live escuta](#o-que-o-motor-da-live-escuta)
- [Onde os dados moram](#onde-os-dados-moram)
- [Aparência (configuração)](#aparência-configuração)
- [Assinatura da conexão (EulerStream)](#assinatura-da-conexão-eulerstream)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [API](#api)
- [Eventos de socket](#eventos-de-socket)
- [Deploy (Railway)](#deploy-railway)
- [Campanha "TEM LEÃO NA MIRA! 🎯"](#campanha-tem-leão-na-mira-)
- [Mapa dos arquivos](#mapa-dos-arquivos)
- [Armadilhas conhecidas](#armadilhas-conhecidas)

---

## Como rodar

### Requisitos

**Node 24 ou mais novo.** Não é sugestão: o banco usa o SQLite que vem dentro do
Node (`node:sqlite`), que só existe do 24 pra frente. Numa versão mais velha o
servidor morre na subida com um recado explícito (`banco.js`), de propósito —
melhor do que um `Cannot find module` no meio do log.

A versão fica travada em três lugares: `.node-version`, `engines` do
`package.json` e a checagem do `banco.js`.

### Passo a passo

```bash
npm install

# o primeiro usuário (só precisa na primeira vez)
node create-user.js caio umaSenhaBoa --admin

# na sua máquina: DEV_LOCAL=1 (Git Bash / Linux / Mac)
DEV_LOCAL=1 npm start
```

No PowerShell, **não use `npm`**: ele roda por um `npm.ps1`, e a política de
execução padrão do Windows barra script `.ps1` com um erro que não tem nada a
ver com o projeto (`UnauthorizedAccess`). Como `npm start` é literalmente
`node server.js`, chame o node direto:

```powershell
$env:DEV_LOCAL="1"; node server.js
```

Se quiser o `npm` funcionando no PowerShell pra valer, ou use `npm.cmd start`
(que não passa pelo `.ps1`), ou libere a política uma vez:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

O site sobe em `http://localhost:3000` (ou na porta de `PORT`).

**`DEV_LOCAL=1` não é opcional aqui.** Sem ela o servidor nem sobe (exige
`SESSION_SECRET`) e, se subisse, o cookie de sessão sairia `secure` — o
navegador não devolveria o cookie por HTTP puro e o login nunca passaria. Em
produção ela não existe: lá o padrão seguro é o certo.

### Ver o mural antes de subir pro Railway

O administrador **não mora nas telas de uma live** — abrir `/mural.html` logado
como administrador manda ele de volta pro `/admin.html`. Pra ver o mural de uma
live, entre nela pelo **👁️ Ver a live** do painel; daí em diante a sessão diz de
quem é a tela, e o mural, o fundo e as cores são os daquela live.

A lista de pessoas do mural fica no `localStorage` do navegador, não no
servidor: dá pra inventar nome e nível à vontade pra ver como a arte fica, sem
sujar dado nenhum.

Rode **de dentro da pasta do projeto**. Os arquivos de dados (`users.json`,
`dados.db`, `config.json`, …) e o `express.static('public')` são relativos ao
diretório de onde o processo subiu.

### Qual live ele acompanha

A live da casa é decidida na subida do servidor, nesta ordem:

1. `live.usuario` do `config.json` (o que o administrador salvou na tela)
2. a variável `TIKTOK_USERNAME`
3. o padrão cravado no código

É lido **uma vez, na subida**, de propósito: trocar de live com a coisa rodando
misturaria os dados de duas lives no mesmo lugar. Depois de trocar o `@`,
reinicie.

Além da live da casa, o servidor sobe uma live por cliente cadastrado — todo
mundo que tem `dono` no `users.json`.

### Primeiro acesso

Se ninguém for administrador, ninguém abre a configuração. O servidor tenta
resolver isso sozinho na subida (`auth.garantirDono()`): se existe uma conta só,
ela vira a dona; se existe `ADMIN_USER`, é ela. Não dando pra decidir, ele avisa
no log e você resolve com `node create-user.js <usuario> <senha> --admin`.

Em produção, onde não dá pra rodar script à mão, o primeiro usuário nasce das
variáveis `ADMIN_USER` / `ADMIN_PASSWORD` (`auth.seedFromEnv()`). Ele só é
criado se ainda não existir — trocar a senha depois não é desfeito no restart.

---

## As telas

| Tela | Quem vê | O que é |
|---|---|---|
| `index.html` | cliente | O ranking em tempo real. A tela principal, a que vai pro OBS. |
| `mural.html` | cliente | Mural da tropa: quem subiu de nível, superfãs, e a geração da imagem pra postar. |
| `painel.html` | cliente | Os números da live: curva minuto a minuto, melhores dias, horários, recordes. |
| `diagnostico.html` | cliente | Log cru do que está chegando do TikTok. É a tela de "por que isso não contou?". |
| `admin.html` | administrador | Painel do negócio: todos os clientes, os números de cada live, as contas e as chaves. |
| `config.html` | cliente e administrador | Aparência: marca, cores, textos. O cliente mexe na cara da live dele; o administrador escolhe de quem é a cara que está mexendo. |
| `login.html` | todo mundo | Entrada. |
| `ativar.html` | quem tem chave | Onde o cliente troca a chave de ativação por uma conta que ele mesmo escolhe. |

As páginas são arquivos estáticos com `{{marcadores}}`. O servidor troca os
marcadores pelo config de quem está logado **antes** de entregar — por isso esse
middleware vem antes do `express.static`, senão o arquivo cru seria servido. O
resultado fica em cache por `nome|dono|admin|espiando`, invalidado pelo mtime do
arquivo e pela versão do config.

O administrador **não mora nas telas de cliente**: pedir `index.html` sendo
admin redireciona pro `admin.html`. Pra olhar a live de um cliente ele usa
*espiar* (abaixo).

---

## Contas e acesso

Uma conta tem dois eixos independentes, e eles não se misturam:

- **`admin: true`** — abre `/admin.html`, `/api/clientes`, `/api/chaves` e
  `/api/espiar`. É o dono do negócio.
- **`dono: "@fulano"`** — de qual live aquela conta é. Sem isso, cai na live da
  casa.

Administrador **não pertence a live nenhuma**. Ele é a casa, não um streamer.
Por isso ele não aparece na lista de usuários de nenhum cliente e não abre as
telas de cliente sem espiar.

### Espiar

O administrador precisa olhar a live de um cliente de vez em quando (suporte,
conferir se está contando). `GET /api/espiar?dono=@fulano` guarda esse `@` **na
sessão dele**, e a partir daí as telas de cliente mostram a live do cliente.
`GET /api/espiar/sair` desfaz. A marca de admin é conferida na hora de resolver
a sessão (`clientes.daSessao`), então um cliente que forje `espiando` continua
caindo na live dele.

### Como entra gente nova

**O caminho bom — chave de ativação.** O administrador gera uma chave dizendo só
de qual live ela é. O cliente digita a chave em `ativar.html` e escolhe o
próprio usuário e a própria senha. A senha nunca passa pela mão de ninguém.

A chave é de uso único, vence (padrão configurável em `chaves.js`), e depois de
usada vira registro histórico — não é apagada, pra o painel conseguir mostrar
quem ativou e quando. O alfabeto não tem `I`, `L`, `O`, `0` nem `1`: alguém vai
ler isso de um print e digitar na mão. Chute de chave tem castigo por IP.

**O caminho manual — a linha de comando:**

```bash
node create-user.js <usuario> <senha> [--admin] [--dono=@fulano]
```

**Pelo painel.** O administrador também cria conta direto no `admin.html`, e
pode promover um cliente a administrador ou rebaixar de volta.

Duas travas no servidor, que a tela não pode contornar: ninguém se rebaixa nem
se apaga sozinho, e a instalação nunca fica sem nenhum administrador — senão a
configuração viraria uma porta trancada por dentro.

Tirar o acesso de alguém **não apaga os dados da live dele**. Apagar é
irreversível e não pode sair de um clique numa lista.

### Sessões

Ficam em arquivo (`sessions.json`), não só na memória: sem isso todo deploy
deslogaria todo mundo. Cookie `httpOnly`, `sameSite: lax`, `secure` em produção,
30 dias de validade que se renovam a cada visita (`rolling`). O login regenera
o id da sessão, pra um id capturado antes não valer nada depois.

A cada requisição o servidor confere se a conta **ainda existe**
(`auth.existe()`). Apagar alguém tem que valer na hora, inclusive pra quem já
está com a tela aberta.

---

## Multi-cliente: como um servidor segura várias lives

A pergunta "de quem é esta requisição?" tem uma resposta só, e ela mora no
`clientes.js`:

```
usuário logado  ->  dono (o @ da live)  ->  cliente { db, live, sala }
```

Cada cliente é:

- um **`db`** próprio (`db.paraDono('@fulano')`) — estado em memória, espelhado
  no SQLite;
- um **motor de live** próprio (`criarLive(...)`) — a conexão com o TikTok, o
  feed, o diagnóstico e os relógios dele;
- uma **sala do socket.io** (`dono:@fulano`) — o motor fala com `io.to(sala)`,
  nunca com `io.emit`. Essa é a linha que impede um cliente de ver a live do
  outro em tempo real.

Abrir um cliente acontece a cada requisição e é barato (reaproveita o que já
está aberto). **Ligar** o motor — que conecta no TikTok — é outra coisa, e só
acontece no `iniciar()`: na subida do servidor e quando um cliente novo é
cadastrado (aí a live dele sobe na hora, sem reiniciar).

---

## O que o motor da live escuta

O `live.js` é o miolo. Ele traduz eventos do TikTok em dados:

| Evento | Vira |
|---|---|
| `like` | pontos no ranking |
| `gift` | diamantes no ranking — ou **power-up**, se for GG, Rocket ou Universe |
| `chat` | comentário no feed, e leitura do nível do selo |
| `follow`, `share`, `social` | contadores sociais |
| `member` | entrada na sala |
| `roomUser` | contagem de espectadores e pico |
| `streamEnd` | fecha a sessão da live de verdade |
| `linkMicBattle`, `linkMicArmies` | batalha de PK: placar ao vivo e histórico |
| `linkMicBattleItemCard` | cartas de power-up ganhas no PK |
| `superFan`, `superFanJoin`, `barrage` | superfã |

Alguns detalhes que custaram caro e estão comentados no código:

- **Nível**: a fonte é o **selo** que aparece do lado do nome, e só ele. Antes o
  código cruzava `payGrade` e `fansClub` como reforço; as fontes discordavam e a
  diferença era lida como "subiu de nível". A primeira leitura de uma pessoa só
  anota o ponto de partida, sem anunciar — senão quem já era nível 17 há meses
  entraria no mural como se tivesse acabado de subir. O mural mostra do nível 10
  pra cima.
- **Presente em rajada**: presente de tipo 1 só conta quando a rajada termina
  (`repeatEnd`), senão cada tap contaria de novo.
- **Cartas de PK**: valem 5 dias e depois vencem sozinhas. Quantas cartas uma
  premiação deu é a única coisa que o TikTok não manda pela live — ele mostra só
  no painel dele — então quem informa é quem está assistindo,
  por `POST /api/powerup/itens`.
- **Watchdog**: comentário também conta como sinal de vida. Sem isso, numa live
  de muita conversa e pouco like o watchdog forçava reconexão a cada 5 minutos,
  a sessão era dada como encerrada e a duração voltava do zero no meio da live.
- **Reconexão ≠ live nova**: queda de rede não fecha a sessão. Só `streamEnd`,
  ou o watchdog depois do prazo de tolerância.
- **`protocru.js`**: lê o protobuf cru, sem schema. Quando o TikTok acrescenta
  um campo, a biblioteca decodifica o que conhece e pula o resto **em silêncio**
  — o campo existe nos bytes e some antes de chegar em qualquer lugar visível.
  Este módulo decodifica, re-codifica e compara os números de campo, pra
  descobrir o que a biblioteca não conhece.

---

## Onde os dados moram

| Arquivo | O que guarda |
|---|---|
| `dados.db` | **A fonte da verdade.** SQLite, uma linha por registro, sempre com a coluna `dono`. |
| `users.json` | Contas: usuário, salt, hash, `admin`, `dono`. Gravado com permissão 0600. |
| `chaves.json` | Chaves de ativação e o histórico de quem usou. |
| `config.json` | Aparência da instalação e de cada cliente. |
| `sessions.json` | Sessões abertas. |
| `live.json` | Espelho no formato antigo, **só da live da casa**. Existe pra dar pra voltar pro código pré-SQLite sem perder nada. Clientes novos não espelham. |

Nada disso vai pro git (veja o `.gitignore`).

O estado fica **inteiro em memória** — é o que aguenta os picos de tap — e o
banco é o espelho dele, gravado a cada 5 segundos e sempre dentro de uma
transação.

Cada linha guarda o objeto em **JSON**, e as colunas de verdade são só as que
servem pra separar e ordenar (`dono`, `id`, posição). O motivo está no
`banco.js`: os objetos ganham campo novo com frequência (powerups,
`gifterLevel`, `superFaEm`…), e uma coluna por campo obrigaria a migrar o schema
toda vez, com risco de perder dado calado no caminho.

---

## Aparência (configuração)

O código é o mesmo pra todo mundo; o que muda mora no `config.js`, em dois
níveis:

- **Instalação** — a cara padrão do site e o `@` da live da casa.
- **Cliente** — a cara de um cliente, por `dono`.

O cliente só preenche o que quer diferente; o que ele não mexer cai na
configuração da instalação. Por isso `get(dono)` devolve sempre um config
completo, nunca pela metade.

Dá pra configurar: nome e lema do **produto** (o que aparece no login e no
ativar — a porta do produto, antes de a pessoa pertencer a uma live), emoji /
título / subtítulo da **marca**, títulos do **mural**, as **cores** do tema
(fundo, card, dourado, as duas brasas do gradiente e as duas brasinhas que sobem
no fundo) e o `@` da **live**.

### A foto de fundo do mural — a única coisa que **não** se herda

O mural gera a imagem que o streamer posta no story, e o fundo dela era uma
constante no HTML: `foto_da_tropa_hd.jpg`, um arquivo só pro site inteiro. Como
era um só, todo streamer novo gerava o story dele com a foto da tropa de outro.

A correção não foi só "deixar trocar": foi tirar a foto da herança.

Todo o resto da aparência desce da instalação pro cliente — quem não escolhe
título usa o título padrão. **Se o fundo descesse igual, a foto da casa voltaria
a ser a de todo mundo**, que é exatamente o problema. Então:

- a foto é **por live**, nunca da instalação. O administrador sem live escolhida
  recebe **400** com o motivo escrito, em vez de gravar uma foto que vazaria
  pra todos;
- quem não escolheu nenhuma **não herda a de ninguém**: o mural desenha um
  degradê nas cores da própria marca, e um convite dentro da área da imagem
  dizendo o que falta. O convite é `ignoreElements` no `html2canvas` — ele é
  instrução de tela, não parte do story, e sairia escrito na imagem baixada;
- a live da casa já tinha a dela. Na primeira subida o `fundos.semear()` move a
  foto do repositório pra dentro do fundo **daquela** live e anota num
  `.semeados`, pra quem apagar de propósito não ver a foto voltar no restart.

A foto mora no disco persistente (`/data/fundos`), **não** no `config.json`: o
config é um arquivo pequeno que dá pra abrir e ler com o olho, e centenas de KB
de base64 por cliente acabariam com isso. E o disco é a única verdade — não
existe campo no config dizendo "tenho foto", porque dois lugares guardando o
mesmo fato é um lugar a mais pra eles discordarem.

**O fundo do poster puxa a cor da foto.** A base embaixo da arte era `#000`
cravado, então arte azul em cima e preto puro embaixo pareciam duas peças
coladas, com a emenda à mostra. A correção não é escolher "uma cor bonita": é
amostrar **a borda de baixo do que aparece na tela** — o pixel que encosta no
corte — e continuar ela pra baixo escurecendo. A emenda some porque os dois
lados saem do mesmo pixel. As brasinhas seguem o mesmo acento: faísca laranja
numa arte azul destoa.

**Mas a cor fica só na emenda.** A primeira versão pintava o poster inteiro com
o matiz da foto. Deu certo numa arte azul e virou lama numa arte quente — porque
aí o fundo ficou do mesmo tom do laranja das pílulas, e poster de um tom só não
tem o que saltar. O preto que estava lá antes era **neutro**, e neutro deixa a
cor aparecer no que importa: a foto, os níveis, os tipos. Então a cor faz só o
trabalho que justificou ela existir — matar a emenda — e morre em ~30%: o corpo
do poster é quase preto (luz 4%), com um sopro do matiz.

A **pílula de cada pessoa** segue a mesma régua: era um marrom cravado
(`rgba(15,11,8)`), que numa arte azul ficava boiando. Agora é um cinza-escuro do
matiz (saturação ≤14%), nunca o matiz cheio — é ela que precisa deixar o
laranja/azul/roxo do tipo saltar.

E ela pinta a partir **do corte, não antes**: a faixa das linhas sobe 34px por
cima da foto (`margin-top: -34px`) e tem z-index maior. Com fundo preto isso
nunca apareceu — preto sobre preto. Com a cor da foto virou uma tarja clara
atravessada embaixo do retrato.

Na linha, **o acento substituiu o contorno**. Cada linha tinha três anéis na
cor do tipo — a borda da pílula, a borda do disco do ícone e a borda do selo do
nível — mais um halo em volta. Contorno em tudo é o que faz uma composição ler
como interface de jogo em vez de arte: o olho não tem onde descansar e nada tem
peso maior que o resto.

Então: o tipo virou uma **barra de 3,5px na esquerda**; o nível perdeu a caixa e
virou **número grande na cor do tipo** com o rótulo miúdo em cima (como placar e
escalação são desenhados); o disco perdeu a borda; e a borda que sobrou é neutra
e quase invisível, só pra separar a linha do fundo. O `box-shadow` saiu de vez —
ele não chega no PNG e, na tela, era mais um halo numa composição que já tinha
contorno demais.

A barra é uma camada com `background-size`/`no-repeat` explícitos, **não** uma
parada seca no gradiente: medido no PNG, a parada seca deixava um fiapo de 2px
da cor na borda **direita** da linha.

Quem não tem nível (superfã) mantém o ícone à direita, pra linha não terminar
num vazio.

Três decisões seguram a qualidade disso, e estão travadas em
`teste/fundo-cores.js`: foto cinza **não** vira cor (inventar matiz onde não tem
é pior que preto); a base entra com saturação cortada e luz baixa, senão o nome
de quem está na lista briga com ela pra ser lido; e a cor sai em
`hsl(h, s%, l%)` **com vírgula**, que é a forma que o parser do html2canvas lê —
cor que ele não entende vira preto, e o PNG baixado é o produto.

### O que o html2canvas renderiza (e o que ele estraga)

O PNG baixado é o produto, então o poster só usa efeito que sai igual nos dois
lados. Medido nesta versão da biblioteca (1.4.1):

| efeito | sai no PNG? |
|---|---|
| `linear-gradient` / `radial-gradient` | sim, idêntico |
| imagem em `data:` URL (o grão) | sim |
| `box-shadow` | **não — e estraga**: preenche o elemento inteiro com a cor da sombra |
| `filter: blur()` / `mix-blend-mode` | não, somem |

Por isso o brilho de cada pílula é um `radial-gradient` e não um `box-shadow`, e
o grão é um PNG de ruído gerado na hora em vez de um filtro. O `box-shadow` que
sobrou nas linhas é só pra tela, e só não estraga o arquivo porque o
`background` delas é imagem e cobre o estrago.

**O grão** é o que mais separa "imagem" de "tela de aplicativo" — superfície
lisa demais lê como interface. Entra com alfa baixo e esparso: na primeira
tentativa foi alfa 30 em metade dos pixels e o poster virou chiado de JPEG ruim.

Na entrada, o que decide se é imagem são os **bytes** (JPEG/PNG/WebP pela
assinatura), nunca a extensão nem o `Content-Type`: os dois vêm de quem está
enviando. O navegador reduz pra 1600px antes de subir — foto de celular tem
4000px e o poster sai em 1080px, então o resto é peso puro.

Tudo que entra aqui veio de um formulário e vai parar dentro de HTML e de CSS,
então nada é aproveitado como veio: texto perde caracteres de controle e é
cortado no limite; cor só passa se for hexadecimal de 6 dígitos — é isso que
impede alguém de fechar a regra do CSS e injetar o que quiser; o `@` vira
minúsculo sempre, porque o banco, o registro de clientes e o config usam o `@`
em caixa baixa como chave.

---

## Assinatura da conexão (EulerStream)

Toda conexão com uma live passa por um servidor de assinatura — é ele que
devolve a URL do websocket que o TikTok aceita. O padrão é o
[EulerStream](https://api.eulerstream.com).

**Sem chave, a identificação é pelo IP, e o limite é por IP.** Como cada live e
cada reconexão pedem assinatura, esse é o primeiro gargalo que aparece quando o
servidor passa a segurar vários clientes. Antes de colocar mais de uma live pra
rodar, defina `EULERSTREAM_API_KEY` (ou `SIGN_API_KEY` — os dois nomes valem).

O `assinatura.js` não guarda nem mostra a chave: só diz se existe uma, e sabe
distinguir "o assinador recusou" de "a rede caiu". Sem essa distinção, limite
estourado vira "sei lá, não conecta".

### Quando o limite estoura

Um HTTP 429 do EulerStream **não** chega como erro de limite: a
`tiktok-live-connector@2.4.4` passa o corpo da resposta no lugar da resposta
inteira ao montar o `SignatureRateLimitError`, e o construtor estoura antes:

```
TypeError: Cannot read properties of undefined (reading 'retry-after')
```

Toda vez que esse texto aparecer no log, leia como **limite de assinatura
estourado**. O `assinatura.js` já reconhece esse disfarce (`ehLimiteMascarado`),
então o diagnóstico do painel diz o que é de verdade.

### Só o `connect()` custa cota

Essa é a regra que governa o gasto: **cada `connect()` queima uma requisição do
plano, o streamer estando ao vivo ou não.** Em 28/09 o painel do EulerStream
mostrou 5.356 requisições em 6h, todas na mesma rota
(`GET /webcast/rooms/{room_id}/connect`), com 0,2% de sucesso — a cota diária
inteira (2.500 no plano Community) indo embora pra tentar abrir live que não
existia.

Por isso o motor **pergunta antes de gastar**. O `fetchIsLive()` do conector
responde "ele está ao vivo?" em cascata, e as duas primeiras fontes não custam
nada:

1. HTML do TikTok (`SIGI_STATE`) — grátis
2. API Live do TikTok (`liveRoom.status`) — grátis
3. EulerStream (`is_live`) — **custa, e fica desligada** via
   `IsLiveRouteConfig.skipFetchRoomIdFromEulerRoute = true`

Resultado: live parada custa **zero** de cota, e a checagem pode rodar a cada
~30s (`INTERVALO_CHECAGEM_MS`) sem culpa. O Euler só é tocado quando existe
live de verdade pra assinar.

Se as duas fontes grátis falharem 3 vezes seguidas (captcha do TikTok, mudança
no HTML), o motor tenta conectar às cegas uma vez — gastando cota — e volta a
perguntar. Ficar sem conectar nunca seria pior do que gastar.

### Backoff

Quando o `connect()` falha de verdade, a espera cresce, em três faixas:

| Situação | Primeira espera | Teto |
|---|---|---|
| Limite estourado | 60s | 15 min |
| Streamer ainda não subiu | 10s | 60s |
| Resto (rede, `@` errado, erro do TikTok) | 10s | 2 min |

A espera dobra a cada falha seguida e leva um sorteio de 50% a 100%, pra várias
lives que caíram juntas não voltarem todas no mesmo instante. Existe **uma**
cadeia de reconexão por live: quem remarca cancela o que estava marcado, e o
`parar()` limpa o timer.

---

## Variáveis de ambiente

| Variável | Pra que serve |
|---|---|
| `PORT` | Porta do servidor. Padrão: `3000`. |
| `TIKTOK_USERNAME` | `@` da live da casa, quando não há `config.json`. |
| `SESSION_SECRET` | Segredo do cookie de sessão. **Obrigatória**: sem ela o servidor não sobe (só sobe com `DEV_LOCAL=1`, e aí com um segredo público). |
| `EULERSTREAM_API_KEY` / `SIGN_API_KEY` | Chave do assinador. Necessária na prática pra mais de uma live. |
| `SIGN_API_URL` | Aponta o assinador pra outro servidor. Serve pra investigação. |
| `INTERVALO_CHECAGEM_MS` | De quanto em quanto tempo perguntar se o streamer subiu. Padrão: `30000`. Essa pergunta não custa cota do assinador. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Cria o primeiro administrador na subida, se ele ainda não existir. |
| `DEV_LOCAL=1` | **Só na sua máquina.** Aceita rodar sem `SESSION_SECRET` e manda o cookie de sessão por HTTP. Em qualquer deploy, não defina: o padrão já é `trust proxy` ligado e cookie `secure`. |
| `RAILWAY_ENVIRONMENT` | Quando existe, todos os arquivos de dados passam a morar em `/data`. |
| `MIRA_INICIO` / `MIRA_FIM` | Período da campanha, em ISO com fuso (`2026-11-01T00:00:00-03:00`). Sem elas, vale o que está no `campanha.config.js`. |
| `MIRA_SNIPERS` | `@` dos snipers da campanha, separados por vírgula. Cada um vira uma live monitorada na subida. |
| `MIRA_CACHE_MS` | De quanto em quanto tempo o ranking da campanha é recalculado. Padrão: `60000`. |

---

## API

Tudo abaixo de `/api/` exige login, menos `/api/login`, `/api/ativar` e
`/api/ativar/info`. As rotas de dados são escopadas pelo `clientes.doPedido` —
cada um enxerga a própria live e nada mais.

### Entrada

| Rota | O que faz |
|---|---|
| `POST /api/login` | Entra. Regenera a sessão. |
| `POST /api/logout` | Sai. |
| `GET /api/ativar/info?chave=` | Diz de qual live a chave é, **sem gastar ela**. |
| `POST /api/ativar` | Troca a chave por uma conta nova e já entra logado. |

### Os dados da live (cliente)

| Rota | O que devolve |
|---|---|
| `GET /api/ranking` | O ranking. |
| `GET /api/dashboard` | Tudo que o streamer quer ver, num pedido só. |
| `GET /api/serie` | A curva minuto a minuto. `agrupar` junta N minutos num ponto — quem desenha sabe quantos pixels tem, o servidor não. |
| `GET /api/registros` | O olhar longo: melhores dias, dia da semana, horário, recordes. |
| `GET /api/batalhas` | Histórico de PK, rivais, aproveitamento. |
| `GET /api/sessions` | Lives já encerradas. |
| `GET /api/user/:uniqueId` | A ficha de uma pessoa. |
| `POST /api/reset` | **Apaga tudo** daquela live. Se a live estiver no ar, a sessão recomeça na hora (a duração volta a contar do reset). |
| `POST /api/tropa/limpar` | Limpa só o mural. Ranking, likes, presentes e níveis ficam de pé. |
| `POST /api/tropa/remover` | Tira uma pessoa do mural. |
| `POST /api/powerup/itens` | Informa quais cartas uma premiação deu. |
| `POST /api/powerup/itens-pendentes` | O mesmo, para as premiações que ficaram em aberto. |

### Só administrador

| Rota | O que faz |
|---|---|
| `GET /api/clientes` | Todos os clientes, com os números de cada live e a lista de administradores. |
| `POST /api/clientes` | Cria um cliente (e sobe a live dele na hora) ou um administrador. |
| `POST /api/clientes/admin` | Promove ou rebaixa. |
| `POST /api/clientes/remover-acesso` | Tira o acesso de alguém. Não apaga os dados da live. |
| `GET` / `POST /api/chaves` | Lista e gera chaves de ativação. |
| `POST /api/chaves/revogar` · `/apagar` | Mata uma chave. |
| `GET /api/espiar?dono=` · `/api/espiar/sair` | Entra e sai da live de um cliente. |

### Aparência — dos dois, com escopo

`GET` e `POST /api/config` **não são exclusivas do administrador**: o cliente
mexe na cara da live dele. Quem decide o escopo é o `escopoDoPedido()`:

- **administrador** escolhe — `?dono=@fulano` mira um cliente, vazio mira a
  instalação;
- **cliente** só mexe na dele, e pedir outra dá **403** em vez de ser
  redirecionado calado. Redirecionar fazia o cliente sobrescrever a própria cara
  com um texto destinado a outro lugar.

`dono` vazio quer dizer "a minha", não "a da casa" — por isso não é recusa.

`GET` / `POST` / `DELETE /api/fundo` seguem o mesmo escopo, com uma diferença: a
**instalação não tem fundo** (400 com o motivo). `GET /api/fundo` devolve a
imagem da live da sessão, ou **404** quando ela não escolheu nenhuma — 404 aqui
não é erro, é o estado que liga o degradê da marca na tela. Imagem acima do teto
responde **413** com o tamanho dito, não um 500 mudo.

---

## Tirar uma pessoa do ranking

Cada linha do ranking tem um **×**. Ele não remove: abre uma confirmação que diz
o nome de quem vai sair e o que exatamente acontece. A linha inteira já é
clicável (abre o perfil), então um × que apagasse direto ficaria a um toque
errado de distância de uma ação sem volta.

Até existir, a única limpeza era o `/api/reset` — apaga tudo de todo mundo. Esta
é a tesoura fina, e serve pras duas coisas que pediram a mesma porta: tirar um
bot ou um perfil indesejado da lista, e **apagar os dados de quem pede pra
sair**, que era o buraco apontado na auditoria.

O que sai: a ficha, as ações no feed e o estoque de power-ups. O que **fica**,
de propósito:

| | |
|---|---|
| likes, comentários, diamantes totais | **não mudam** — o que a pessoa já deu, deu, e um streamer que remove um perfil não espera ver o faturamento do dia encolher junto |
| visitantes únicos, seguiram, compartilharam | **caem um** — esses contam pessoas, e agora tem uma pessoa a menos |

É a mesma régua que a limpeza das fichas-fantasma do `db.js` já usava.

**Não é bloqueio.** Se a pessoa interagir de novo na live, ela volta — e a
confirmação diz isso na cara. Bloquear é outra decisão e outra tela; tomá-la aqui
calado seria pior.

O escopo sai da **sessão**, nunca do corpo do pedido: `teste/ranking-remover.js`
prova que o `uniqueId` de uma live não alcança a outra (as duas lives do teste
usam ids diferentes de propósito — com ids iguais, "não alcançou" seria
indistinguível de "removeu o próprio").

---

## Eventos de socket

O socket usa a mesma sessão do Express, e conexão sem login é recusada no
handshake. Cada navegador entra **na sala do dono dele**.

Ao conectar, o servidor manda o estado atual: `ranking`, `global_stats`,
`live_status`, `live_feed_init`, `tropa_init`, `battle_stats`,
`powerup_estoque`, `diagnostico_init`.

Depois disso o motor empurra as mudanças: `ranking`, `global_stats`,
`viewer_count`, `live_status`, `live_feed_event`, `tropa_add`,
`battle_live`, `battle_stats`, `powerup_estoque`, `powerup_efeito`,
`diagnostico` — e o servidor manda `tropa_removida` e `tropa_limpa` quando
alguém mexe no mural pela API.

---

## Deploy (Railway)

Com `RAILWAY_ENVIRONMENT` presente, todos os arquivos de dados passam a morar em
**`/data`** — o disco persistente. Sem isso, cada deploy levaria junto o
`users.json`, o banco e as sessões.

O que configurar lá:

- um **volume montado em `/data`**; (é onde ficam também as fotos de fundo
  do mural, em `/data/fundos`);
- `SESSION_SECRET` (sem ela o servidor não sobe);
- `ADMIN_USER` / `ADMIN_PASSWORD` (pro primeiro acesso);
- `EULERSTREAM_API_KEY`;
- `NODE_ENV=production` (recomendado; a segurança da sessão e o vazamento de
  stack trace não dependem mais dela);
- Node 24+ (o `.node-version` já pede).

Não precisa compilar nada: o SQLite vem dentro do Node, então não há dependência
nativa pra buildar no deploy.

---

## Campanha "TEM LEÃO NA MIRA! 🎯"

Ranking público dos snipers, em `/mira.html`. Não pede login nem cadastro, e
só lê dados.

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

**Acesso**: `GET /api/mira/ranking` é público. `GET/POST /api/mira/indicacoes`,
`PUT` e `DELETE /api/mira/indicacoes/:id` passam pelo login **e** pelo
`requireAdmin`, igual à página `mira-admin.html`.

```bash
node --test teste/pontuacao.js   # a conta, nas bordas (499/500, 59/60 min)
```

---

## Mapa dos arquivos

```
server.js          rotas, sessão, socket, e a entrega das páginas com a marca
clientes.js        o registro: usuário -> dono -> { db, live, sala }
live.js            o motor de uma live: conexão, eventos, feed, diagnóstico
db.js              os dados de um dono, em memória, com o banco como espelho
banco.js           o SQLite (node:sqlite). Toda linha carrega o `dono`
auth.js            contas, hash de senha, admin/dono
chaves.js          chaves de ativação
config.js          aparência: instalação e cliente, com saneamento
assinatura.js      o estado do assinador da conexão
session-store.js   sessões em arquivo
fundos.js          a foto de fundo do mural, uma por live (não se herda)
protocru.js        lê o protobuf cru pra achar campo que a lib não conhece
create-user.js     cadastro pela linha de comando
campanha.config.js a campanha MIRA: valores da pontuação, período, snipers
pontuacao.js       a conta da campanha (pura, testada)
campanha.js        o ranking da campanha, com cache e último dado bom
indicacoes.js      quem indicou quem (tabela `indicacoes` no dados.db)

public/
  index.html       o ranking (a tela principal)
  mural.html       o mural da tropa e a geração da imagem
  painel.html      os números da live
  diagnostico.html o log cru do que chega do TikTok
  admin.html       o painel do administrador
  config.html      a aparência
  login.html       entrada
  ativar.html      troca de chave por conta
  mira.html        ranking público da campanha (sem login)
  mira-admin.html  indicações da campanha (só administrador)
  assets/theme.css os tokens de tema e as primitivas `app-`
  assets/fundo.js  reduzir/enviar a foto de fundo (mural e aparência usam o mesmo)

teste/
  fundos.js        o módulo da foto: assinatura dos bytes, chave virando arquivo
  fundo-http.js    as rotas: quem pode mexer na foto de quem (sobe o servidor)
  fundo-cores.js   a cor que a base do poster puxa da foto (conta pura)
  navegar.js       abre a página num Chrome de verdade, mexe nela e fotografa
  pontuacao.js     a conta da campanha MIRA (node --test)
```

---

## Armadilhas conhecidas

- **Node 24.** Tentar rodar em 18 ou 20 falha na subida, com recado. É o
  `node:sqlite`.
- **Rode de dentro da pasta do projeto.** `express.static('public')` e os
  arquivos de dados são relativos ao diretório de onde o processo subiu — a
  linha logo acima dele, que serve as páginas com marcador, usa `__dirname`.
  Subir o servidor de outra pasta entrega as páginas sem CSS nenhum, calado.
- **Trocar o `@` da live pede restart.** É lido uma vez, na subida.
- **Uma chave de assinatura por instalação** antes de colocar a segunda live no
  ar. Sem ela o limite é por IP, e cada reconexão consome.
- **Promover um cliente a administrador tira ele da live dele**, porque
  administrador não pertence a live nenhuma. A tela avisa antes.
- **O `live.json` é só da casa.** Não procure lá os dados de um cliente: eles
  nasceram no banco e só existem lá.
