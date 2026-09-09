// Guarda as sessões em arquivo em vez de só na memória.
// Sem isso, todo restart do servidor (deploy no Railway) desloga todo mundo.
const fs = require('fs');
const session = require('express-session');

// Mesmo esquema do live.json/users.json: disco persistente em produção.
const SESSIONS_FILE = process.env.RAILWAY_ENVIRONMENT ? '/data/sessions.json' : 'sessions.json';

class FileSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = this.load();
    this.saveTimer = null;
  }

  load() {
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    try {
      const dados = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      const agora = Date.now();
      // descarta o que já expirou em vez de carregar lixo
      for (const sid of Object.keys(dados)) {
        if (!dados[sid] || dados[sid].expiraEm <= agora) delete dados[sid];
      }
      return dados;
    } catch (e) {
      console.error('Erro ao ler sessions.json:', e.message);
      return {};
    }
  }

  // agrupa as gravações: cada request com rolling:true mexe na sessão
  agendarSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(this.sessions), { mode: 0o600 });
      } catch (e) {
        console.error('Erro ao salvar sessions.json:', e.message);
      }
    }, 1000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  expiraEmDe(sess) {
    const cookie = sess && sess.cookie;
    if (cookie && cookie.expires) return new Date(cookie.expires).getTime();
    if (cookie && cookie.originalMaxAge) return Date.now() + cookie.originalMaxAge;
    return Date.now() + 1000 * 60 * 60 * 24;
  }

  get(sid, cb) {
    const item = this.sessions[sid];
    if (!item) return cb(null, null);
    if (item.expiraEm <= Date.now()) {
      delete this.sessions[sid];
      this.agendarSave();
      return cb(null, null);
    }
    try {
      cb(null, JSON.parse(item.dados));
    } catch (e) {
      cb(null, null);
    }
  }

  set(sid, sess, cb) {
    this.sessions[sid] = { dados: JSON.stringify(sess), expiraEm: this.expiraEmDe(sess) };
    this.agendarSave();
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    const item = this.sessions[sid];
    if (item) {
      item.expiraEm = this.expiraEmDe(sess);
      this.agendarSave();
    }
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    delete this.sessions[sid];
    this.agendarSave();
    if (cb) cb(null);
  }
}

module.exports = { FileSessionStore, SESSIONS_FILE };
