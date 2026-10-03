// OS TERMOS, E A PROVA DE QUE ALGUÉM ACEITOU.
//
// O que torna um aceite útil depois não é o texto: é conseguir dizer QUEM
// aceitou O QUÊ e QUANDO. Por isso o texto tem versão, e o registro do aceite
// guarda a versão junto. Mudar os termos sem trocar a versão apagaria a
// diferença entre quem aceitou o texto velho e quem aceitou o novo.
//
// ATENÇÃO: este texto é uma base honesta do que o sistema faz de verdade, pra
// o advogado revisar. Não é parecer jurídico.

// Troque a versão SEMPRE que mexer no texto. É ela que vai no registro.
const VERSAO = '2026-10-02.1';

const TITULO = 'Termos de Uso e Autorização do Streamer';

// Cada seção é { t: título, p: [parágrafos] }. Fica em dados, e não em HTML,
// porque a mesma coisa é mostrada na página e guardada no aceite.
const SECOES = [
  {
    t: 'O que este serviço faz',
    p: [
      'O serviço se conecta à sua live do TikTok e lê o que o TikTok transmite '
      + 'publicamente para qualquer pessoa que esteja assistindo: comentários, '
      + 'curtidas, presentes, entradas na sala, número de espectadores, '
      + 'batalhas de PK e os selos de nível que aparecem ao lado dos nomes.',
      'Com isso ele monta um ranking em tempo real, um mural da tropa, o '
      + 'controle de power-ups e o histórico das suas lives.',
      'Ele não publica nada na sua conta, não comenta, não envia presentes e '
      + 'não acessa mensagens privadas. A conexão é somente de leitura.'
    ]
  },
  {
    t: 'Você autoriza, e você responde pela live',
    p: [
      'Ao ativar, você declara que é a pessoa dona do @ informado, ou que está '
      + 'autorizada por ela, e que autoriza este serviço a acompanhar essa live.',
      'Essa declaração é confirmada por uma prova: você coloca um código na bio '
      + 'do perfil e o sistema lê. Quem consegue escrever na bio de um perfil é '
      + 'quem controla aquele perfil.',
      'Os dados das pessoas que aparecem na sua live são responsabilidade sua '
      + 'perante elas. Este serviço é a ferramenta que você usa para tratá-los, '
      + 'e segue as suas instruções — inclusive a de apagar.'
    ]
  },
  {
    t: 'O que é guardado, e por quanto tempo',
    p: [
      'De quem participa da sua live: o apelido, o @, a foto de perfil, o '
      + 'identificador público do TikTok, o nível do selo e o que a pessoa fez '
      + 'na live (curtiu, comentou, presenteou, entrou).',
      'Nada disso é comprado, cruzado com outra base ou vendido. Não há '
      + 'rastreamento fora da live e não há publicidade.',
      'Comentários ficam limitados aos mais recentes por pessoa, a curva '
      + 'minuto a minuto é podada por tempo, e o histórico de batalhas tem '
      + 'teto. Você pode apagar tudo de uma vez pelo botão de resetar, e pode '
      + 'pedir a remoção de uma pessoa específica a qualquer momento.'
    ]
  },
  {
    t: 'Pedido de remoção',
    p: [
      'Qualquer pessoa que apareça nos seus painéis pode pedir para sair. '
      + 'Quando isso chegar até você, use a remoção no próprio painel — ela '
      + 'apaga os dados daquela pessoa, não apenas esconde.',
      'Se o pedido chegar a nós, vamos encaminhar a você, porque a decisão '
      + 'sobre os dados da sua live é sua.'
    ]
  },
  {
    t: 'Sua conta',
    p: [
      'Você escolhe o próprio usuário e a própria senha; ninguém aqui vê a sua '
      + 'senha, nem na hora do cadastro. Guarde-a: quem tem a senha entra nos '
      + 'seus painéis.',
      'Avise se achar que alguém entrou na sua conta.'
    ]
  },
  {
    t: 'Limites honestos',
    p: [
      'Este serviço não tem vínculo, patrocínio ou aprovação do TikTok. '
      + 'TikTok é marca de quem é dono dela.',
      'O serviço depende do que o TikTok transmite. Se o TikTok mudar, '
      + 'instabilizar ou bloquear o acesso, partes do painel podem parar de '
      + 'funcionar — e isso não está sob nosso controle.',
      'Os números são uma leitura do que chegou pela live e servem para você '
      + 'acompanhar o seu trabalho. Não são relatório contábil nem substituem '
      + 'os números oficiais do TikTok.'
    ]
  },
  {
    t: 'Mudanças e encerramento',
    p: [
      'Se estes termos mudarem, a versão muda junto e você será avisado para '
      + 'aceitar de novo antes de continuar usando.',
      'Você pode encerrar quando quiser e pedir a exclusão dos dados da sua '
      + 'live. Nós podemos encerrar o acesso de quem usar o serviço para '
      + 'assediar, perseguir ou expor alguém.'
    ]
  }
];

// O texto inteiro em uma string. É isto que vai no hash do aceite: o registro
// passa a provar não só "aceitou a versão X", mas "aceitou exatamente este
// texto" — mesmo que alguém edite o arquivo depois sem trocar a versão.
function textoCompleto() {
  return [TITULO, 'Versão ' + VERSAO]
    .concat(SECOES.map(s => s.t + '\n' + s.p.join('\n')))
    .join('\n\n');
}

const crypto = require('crypto');
function impressao() {
  return crypto.createHash('sha256').update(textoCompleto(), 'utf8')
    .digest('hex').slice(0, 16);
}

// O que fica guardado no usuário. Tudo que é preciso pra responder, meses
// depois: quem, quando, qual texto, de onde, e como provou ser o dono do @.
function registroDeAceite({ dono, ip, userAgent, prova, declaracoes }) {
  return {
    versao: VERSAO,
    impressao: impressao(),
    em: new Date().toISOString(),
    dono: String(dono || '').replace(/^@/, '').toLowerCase() || null,
    // o IP é prova de origem; fica cortado no tamanho pra não virar campo livre
    ip: String(ip || '').slice(0, 60) || null,
    userAgent: String(userAgent || '').slice(0, 200) || null,
    // como a posse do @ foi provada (ou se não foi)
    prova: prova || null,
    // exatamente o que foi marcado na tela
    declaracoes: Array.isArray(declaracoes)
      ? declaracoes.map(d => String(d).slice(0, 120)).slice(0, 10)
      : []
  };
}

// O aceite guardado ainda vale? Termos novos pedem aceite novo.
function aceiteValido(aceite) {
  return !!(aceite && aceite.versao === VERSAO);
}

module.exports = {
  VERSAO, TITULO, SECOES,
  textoCompleto, impressao, registroDeAceite, aceiteValido
};
