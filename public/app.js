const DB_NAME = "oficios-pwa";
const DB_VERSION = 1;
const STORES = ["incoming", "outgoing", "people", "settings"];

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let db;
let apiOnline = false;
let state = {
  incoming: [],
  outgoing: [],
  people: [],
  settings: { nextNumber: 1, directorEmail: "director@municipio.gob.mx" },
};

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      STORES.forEach((store) => {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store, { keyPath: "id" });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function detectApi() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    apiOnline = response.ok;
  } catch {
    apiOnline = false;
  }
}

function renderConnectionMode() {
  const note = $("#syncNote");
  if (!note) return;
  note.innerHTML = apiOnline
    ? "<strong>Servidor activo</strong><span>Los registros y documentos se guardan en el servidor configurado.</span>"
    : "<strong>Modo local</strong><span>Los registros se guardan en este equipo. Exporta respaldos desde el panel de datos.</span>";
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) throw new Error(`Error del servidor ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function getAll(store) {
  if (apiOnline) return apiRequest(`/api/${store}`);
  return new Promise((resolve, reject) => {
    const request = tx(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(store, value) {
  if (apiOnline) {
    return apiRequest(`/api/${store}/${encodeURIComponent(value.id)}`, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  }
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function remove(store, id) {
  if (apiOnline) {
    return apiRequest(`/api/${store}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function fileToRecord(file) {
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: reader.result,
    });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}

function normalize(value = "") {
  return String(value).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

async function loadState() {
  const [incoming, outgoing, people, settingsRows] = await Promise.all([
    getAll("incoming"),
    getAll("outgoing"),
    getAll("people"),
    getAll("settings"),
  ]);
  state.incoming = incoming.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  state.outgoing = outgoing.sort((a, b) => b.number - a.number);
  state.people = people.sort((a, b) => a.name.localeCompare(b.name));
  state.settings = settingsRows.find((row) => row.id === "main") || state.settings;
  if (!state.people.length) {
    await seedPeople();
    state.people = await getAll("people");
  }
  render();
}

async function seedPeople() {
  const starter = [
    { id: uid(), name: "Director", role: "Director de Planeacion y Desarrollo Urbano", email: state.settings.directorEmail },
    { id: uid(), name: "Ventanilla", role: "Recepcion documental", email: "" },
    { id: uid(), name: "Tecnico de Desarrollo Urbano", role: "Respuesta tecnica", email: "" },
  ];
  await Promise.all(starter.map((person) => put("people", person)));
}

function render() {
  renderStats();
  renderPeople();
  renderIncoming();
  renderOutgoing();
  fillSelects();
}

function renderStats() {
  const pending = state.incoming.filter((item) => item.status !== "Respondido").length;
  const assigned = state.incoming.filter((item) => item.assignee).length;
  $("#statReceived").textContent = state.incoming.length;
  $("#statPending").textContent = pending;
  $("#statAssigned").textContent = assigned;
  $("#statNext").textContent = String(state.settings.nextNumber).padStart(3, "0");
  $("#nextBadge").textContent = `Siguiente ${String(state.settings.nextNumber).padStart(3, "0")}`;
  $("#settingsForm").elements.directorEmail.value = state.settings.directorEmail;
}

function renderPeople() {
  const list = $("#personList");
  if (!state.people.length) return renderEmpty(list);
  list.innerHTML = state.people.map((person) => `
    <article class="record-card">
      <div class="record-title">
        <strong>${escapeHtml(person.name)}</strong>
        <button class="link-button" type="button" data-delete-person="${person.id}">Eliminar</button>
      </div>
      <div class="meta">
        <span>${escapeHtml(person.role)}</span>
        ${person.email ? `<span>${escapeHtml(person.email)}</span>` : ""}
      </div>
    </article>
  `).join("");
}

function renderIncoming() {
  const list = $("#incomingList");
  const q = normalize($("#searchIncoming").value);
  const status = $("#statusFilter").value;
  const rows = state.incoming.filter((item) => {
    const matchesText = !q || normalize(`${item.folio} ${item.sender} ${item.subject} ${item.assignee || ""}`).includes(q);
    const matchesStatus = !status || item.status === status;
    return matchesText && matchesStatus;
  });
  if (!rows.length) return renderEmpty(list);
  list.innerHTML = rows.map((item) => {
    const priorityClass = item.priority === "Alta" || item.priority === "Urgente" ? " high" : "";
    return `
      <article class="record-card">
        <div class="record-main">
          <div class="record-title">
            <strong>${escapeHtml(item.folio)} · ${escapeHtml(item.sender)}</strong>
            <span class="pill${priorityClass}">${escapeHtml(item.priority)}</span>
          </div>
          <span>${escapeHtml(item.subject)}</span>
          <div class="meta">
            <span>Recibido: ${escapeHtml(item.receivedAt)}</span>
            <span>Estado: ${escapeHtml(item.status)}</span>
            ${item.assignee ? `<span>Asignado a: ${escapeHtml(item.assignee)}</span>` : ""}
            ${item.dueAt ? `<span>Limite: ${escapeHtml(item.dueAt)}</span>` : ""}
          </div>
          ${item.instructions ? `<p>${escapeHtml(item.instructions)}</p>` : ""}
        </div>
        <div class="card-actions">
          <button class="button" type="button" data-assign="${item.id}">Asignar</button>
          <button class="button" type="button" data-status="${item.id}" data-next-status="Respondido">Marcar respondido</button>
          <button class="button ghost" type="button" data-email="${item.id}">Avisar director</button>
          ${item.document ? `<a class="button ghost" href="${item.document.url || item.document.dataUrl}" download="${escapeHtml(item.document.name)}">Ver escaneo</a>` : ""}
          <button class="link-button" type="button" data-delete-incoming="${item.id}">Eliminar</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderOutgoing() {
  const list = $("#outgoingList");
  const q = normalize($("#searchOutgoing").value);
  const rows = state.outgoing.filter((item) => !q || normalize(`${item.fullNumber} ${item.recipient} ${item.subject} ${item.author}`).includes(q));
  if (!rows.length) return renderEmpty(list);
  list.innerHTML = rows.map((item) => `
    <article class="record-card">
      <div class="record-title">
        <strong>${escapeHtml(item.fullNumber)}</strong>
        <span class="pill">${escapeHtml(item.createdAt)}</span>
      </div>
      <span>${escapeHtml(item.subject)}</span>
      <div class="meta">
        <span>Para: ${escapeHtml(item.recipient)}</span>
        <span>Elabora: ${escapeHtml(item.author)}</span>
      </div>
      <div class="card-actions">
        <button class="button ghost" type="button" data-copy="${item.fullNumber}">Copiar numero</button>
        <button class="link-button" type="button" data-delete-outgoing="${item.id}">Eliminar</button>
      </div>
    </article>
  `).join("");
}

function renderEmpty(list) {
  list.innerHTML = $("#emptyTemplate").innerHTML;
}

function fillSelects() {
  const options = state.people.map((person) => `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)} - ${escapeHtml(person.role)}</option>`).join("");
  $("#authorSelect").innerHTML = options;
  $("#assignmentForm select[name='assignee']").innerHTML = options;
}

function buildDirectorEmail(item) {
  const subject = encodeURIComponent(`Nuevo oficio recibido: ${item.folio}`);
  const body = encodeURIComponent([
    "Director:",
    "",
    `Se registro un oficio para revision.`,
    `Folio: ${item.folio}`,
    `Fecha de recepcion: ${item.receivedAt}`,
    `Remitente: ${item.sender}`,
    `Prioridad: ${item.priority}`,
    `Asunto: ${item.subject}`,
    item.notes ? `Observaciones: ${item.notes}` : "",
    "",
    "Favor de ingresar a la PWA para asignar responsable de respuesta.",
  ].filter(Boolean).join("\n"));
  return `mailto:${state.settings.directorEmail}?subject=${subject}&body=${body}`;
}

function openDirectorEmail(item) {
  window.location.href = buildDirectorEmail(item);
}

async function saveSettings() {
  await put("settings", { id: "main", ...state.settings });
}

async function refresh() {
  await loadState();
}

function bindTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
      $$(".view").forEach((view) => view.classList.toggle("is-active", view.id === `view-${tab.dataset.view}`));
    });
  });
}

function bindForms() {
  $("#incomingForm").elements.receivedAt.value = today();
  $("#outgoingForm").elements.createdAt.value = today();

  $("#incomingForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const documentFile = form.elements.document.files[0];
    const item = {
      id: uid(),
      folio: data.folio.trim(),
      receivedAt: data.receivedAt,
      sender: data.sender.trim(),
      subject: data.subject.trim(),
      priority: data.priority,
      status: data.status,
      notes: data.notes.trim(),
      document: await fileToRecord(documentFile),
      createdAt: new Date().toISOString(),
    };
    await put("incoming", item);
    form.reset();
    form.elements.receivedAt.value = today();
    await refresh();
    openDirectorEmail(item);
  });

  $("#outgoingForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const number = state.settings.nextNumber;
    const year = new Date(`${data.createdAt}T00:00:00`).getFullYear();
    const item = {
      id: uid(),
      number,
      fullNumber: `${data.prefix.toUpperCase()}-${String(number).padStart(3, "0")}/${year}`,
      prefix: data.prefix.toUpperCase(),
      createdAt: data.createdAt,
      recipient: data.recipient.trim(),
      subject: data.subject.trim(),
      author: data.author,
    };
    state.settings.nextNumber += 1;
    await Promise.all([put("outgoing", item), saveSettings()]);
    form.reset();
    form.elements.prefix.value = "DPDU";
    form.elements.createdAt.value = today();
    await refresh();
  });

  $("#personForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    await put("people", {
      id: uid(),
      name: data.name.trim(),
      role: data.role.trim(),
      email: data.email.trim(),
    });
    form.reset();
    await refresh();
  });

  $("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    state.settings.directorEmail = form.elements.directorEmail.value.trim();
    await saveSettings();
    await refresh();
  });

  $("#assignmentForm").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "assign") return;
    event.preventDefault();
    const dialog = $("#assignmentDialog");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const item = state.incoming.find((row) => row.id === data.id);
    if (!item) return;
    item.assignee = data.assignee;
    item.dueAt = data.dueAt;
    item.instructions = data.instructions.trim();
    item.status = "Asignado";
    await put("incoming", item);
    dialog.close();
    await refresh();
  });
}

function bindLists() {
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    const incomingId = target.dataset.assign;
    if (incomingId) {
      const item = state.incoming.find((row) => row.id === incomingId);
      if (!item) return;
      const form = $("#assignmentForm");
      form.elements.id.value = item.id;
      form.elements.assignee.value = item.assignee || state.people[0]?.name || "";
      form.elements.dueAt.value = item.dueAt || "";
      form.elements.instructions.value = item.instructions || "";
      $("#assignmentDialog").showModal();
      return;
    }

    if (target.dataset.email) {
      const item = state.incoming.find((row) => row.id === target.dataset.email);
      if (item) openDirectorEmail(item);
      return;
    }

    if (target.dataset.status) {
      const item = state.incoming.find((row) => row.id === target.dataset.status);
      if (!item) return;
      item.status = target.dataset.nextStatus;
      await put("incoming", item);
      await refresh();
      return;
    }

    if (target.dataset.deleteIncoming) {
      await remove("incoming", target.dataset.deleteIncoming);
      await refresh();
      return;
    }

    if (target.dataset.deleteOutgoing) {
      await remove("outgoing", target.dataset.deleteOutgoing);
      await refresh();
      return;
    }

    if (target.dataset.deletePerson) {
      await remove("people", target.dataset.deletePerson);
      await refresh();
      return;
    }

    if (target.dataset.copy) {
      await navigator.clipboard.writeText(target.dataset.copy);
      target.textContent = "Copiado";
      setTimeout(() => { target.textContent = "Copiar numero"; }, 1200);
    }
  });

  ["searchIncoming", "statusFilter", "searchOutgoing"].forEach((id) => {
    $(`#${id}`).addEventListener("input", render);
  });
}

function bindImportExport() {
  $("#exportBtn").addEventListener("click", () => {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `respaldo-oficios-${today()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  $("#importInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const imported = JSON.parse(await file.text());
    const incoming = imported.incoming || [];
    const outgoing = imported.outgoing || [];
    const people = imported.people || [];
    const settings = imported.settings || state.settings;
    await Promise.all([
      ...incoming.map((item) => put("incoming", item)),
      ...outgoing.map((item) => put("outgoing", item)),
      ...people.map((item) => put("people", item)),
      put("settings", { id: "main", ...settings }),
    ]);
    event.target.value = "";
    await refresh();
  });
}

function bindInstallPrompt() {
  let deferredPrompt;
  const installBtn = $("#installBtn");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installBtn.hidden = false;
  });
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });
}

async function init() {
  db = await openDb();
  await detectApi();
  renderConnectionMode();
  bindTabs();
  bindForms();
  bindLists();
  bindImportExport();
  bindInstallPrompt();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }
  await loadState();
}

init().catch((error) => {
  document.body.innerHTML = `<main class="workspace"><section class="panel"><h1>No se pudo iniciar</h1><p>${escapeHtml(error.message)}</p></section></main>`;
});
