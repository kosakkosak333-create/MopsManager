const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATABASE_URL = process.env.DATABASE_URL;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "mops.db.json");

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt] = stored.split(":");
  const check = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(check));
}

/* ===================== PostgreSQL (Neon) ===================== */
if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const schemaReady = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, friends JSONB)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, channel TEXT, "user" TEXT, text TEXT, time BIGINT)`);
  })();

  module.exports = {
    async getUser(name) {
      await schemaReady;
      const r = await pool.query("SELECT * FROM users WHERE username=$1", [name]);
      return r.rows[0];
    },
    async createUser(name, password) {
      await schemaReady;
      const fr = { friends: [], incoming: [], outgoing: [] };
      await pool.query(
        "INSERT INTO users(username,password,friends) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [name, hashPassword(password), JSON.stringify(fr)]
      );
    },
    async authUser(name, password) {
      await schemaReady;
      const r = await pool.query("SELECT password FROM users WHERE username=$1", [name]);
      if (!r.rows[0]) return false;
      return verifyPassword(password, r.rows[0].password);
    },
    async getFriends(name) {
      await schemaReady;
      const r = await pool.query("SELECT friends FROM users WHERE username=$1", [name]);
      if (!r.rows[0] || !r.rows[0].friends) return { friends: [], incoming: [], outgoing: [] };
      return r.rows[0].friends;
    },
    async setFriends(name, friends) {
      await schemaReady;
      await pool.query("UPDATE users SET friends=$1 WHERE username=$2", [JSON.stringify(friends), name]);
    },
    async getMessages(channelId) {
      await schemaReady;
      const r = await pool.query(
        `SELECT "user", text, time, channel FROM messages WHERE channel=$1 ORDER BY id ASC LIMIT 200`,
        [channelId]
      );
      return r.rows.map(x => ({ user: x.user, text: x.text, time: x.time, channelId: x.channel }));
    },
    async addMessage(channelId, msg) {
      await schemaReady;
      await pool.query(
        `INSERT INTO messages(channel,"user",text,time) VALUES($1,$2,$3,$4)`,
        [channelId, msg.user, msg.text, msg.time]
      );
    },
  };
}

/* ===================== File backend (локально) ===================== */
else {
  function load() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
    catch { return { users: {}, messages: {} }; }
  }
  function save(d) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2));
  }
  let db = load();

  module.exports = {
    async getUser(name) { return db.users[name]; },
    async createUser(name, password) {
      db.users[name] = { password: hashPassword(password), friends: { friends: [], incoming: [], outgoing: [] } };
      save(db);
    },
    async authUser(name, password) {
      const u = db.users[name];
      if (!u) return false;
      return verifyPassword(password, u.password);
    },
    async getFriends(name) {
      if (!db.users[name]) return { friends: [], incoming: [], outgoing: [] };
      if (!db.users[name].friends) db.users[name].friends = { friends: [], incoming: [], outgoing: [] };
      return db.users[name].friends;
    },
    async setFriends(name, friends) {
      if (!db.users[name]) return;
      db.users[name].friends = friends;
      save(db);
    },
    async getMessages(channelId) { return db.messages[channelId] || []; },
    async addMessage(channelId, msg) {
      if (!db.messages[channelId]) db.messages[channelId] = [];
      db.messages[channelId].push(msg);
      if (db.messages[channelId].length > 200) db.messages[channelId].shift();
      save(db);
    },
  };
}
