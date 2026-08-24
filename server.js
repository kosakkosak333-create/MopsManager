const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Server } = require("socket.io");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CHANNELS = [
  { id: "general", name: "📢 general" },
  { id: "mopsi", name: "🐶 мопсы" },
  { id: "zvonki", name: "📞 звонки" },
];

const sessions = {}; // token -> username
const online = new Map(); // username -> Set(socketId)

function dmId(a, b) { return "dm:" + [a, b].sort().join("__"); }

function emitToUser(name, event, data) {
  const ids = online.get(name);
  if (!ids) return;
  ids.forEach(id => io.to(id).emit(event, data));
}

app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Нужны юзернейм и пароль" });
  if (db.getUser(username)) return res.status(409).json({ error: "Такой юзернейм уже занят" });
  db.createUser(username, password);
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!db.getUser(username) || !db.authUser(username, password))
    return res.status(401).json({ error: "Неверный юзернейм или пароль" });
  const token = crypto.randomBytes(24).toString("hex");
  sessions[token] = username;
  res.json({ token, username });
});

app.post("/api/friends/add", (req, res) => {
  const { token, target } = req.body || {};
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  if (!target || !db.getUser(target)) return res.status(404).json({ error: "Пользователь не найден" });
  if (target === me) return res.status(400).json({ error: "Нельзя добавить себя" });
  const my = db.getFriends(me), tgt = db.getFriends(target);
  if (my.friends.includes(target)) return res.status(400).json({ error: "Уже в друзьях" });
  if (my.outgoing.includes(target)) return res.status(400).json({ error: "Заявка уже отправлена" });
  my.outgoing.push(target);
  if (!tgt.incoming.includes(me)) tgt.incoming.push(me);
  db.setFriends(me, my); db.setFriends(target, tgt);
  emitToUser(target, "friends-updated", db.getFriends(target));
  res.json({ ok: true });
});

app.post("/api/friends/accept", (req, res) => {
  const { token, target } = req.body || {};
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  const my = db.getFriends(me), tgt = db.getFriends(target);
  if (!my.incoming.includes(target)) return res.status(400).json({ error: "Нет входящей заявки" });
  my.incoming = my.incoming.filter(x => x !== target);
  tgt.outgoing = tgt.outgoing.filter(x => x !== me);
  if (!my.friends.includes(target)) my.friends.push(target);
  if (!tgt.friends.includes(me)) tgt.friends.push(me);
  db.setFriends(me, my); db.setFriends(target, tgt);
  emitToUser(target, "friends-updated", db.getFriends(target));
  res.json({ ok: true });
});

app.post("/api/friends/remove", (req, res) => {
  const { token, target } = req.body || {};
  const me = sessions[token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  const my = db.getFriends(me);
  const tgt = db.getUser(target) ? db.getFriends(target) : null;
  my.friends = my.friends.filter(x => x !== target);
  my.incoming = my.incoming.filter(x => x !== target);
  my.outgoing = my.outgoing.filter(x => x !== target);
  if (tgt) {
    tgt.friends = tgt.friends.filter(x => x !== me);
    tgt.incoming = tgt.incoming.filter(x => x !== me);
    tgt.outgoing = tgt.outgoing.filter(x => x !== me);
    db.setFriends(target, tgt);
  }
  db.setFriends(me, my);
  emitToUser(target, "friends-updated", tgt ? db.getFriends(target) : null);
  res.json({ ok: true });
});

app.get("/api/friends", (req, res) => {
  const me = sessions[req.query.token];
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  res.json(db.getFriends(me));
});

io.on("connection", socket => {
  const token = socket.handshake.auth.token;
  const username = sessions[token];
  if (!username) { socket.disconnect(true); return; }
  socket.username = username;
  socket.join("lobby");

  if (!online.has(username)) online.set(username, new Set());
  online.get(username).add(socket.id);

  socket.emit("init", { channels: CHANNELS, username, friends: db.getFriends(username) });

  socket.on("data", () => {});
  socket.emit("friends-updated", db.getFriends(username));

  socket.on("join-channel", channelId => {
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(channelId);
    socket.emit("channel-history", { channelId, messages: db.getMessages(channelId) });
  });

  socket.on("chat-message", ({ channelId, text }) => {
    if (!channelId || !text) return;
    const msg = { user: username, text, time: Date.now(), channelId };
    db.addMessage(channelId, msg);
    io.to(channelId).emit("chat-message", msg);
  });

  const callRooms = {};
  socket.on("call-join", ({ channelId }) => {
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
    const set = online.get(username);
    if (set) { set.delete(socket.id); if (set.size === 0) online.delete(username); }
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
server.listen(PORT, "0.0.0.0", () => console.log(`MopsManager запущен на http://localhost:${PORT}`));
