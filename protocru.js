// LER O PROTOBUF CRU, SEM SCHEMA.
//
// O problema: o `tiktok-live-proto` corre atrás do TikTok. Quando o TikTok
// acrescenta um campo numa mensagem, o protobufjs decodifica o que conhece e
// **pula o resto em silêncio** (`reader.skipType`). O campo novo existe nos
// bytes e some antes de chegar em qualquer lugar que eu consiga olhar.
//
// Por isso ler o `.d.ts` não prova nada: ele só descreve o que a biblioteca
// sabe, não o que o TikTok manda. Para o prêmio do power-up isso importa
// muito — o `AwardCardNotice` do schema só tem `displayContent` e
// `awardedUsers`, e é exatamente aí que um campo com o item caberia.
//
// O truque aqui: decodifica com o proto, RE-CODIFICA, e compara os números de
// campo dos bytes originais com os da volta. O que estava no original e não
// voltou é campo que a biblioteca não conhece.

// --------------------------------------------------------------- varint
function lerVarint(buf, i) {
  let valor = 0n, desloc = 0n, lidos = 0;
  while (i + lidos < buf.length) {
    const b = buf[i + lidos];
    valor |= BigInt(b & 0x7f) << desloc;
    lidos++;
    if (!(b & 0x80)) return { valor, lidos };
    desloc += 7n;
    if (desloc > 70n) break;            // varint maior que 10 bytes: lixo
  }
  return null;
}

// Os campos de um protobuf, na ordem, sem saber o que eles significam.
// Devolve null se os bytes não forem um protobuf válido — o que é comum,
// porque string e bytes também são campos de tamanho declarado e podem
// "quase" parecer mensagem.
function lerCampos(buf) {
  if (!buf || !buf.length) return [];
  const campos = [];
  let i = 0;
  while (i < buf.length) {
    const cab = lerVarint(buf, i);
    if (!cab) return null;
    i += cab.lidos;
    const numero = Number(cab.valor >> 3n);
    const fio = Number(cab.valor & 7n);
    if (numero === 0) return null;
    if (fio === 0) {                                   // varint
      const v = lerVarint(buf, i);
      if (!v) return null;
      i += v.lidos;
      campos.push({ numero, fio, valor: v.valor });
    } else if (fio === 1) {                            // fixed64
      if (i + 8 > buf.length) return null;
      campos.push({ numero, fio, bytes: buf.slice(i, i + 8) });
      i += 8;
    } else if (fio === 2) {                            // tamanho declarado
      const t = lerVarint(buf, i);
      if (!t) return null;
      i += t.lidos;
      const tam = Number(t.valor);
      if (tam < 0 || i + tam > buf.length) return null;
      campos.push({ numero, fio, bytes: buf.slice(i, i + tam) });
      i += tam;
    } else if (fio === 5) {                            // fixed32
      if (i + 4 > buf.length) return null;
      campos.push({ numero, fio, bytes: buf.slice(i, i + 4) });
      i += 4;
    } else {
      return null;                                     // grupos: não uso
    }
  }
  return campos;
}

const ehMensagem = b => b && b.length > 0 && lerCampos(b) !== null;

// Um resumo curto do valor, pro log. Texto quando for texto.
function resumir(campo) {
  if (campo.fio === 0) return String(campo.valor);
  const b = campo.bytes;
  const txt = Buffer.from(b).toString('utf8');
  // texto de verdade: sem bytes de controle e sem o caractere de substituição
  if (/^[^\u0000-\u0008\u000e-\u001f�]*$/.test(txt) && txt.length) {
    return JSON.stringify(txt.length > 120 ? txt.slice(0, 120) + '…' : txt);
  }
  return `<${b.length} bytes>`;
}

// Um esboco do que tem DENTRO de uma mensagem, sem saber o que ela e.
// "<2306 bytes>" nao serve de nada: e justamente ali dentro que o item estaria.
function esbocar(bytes, fundo = 0, orcamento = { resta: 600 }) {
  const campos = lerCampos(bytes);
  if (campos === null || fundo > 4) return null;
  const partes = [];
  for (const c of campos) {
    if (orcamento.resta <= 0) { partes.push('…'); break; }
    let valor;
    if (c.fio === 2 && ehMensagem(c.bytes) && fundo < 4) {
      valor = esbocar(c.bytes, fundo + 1, orcamento);
    }
    if (valor == null) valor = resumir(c);
    const pedaco = `${c.numero}: ${valor}`;
    orcamento.resta -= pedaco.length;
    partes.push(pedaco);
  }
  return '{' + partes.join(', ') + '}';
}

// ------------------------------------------------------- o que se perdeu
// Compara os bytes que chegaram com os bytes que a biblioteca devolve depois
// de decodificar e re-codificar. Campo que existe num e não no outro é campo
// que ela não conhece.
//
// Só desce num campo quando os bytes dos dois lados DIFEREM: se são iguais,
// nada se perdeu ali dentro e não há o que procurar.
function camposPerdidos(cru, volta, caminho = '$', fundo = 0, achados = []) {
  if (fundo > 8 || achados.length >= 40) return achados;
  const a = lerCampos(cru);
  const b = lerCampos(volta);
  if (a === null || b === null) return achados;

  const porNumero = lista => {
    const m = new Map();
    lista.forEach(c => {
      if (!m.has(c.numero)) m.set(c.numero, []);
      m.get(c.numero).push(c);
    });
    return m;
  };
  const ma = porNumero(a);
  const mb = porNumero(b);

  for (const [numero, docru] of ma) {
    const davolta = mb.get(numero);
    if (!davolta) {
      docru.slice(0, 3).forEach(c => {
        const achado = { caminho: `${caminho}.${numero}`, fio: c.fio, valor: resumir(c) };
        // se o campo perdido for uma mensagem, abre: e la dentro que mora o
        // que interessa, e "<N bytes>" nao me diz nada
        if (c.fio === 2 && ehMensagem(c.bytes)) {
          const dentro = esbocar(c.bytes);
          if (dentro) achado.dentro = dentro;
        }
        achados.push(achado);
      });
      continue;
    }
    // mesmo campo dos dois lados: só vale descer se o conteúdo mudou
    for (let k = 0; k < docru.length && k < davolta.length; k++) {
      const x = docru[k], y = davolta[k];
      if (x.fio !== 2 || y.fio !== 2) continue;
      if (Buffer.compare(Buffer.from(x.bytes), Buffer.from(y.bytes)) === 0) continue;
      if (!ehMensagem(x.bytes) || !ehMensagem(y.bytes)) continue;
      camposPerdidos(x.bytes, y.bytes, `${caminho}.${numero}[${k}]`, fundo + 1, achados);
    }
  }
  return achados;
}

// O uso de verdade: dá o tipo e os bytes que chegaram, recebe a lista de
// campos que o proto instalado não sabe ler.
function camposQueOProtoNaoConhece(tipo, bytes) {
  if (!tipo || typeof tipo.decode !== 'function' || typeof tipo.encode !== 'function') {
    return { erro: 'tipo sem decode/encode' };
  }
  const cru = Buffer.from(bytes);
  let volta;
  try {
    volta = Buffer.from(tipo.encode(tipo.decode(cru)).finish());
  } catch (e) {
    return { erro: 'nao deu pra recodificar: ' + (e && e.message) };
  }
  return { perdidos: camposPerdidos(cru, volta) };
}

module.exports = { lerCampos, camposPerdidos, camposQueOProtoNaoConhece, resumir, esbocar };
