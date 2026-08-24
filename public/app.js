const authEl = document.getElementById("auth");
const appEl = document.getElementById("app");
const authUser = document.getElementById("authUser");
const authPass = document.getElementById("authPass");
const authBtn = document.getElementById("authBtn");
const authError = document.getElementById("authError");
const tabLogin = document.getElementById("tabLogin");
const tabReg = document.getElementById("tabReg");
const statusDot = document.getElementById("statusDot");

const CHANNELS = [
  { id: "general", name: "📢 general" },
  { id: "mopsi", name: "🐶 мопсы" },
  { id: "zvonki", name: "📞 звонки" },
];

let mode = "login";
let token = localStorage.getItem("mops_token");
let username = localStorage.getItem("mops_user");
let socket = null;
let currentChannel = null;
let currentTitle = null;
let allMessages = {};

let localStream = null;
let peerConnections = new Map();
let inCall = false;

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

tabLogin.onclick = () => { mode = "login"; tabLogin.classList.add("active"); tabReg.classList.remove("active"); authBtn.textContent = "Войти"; };
tabReg.onclick = () => { mode = "register"; tabReg.classList.add("active"); tabLogin.classList.remove("active"); authBtn.textContent = "Зарегистрироваться"; };

authBtn.onclick = async () => {
  authError.textContent = "";
  const u = authUser.value.trim();
  const p = authPass.value;
  if (!u || !p) { authError.textContent = "Заполните все поля"; return; }
  const endpoint = mode === "login" ? "/api/login" : "/api/register";
  const res = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  const data = await res.json();
  if (!res.ok) { authError.textContent = data.error || "Ошибка"; return; }
  if (data.token) {
    token = data.token; username = data.username;
    localStorage.setItem("mops_token", token);
    localStorage.setItem("mops_user", username);
  }
  enterApp();
};

function enterApp() {
  authEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  document.getElementById("meName").textContent = username;
  renderChannels();
  connect();
}

function connect() {
  socket = io({ auth: { token }, transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    statusDot.className = "status-dot online";
    if (currentChannel) {
      socket.emit("join-channel", currentChannel);
      refreshFriends();
    }
  });
  socket.on("disconnect", () => { statusDot.className = "status-dot offline"; });

  socket.on("init", data => {
    username = data.username;
    renderChannels();
    renderFriends(data.friends || { friends: [], incoming: [], outgoing: [] });
    if (!currentChannel) selectChannel("general", "# general");
  });

  socket.on("channel-history", ({ channelId, messages }) => {
    allMessages[channelId] = messages;
    if (channelId === currentChannel) {
      const box = document.getElementById("messages");
      box.innerHTML = "";
      messages.forEach(m => appendMessage({ ...m, channelId }));
    }
  });

  socket.on("chat-message", m => {
    if (!allMessages[m.channelId]) allMessages[m.channelId] = [];
    allMessages[m.channelId].push(m);
    appendMessage(m);
  });

  socket.on("friends-updated", fr => { if (fr) renderFriends(fr); });

  socket.on("call-peers", ({ channelId, peers }) => peers.forEach(peer => createOffer(peer, channelId)));
  socket.on("call-incoming", () => {});
  socket.on("call-offer", async ({ from, to, offer, channelId }) => {
    if (to !== username) return;
    const pc = createPeer(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("call-answer", { channelId, to: from, answer });
  });
  socket.on("call-answer", async ({ from, to, answer }) => {
    if (to !== username) return;
    const pc = peerConnections.get(from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });
  socket.on("ice-candidate", async ({ from, to, candidate }) => {
    if (to !== username) return;
    const pc = peerConnections.get(from);
    if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  });
  socket.on("call-peer-left", ({ from }) => {
    const pc = peerConnections.get(from);
    if (pc) { pc.close(); peerConnections.delete(from); }
    removeVideo(from);
  });
}

function renderChannels() {
  const list = document.getElementById("channelList");
  list.innerHTML = "";
  CHANNELS.forEach(c => {
    const div = document.createElement("div");
    div.className = "channel" + (c.id === currentChannel ? " active" : "");
    div.textContent = c.name;
    div.onclick = () => selectChannel(c.id, c.name);
    list.appendChild(div);
  });
}

function dmId(a, b) { return "dm:" + [a, b].sort().join("__"); }

function renderFriends(fr) {
  const list = document.getElementById("friendList");
  list.innerHTML = "";
  (fr.friends || []).forEach(f => {
    const row = document.createElement("div");
    row.className = "friend";
    row.innerHTML = `<span class="friend-name">🐶 ${escapeHtml(f)}</span>`;
    const actions = document.createElement("span");
    actions.className = "friend-actions";
    const msg = document.createElement("button"); msg.textContent = "✉"; msg.title = "Написать"; msg.onclick = () => openDM(f);
    const call = document.createElement("button"); call.textContent = "📞"; call.title = "Позвонить"; call.onclick = () => { openDM(f); setTimeout(startCall, 300); };
    const rm = document.createElement("button"); rm.textContent = "✕"; rm.title = "Удалить"; rm.onclick = () => removeFriend(f);
    actions.append(msg, call, rm);
    row.append(actions);
    list.appendChild(row);
  });
  (fr.incoming || []).forEach(f => {
    const row = document.createElement("div");
    row.className = "friend incoming";
    row.innerHTML = `<span class="friend-name">⬇ ${escapeHtml(f)}</span>`;
    const actions = document.createElement("span");
    actions.className = "friend-actions";
    const acc = document.createElement("button"); acc.textContent = "✔"; acc.title = "Принять"; acc.onclick = () => acceptFriend(f);
    const dec = document.createElement("button"); dec.textContent = "✕"; dec.title = "Отклонить"; dec.onclick = () => removeFriend(f);
    actions.append(acc, dec);
    row.append(actions);
    list.appendChild(row);
  });
  (fr.outgoing || []).forEach(f => {
    const row = document.createElement("div");
    row.className = "friend outgoing";
    row.innerHTML = `<span class="friend-name">… ${escapeHtml(f)}</span>`;
    list.appendChild(row);
  });
}

async function refreshFriends() {
  try {
    const r = await fetch("/api/friends?token=" + encodeURIComponent(token));
    if (r.ok) renderFriends(await r.json());
  } catch {}
}

document.getElementById("addFriendBtn").onclick = async () => {
  const input = document.getElementById("friendInput");
  const target = input.value.trim();
  if (!target) return;
  const r = await fetch("/api/friends/add", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, target })
  });
  const d = await r.json();
  if (!r.ok) { alert(d.error || "Ошибка"); return; }
  input.value = "";
  refreshFriends();
};

async function acceptFriend(f) {
  await fetch("/api/friends/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, target: f }) });
  refreshFriends();
}
async function removeFriend(f) {
  await fetch("/api/friends/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, target: f }) });
  refreshFriends();
}

function openDM(friend) { selectChannel(dmId(username, friend), "💬 " + friend); }

function selectChannel(id, title) {
  currentChannel = id;
  currentTitle = title || ("# " + id);
  document.getElementById("chatTitle").textContent = currentTitle;
  document.getElementById("msgInput").placeholder = "Сообщение " + currentTitle;
  const box = document.getElementById("messages");
  box.innerHTML = "";
  (allMessages[id] || []).forEach(m => appendMessage({ ...m, channelId: id }));
  renderChannels();
  if (socket && socket.connected) socket.emit("join-channel", id);
}

document.getElementById("msgForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text || !currentChannel) return;
  socket.emit("chat-message", { channelId: currentChannel, text });
  input.value = "";
});

function appendMessage(m) {
  if (m.channelId && m.channelId !== currentChannel) return;
  const wrap = document.createElement("div");
  wrap.className = "msg";
  const isMe = m.user === username;
  const time = new Date(m.time || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  wrap.innerHTML = `<span class="author ${isMe ? "me" : ""}">${escapeHtml(m.user)}</span><span class="time">${time}</span><div class="body">${escapeHtml(m.text)}</div>`;
  document.getElementById("messages").appendChild(wrap);
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

document.getElementById("logoutBtn").onclick = () => { localStorage.clear(); location.reload(); };

/* ---------- Звонки ---------- */
const callBtn = document.getElementById("callBtn");
const callWindow = document.getElementById("callWindow");
const videoGrid = document.getElementById("videoGrid");
callBtn.onclick = () => { if (inCall) hangup(); else startCall(); };

async function startCall() {
  if (inCall) return;
  try { localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
  catch { try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { alert("Нет доступа к камере/микрофону"); return; } }
  if (!socket || !socket.connected) { alert("Нет соединения с сервером"); if (localStream) localStream.getTracks().forEach(t => t.stop()); localStream = null; return; }
  inCall = true;
  callBtn.textContent = "📴 Завершить";
  callBtn.classList.add("in-call");
  callWindow.classList.remove("hidden");
  document.getElementById("callChan").textContent = currentTitle || ("#" + currentChannel);
  addVideo("me", localStream, true);
  socket.emit("call-join", { channelId: currentChannel });
}

function createPeer(peer) {
  if (peerConnections.has(peer)) return peerConnections.get(peer);
  const pc = new RTCPeerConnection(ICE);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit("ice-candidate", { channelId: currentChannel, to: peer, candidate: e.candidate }); };
  pc.ontrack = e => addVideo(peer, e.streams[0], false);
  peerConnections.set(peer, pc);
  return pc;
}

async function createOffer(peer, channelId) {
  const pc = createPeer(peer);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("call-offer", { channelId, to: peer, offer });
}

function addVideo(id, stream, isLocal) {
  removeVideo(id);
  const v = document.createElement("video");
  v.id = "vid-" + id; v.autoplay = true; v.playsInline = true;
  if (isLocal) v.muted = true;
  v.srcObject = stream;
  videoGrid.appendChild(v);
}
function removeVideo(id) { const v = document.getElementById("vid-" + id); if (v) v.remove(); }

function hangup() {
  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  videoGrid.innerHTML = "";
  callWindow.classList.add("hidden");
  inCall = false;
  callBtn.textContent = "📞 Позвонить";
  callBtn.classList.remove("in-call");
  if (socket && socket.connected) socket.emit("call-leave", { channelId: currentChannel });
}

document.getElementById("hangupBtn").onclick = hangup;

if (token && username) enterApp();
