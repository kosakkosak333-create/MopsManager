const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const USERS_FILE = path.join(__dirname, "users.json");
const CHANNELS = [
  { id: "general", name: "📢 general" },
  { id: "mopsi", name: "🐶 мопсы" },
  { id: "zvonki", name: "📞 звонки" },
];

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();
const sessions = {}; // token -> username
const messages = {}; // channelId -> [{user, text, time}]
CHANNELS.forEach(c => (messages[c.id] = []));

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
function getFriends(u) {
  if (!users[u]) return { friends: [], incoming: [], outgoing: [] };
  if (!users[u].friends) users[u].friends = { friends: [], incoming: [], outgoing: [] };
  return users[u].friends;
}
function dmId(a, b) {
  return "dm:" + [a, b].sort().join("__");
}

app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Нужны юзернейм и пароль" });
  if (users[username]) return res.status(409).json({ error: "Такой юзернейм уже занят" });
  users[username] = {
    password: hashPassword(password),
    friends: { friends: [], incoming: [], outgoing: [] },
  };
  saveUsers(users);
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = users[username];
  if (!user || !verifyPassword(password, user.password))
    return res.status(401).json({ error: "Неверный юзернейм или пароль" });
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = username;
  res.json({ token, username });
});

// ---------- Друзья ----------
app.post("/api/friends/add", (req, res) => {
  const { token, target } = req.body || {};
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  if (!target || !users[target]) return res.status(404).json({ error: "Пользователь не найден" });
  if (target === me) return res.status(400).json({ error: "Нельзя добавить себя" });
  const my = getFriends(me), tgt = getFriends(target);
  if (my.friends.includes(target)) return res.status(400).json({ error: "Уже в друзьях" });
  if (my.outgoing.includes(target)) return res.status(400).json({ error: "Заявка уже отправлена" });
  my.outgoing.push(target);
  if (!tgt.incoming.includes(me)) tgt.incoming.push(me);
  saveUsers(users);
  res.json({ ok: true });
});

app.post("/api/friends/accept", (req, res) => {
  const { token, target } = req.body || {};
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  const my = getFriends(me), tgt = getFriends(target);
  if (!my.incoming.includes(target)) return res.status(400).json({ error: "Нет входящей заявки" });
  my.incoming = my.incoming.filter(x => x !== target);
  tgt.outgoing = tgt.outgoing.filter(x => x !== me);
  if (!my.friends.includes(target)) my.friends.push(target);
  if (!tgt.friends.includes(me)) tgt.friends.push(me);
  saveUsers(users);
  res.json({ ok: true });
});

app.post("/api/friends/remove", (req, res) => {
  const { token, target } = req.body || {};
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  const my = getFriends(me);
  const tgt = users[target] ? getFriends(target) : null;
  my.friends = my.friends.filter(x => x !== target);
  my.incoming = my.incoming.filter(x => x !== target);
  my.outgoing = my.outgoing.filter(x => x !== target);
  if (tgt) {
    tgt.friends = tgt.friends.filter(x => x !== me);
    tgt.incoming = tgt.incoming.filter(x => x !== me);
    tgt.outgoing = tgt.outgoing.filter(x => x !== me);
  }
  saveUsers(users);
  res.json({ ok: true });
});

app.get("/api/friends", (req, res) => {
  const token = req.query.token;
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  res.json(getFriends(me));
});

io.on("connection", socket => {
  const token = socket.handshake.auth.token;
  const username = sessions[token];
  if (!username) {
    socket.disconnect(true);
    return;
  }
  socket.username = username;
  socket.join("lobby");

  socket.emit("init", {
    channels: CHANNELS,
    username,
    messages,
    friends: getFriends(username),
  });

  socket.on("join-channel", channelId => {
    socket.rooms.forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });
    if (!messages[channelId]) messages[channelId] = [];
    socket.join(channelId);
  });

  socket.on("chat-message", ({ channelId, text }) => {
    if (!messages[channelId] || !text) return;
    const msg = { user: username, text, time: Date.now(), channelId };
    messages[channelId].push(msg);
    if (messages[channelId].length > 200) messages[channelId].shift();
    io.to(channelId).emit("chat-message", msg);
  });

  // ---------- WebRTC звонки (mesh) ----------
  const callRooms = {};

  socket.on("call-join", ({ channelId }) => {
    if (!messages[channelId]) return;
    callRooms[channelId] = callRooms[channelId] || new Set();
    const existing = [...callRooms[channelId]];
    callRooms[channelId].add(username);
    socket.join("call:" + channelId);
    socket.emit("call-peers", { channelId, peers: existing });
    socket.to("call:" + channelId).emit("call-incoming", { channelId, from: username });
  });

  socket.on("call-offer", ({ channelId, to, offer }) => {
    io.to("call:" + channelId).emit("call-offer", { channelId, from: username, to, offer });
  });
  socket.on("call-answer", ({ channelId, to, answer }) => {
    io.to("call:" + channelId).emit("call-answer", { channelId, from: username, to, answer });
  });
  socket.on("ice-candidate", ({ channelId, to, candidate }) => {
    io.to("call:" + channelId).emit("ice-candidate", { channelId, from: username, to, candidate });
  });

  socket.on("call-leave", ({ channelId }) => {
    if (callRooms[channelId]) {
      callRooms[channelId].delete(username);
      if (callRooms[channelId].size === 0) delete callRooms[channelId];
    }
    socket.leave("call:" + channelId);
    socket.to("call:" + channelId).emit("call-peer-left", { channelId, from: username });
  });

  socket.on("disconnect", () => {
    Object.keys(callRooms).forEach(channelId => {
      if (callRooms[channelId].delete(username)) {
        if (callRooms[channelId].size === 0) delete callRooms[channelId];
        socket.to("call:" + channelId).emit("call-peer-left", { channelId, from: username });
      }
    });
    io.to("lobby").emit("user-left", username);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MopsManager запущен на http://localhost:${PORT}`));
