const STORE_KEY = "mopsmanager_data";

function loadData() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { contacts: [], activeId: null };
  } catch {
    return { contacts: [], activeId: null };
  }
}

function saveData() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

const state = loadData();
let activeId = state.activeId;

const contactList = document.getElementById("contactList");
const messagesEl = document.getElementById("messages");
const chatHead = document.getElementById("chatHead");
const msgForm = document.getElementById("msgForm");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");

const modal = document.getElementById("modal");
const contactName = document.getElementById("contactName");

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getContact(id) {
  return state.contacts.find(c => c.id === id);
}

function renderContacts() {
  contactList.innerHTML = "";
  state.contacts.forEach(c => {
    const li = document.createElement("li");
    if (c.id === activeId) li.classList.add("active");
    li.innerHTML = `<span class="avatar">🐶</span><span>${escapeHtml(c.name)}</span>`;
    li.onclick = () => selectContact(c.id);
    contactList.appendChild(li);
  });
}

function renderMessages() {
  messagesEl.innerHTML = "";
  const contact = getContact(activeId);
  if (!contact) {
    chatHead.querySelector(".chat-title").textContent = "Выберите контакт";
    msgInput.disabled = true;
    sendBtn.disabled = true;
    return;
  }

  chatHead.querySelector(".chat-title").textContent = "🐶 " + contact.name;
  msgInput.disabled = false;
  sendBtn.disabled = false;

  contact.messages.forEach(m => {
    const div = document.createElement("div");
    div.className = "msg " + (m.from === "me" ? "me" : "them");
    div.innerHTML = escapeHtml(m.text) + `<span class="time">${m.time}</span>`;
    messagesEl.appendChild(div);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function selectContact(id) {
  activeId = id;
  state.activeId = id;
  saveData();
  renderContacts();
  renderMessages();
}

function addMessage(text) {
  const contact = getContact(activeId);
  if (!contact) return;
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  contact.messages.push({ from: "me", text, time });
  saveData();
  renderMessages();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

msgForm.addEventListener("submit", e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  addMessage(text);
  msgInput.value = "";
});

document.getElementById("addContactBtn").onclick = () => {
  contactName.value = "";
  modal.classList.remove("hidden");
  contactName.focus();
};

document.getElementById("modalCancel").onclick = () => modal.classList.add("hidden");

document.getElementById("modalSave").onclick = () => {
  const name = contactName.value.trim();
  if (!name) return;
  const contact = { id: uid(), name, messages: [] };
  state.contacts.push(contact);
  saveData();
  modal.classList.add("hidden");
  selectContact(contact.id);
};

renderContacts();
renderMessages();
