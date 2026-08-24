const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "mops.db.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { users: {}, messages: {} };
  }
}
function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = load();

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

function getUser(name) { return db.users[name]; }
function createUser(name, password) {
  db.users[name] = {
    password: hashPassword(password),
    friends: { friends: [], incoming: [], outgoing: [] },
  };
  save(db);
}
function authUser(name, password) {
  const u = db.users[name];
  if (!u) return false;
  return verifyPassword(password, u.password);
}
function getFriends(name) {
  if (!db.users[name]) return { friends: [], incoming: [], outgoing: [] };
  if (!db.users[name].friends) db.users[name].friends = { friends: [], incoming: [], outgoing: [] };
  return db.users[name].friends;
}
function setFriends(name, friends) {
  if (!db.users[name]) return;
  db.users[name].friends = friends;
  save(db);
}
function getMessages(channelId) { return db.messages[channelId] || []; }
function addMessage(channelId, msg) {
  if (!db.messages[channelId]) db.messages[channelId] = [];
  db.messages[channelId].push(msg);
  if (db.messages[channelId].length > 200) db.messages[channelId].shift();
  save(db);
}

module.exports = {
  getUser, createUser, authUser, getFriends, setFriends,
  getMessages, addMessage,
};
