import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_ANON_KEY, SUPABASE_DOCUMENT_BUCKET, SUPABASE_URL } from "./supabase-config.js";

const DB_NAME = "oficios-pwa";
const DB_VERSION = 1;
const STORES = ["incoming", "outgoing", "people", "settings"];
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let db;
let apiOnline = false;
let supabaseOnline = false;
let supabaseStatus = "not-configured";
let supabase = null;
let currentUser = null;
let currentProfile = null;
let state = {
  incoming: [],
  outgoing: [],
  people: [],
  settings: { nextNumber: 1, directorEmail: "director@municipio.gob.mx" },
};

const SUPABASE_TABLES = {
  people: "personal",
  incoming: "oficios_recibidos",
  outgoing: "oficios_generados",
  settings: "configuracion",
};

function isSupabaseConfigured() {
  return Boolean(
    SUPABASE_URL
    && SUPABASE_ANON_KEY
    && !SUPABASE_URL.includes("TU_")
    && !SUPABASE_ANON_KEY.includes("TU_")
  );
}

async function detectSupabase() {
  if (!isSupabaseConfigured()) {
    supabaseStatus = "not-configured";
    return;
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessionData } = await supabase.auth.getSession();
  currentUser = sessionData.session?.user || null;
  if (!currentUser) {
    supabaseStatus = "auth-required";
    return;
  }
  const { error } = await supabase.from("configuracion").select("id").eq("id", "main").limit(1);
  supabaseOnline = !error;
  supabaseStatus = error ? `error: ${error.message}` : "online";
  if (supabaseOnline) await loadCurrentProfile();
  if (error) console.warn("Supabase no disponible:", error.message);
}

async function loadCurrentProfile() {
  const { data, error } = await supabase
    .from("perfiles")
    .select("rol, personal_id")
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (error) throw error;
  currentProfile = data || null;
}

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
  if (supabaseOnline) {
    note.innerHTML = "<strong>Supabase activo</strong><span>Los registros y documentos se guardan en la nube.</span>";
    return;
  }
  if (supabaseStatus === "not-configured") {
    note.innerHTML = "<strong>Supabase sin configurar</strong><span>Faltan variables de entorno en Netlify o no corrio el build.</span>";
    return;
  }
  if (supabaseStatus === "auth-required") {
    note.innerHTML = "<strong>Acceso requerido</strong><span>Inicia sesion para usar la nube.</span>";
    return;
  }
  if (supabaseStatus.startsWith("error:")) {
    note.innerHTML = `<strong>Error Supabase</strong><span>${escapeHtml(supabaseStatus.replace("error: ", ""))}</span>`;
    return;
  }
  note.innerHTML = apiOnline
    ? "<strong>Servidor activo</strong><span>Los registros y documentos se guardan en el servidor configurado.</span>"
    : "<strong>Modo local</strong><span>Los registros se guardan en este equipo. Exporta respaldos desde el panel de datos.</span>";
}

function hasRole(...roles) {
  if (!supabaseOnline) return true;
  return roles.includes(currentProfile?.rol);
}

function requireRole(...roles) {
  if (!hasRole(...roles)) {
    throw new Error("No tienes permisos para esta accion.");
  }
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
  if (supabaseOnline) return supabaseGetAll(store);
  if (apiOnline) return apiRequest(`/api/${store}`);
  return new Promise((resolve, reject) => {
    const request = tx(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(store, value) {
  if (supabaseOnline) return supabasePut(store, value);
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
  if (supabaseOnline) return supabaseRemove(store, id);
  if (apiOnline) {
    return apiRequest(`/api/${store}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function personToApp(row) {
  return {
    id: row.id,
    name: row.nombre,
    role: row.cargo,
    email: row.correo || "",
  };
}

function personToDb(person) {
  return {
    id: person.id,
    nombre: person.name,
    cargo: person.role,
    correo: person.email || null,
  };
}

async function signedDocument(row) {
  if (!row.documento_url) return null;
  if (/^https?:\/\//i.test(row.documento_url)) {
    return {
      name: row.documento_nombre || "documento",
      path: row.documento_url,
      url: row.documento_url,
    };
  }
  const { data, error } = await supabase.storage
    .from(SUPABASE_DOCUMENT_BUCKET)
    .createSignedUrl(row.documento_url, 60 * 10);
  if (error) throw error;
  return {
    name: row.documento_nombre || "documento",
    path: row.documento_url,
    url: data.signedUrl,
  };
}

async function incomingToApp(row) {
  const person = state.people.find((item) => item.id === row.asignado_a);
  return {
    id: row.id,
    folio: row.folio,
    receivedAt: row.fecha_recepcion,
    sender: row.remitente,
    subject: row.asunto,
    priority: row.prioridad || "Normal",
    status: row.estado || "Pendiente de asignacion",
    notes: row.observaciones || "",
    document: await signedDocument(row),
    assignee: person?.name || "",
    assigneeId: row.asignado_a || "",
    dueAt: row.fecha_limite || "",
    createdAt: row.creado_en || new Date().toISOString(),
  };
}

async function incomingToDb(item) {
  const uploadedDocument = await uploadSupabaseDocument(item);
  const assigneeId = item.assigneeId || state.people.find((person) => person.name === item.assignee)?.id || null;
  return {
    id: item.id,
    folio: item.folio,
    fecha_recepcion: item.receivedAt,
    remitente: item.sender,
    asunto: item.subject,
    prioridad: item.priority,
    estado: item.status,
    observaciones: item.notes || null,
    documento_url: uploadedDocument?.path || item.document?.path || null,
    documento_nombre: uploadedDocument?.name || item.document?.name || null,
    asignado_a: assigneeId,
    fecha_limite: item.dueAt || null,
    creado_en: item.createdAt || new Date().toISOString(),
  };
}

function outgoingToApp(row) {
  const person = state.people.find((item) => item.id === row.elaboro);
  return {
    id: row.id,
    number: row.numero,
    fullNumber: row.numero_completo,
    prefix: row.prefijo,
    createdAt: row.fecha,
    recipient: row.destinatario,
    subject: row.asunto,
    author: person?.name || "",
    authorId: row.elaboro || "",
  };
}

function outgoingToDb(item) {
  const authorId = item.authorId || state.people.find((person) => person.name === item.author)?.id || null;
  return {
    id: item.id,
    numero: item.number,
    numero_completo: item.fullNumber,
    prefijo: item.prefix,
    fecha: item.createdAt,
    destinatario: item.recipient,
    asunto: item.subject,
    elaboro: authorId,
  };
}

function settingsToApp(row) {
  return {
    id: row.id,
    nextNumber: row.siguiente_numero,
    directorEmail: row.correo_director,
  };
}

function settingsToDb(settings) {
  return {
    id: settings.id || "main",
    siguiente_numero: settings.nextNumber,
    correo_director: settings.directorEmail,
  };
}

function safeFilename(value) {
  return String(value || "documento")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "documento";
}

function assertValidDocument(file) {
  if (!file) return;
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error("El documento supera el limite de 10 MB.");
  }
  if (!ALLOWED_DOCUMENT_TYPES.has(file.type)) {
    throw new Error("Solo se permiten PDF, JPG, PNG o WebP.");
  }
}

function safeDocumentHref(value) {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (["https:", "http:", "blob:"].includes(url.protocol)) return value;
    if (url.protocol === "data:" && /^data:(application\/pdf|image\/(jpeg|png|webp));/i.test(value)) return value;
  } catch {
    return "";
  }
  return "";
}

async function uploadSupabaseDocument(item) {
  if (!item.document?.dataUrl) return item.document || null;
  const response = await fetch(item.document.dataUrl);
  const blob = await response.blob();
  const year = new Date().getFullYear();
  const filename = `${item.id}-${safeFilename(item.document.name)}`;
  const path = `${year}/${filename}`;
  const { error } = await supabase.storage
    .from(SUPABASE_DOCUMENT_BUCKET)
    .upload(path, blob, {
      contentType: item.document.type || blob.type || "application/octet-stream",
      upsert: true,
    });
  if (error) throw error;
  return {
    name: item.document.name,
    path,
    url: null,
  };
}

async function supabaseGetAll(store) {
  if (store === "settings") {
    const { data, error } = await supabase.from(SUPABASE_TABLES.settings).select("*");
    if (error) throw error;
    return data.map(settingsToApp);
  }

  if (store === "people") {
    const { data, error } = await supabase.from(SUPABASE_TABLES.people).select("*").order("nombre");
    if (error) throw error;
    return data.map(personToApp);
  }

  if (store === "incoming") {
    const { data, error } = await supabase.from(SUPABASE_TABLES.incoming).select("*").order("creado_en", { ascending: false });
    if (error) throw error;
    return Promise.all(data.map(incomingToApp));
  }

  if (store === "outgoing") {
    const { data, error } = await supabase.from(SUPABASE_TABLES.outgoing).select("*").order("numero", { ascending: false });
    if (error) throw error;
    return data.map(outgoingToApp);
  }

  return [];
}

async function supabasePut(store, value) {
  if (store === "outgoing") {
    requireRole("admin", "director", "ventanilla");
    const authorId = value.authorId || state.people.find((person) => person.name === value.author)?.id || null;
    const { data, error } = await supabase.rpc("generar_oficio", {
      p_prefijo: value.prefix,
      p_fecha: value.createdAt,
      p_destinatario: value.recipient,
      p_asunto: value.subject,
      p_elaboro: authorId,
    });
    if (error) throw error;
    return data;
  }

  let payload = value;
  if (store === "people") {
    requireRole("admin", "director");
    payload = personToDb(value);
  }
  if (store === "incoming") {
    requireRole("admin", "director", "ventanilla", "responsable");
    payload = await incomingToDb(value);
  }
  if (store === "settings") {
    requireRole("admin", "director");
    payload = settingsToDb(value);
  }

  const { data, error } = await supabase
    .from(SUPABASE_TABLES[store])
    .upsert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function supabaseRemove(store, id) {
  if (store === "people" || store === "outgoing") requireRole("admin");
  if (store === "incoming") requireRole("admin", "director");
  const { error } = await supabase.from(SUPABASE_TABLES[store]).delete().eq("id", id);
  if (error) throw error;
}

function fileToRecord(file) {
  if (!file) return Promise.resolve(null);
  assertValidDocument(file);
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
  const [people, settingsRows] = await Promise.all([
    getAll("people"),
    getAll("settings"),
  ]);
  state.people = people.sort((a, b) => a.name.localeCompare(b.name));
  state.settings = settingsRows.find((row) => row.id === "main") || state.settings;
  if (!state.people.length) {
    await seedPeople();
    state.people = await getAll("people");
  }
  const [incoming, outgoing] = await Promise.all([
    getAll("incoming"),
    getAll("outgoing"),
  ]);
  state.incoming = incoming.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  state.outgoing = outgoing.sort((a, b) => b.number - a.number);
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
  renderPermissions();
}

function renderPermissions() {
  const canManagePeople = hasRole("admin", "director");
  const canConfigure = hasRole("admin", "director");
  const canCreateIncoming = hasRole("admin", "director", "ventanilla");
  const canCreateOutgoing = hasRole("admin", "director", "ventanilla");
  const canMoveData = hasRole("admin", "director");
  $("#personForm").hidden = supabaseOnline && !canManagePeople;
  $("#settingsForm").hidden = supabaseOnline && !canConfigure;
  $("#incomingForm").hidden = supabaseOnline && !canCreateIncoming;
  $("#outgoingForm").hidden = supabaseOnline && !canCreateOutgoing;
  $("#exportBtn").hidden = supabaseOnline && !canMoveData;
  const importLabel = $("#importInput")?.closest("label");
  if (importLabel) importLabel.hidden = supabaseOnline && !canMoveData;
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
  const canDelete = hasRole("admin");
  list.innerHTML = state.people.map((person) => `
    <article class="record-card">
      <div class="record-title">
        <strong>${escapeHtml(person.name)}</strong>
        ${canDelete ? `<button class="link-button" type="button" data-delete-person="${person.id}">Eliminar</button>` : ""}
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
    const documentHref = safeDocumentHref(item.document?.url || item.document?.dataUrl);
    const canAssign = hasRole("admin", "director");
    const canDelete = hasRole("admin", "director");
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
        </div>
        <div class="card-actions">
          ${canAssign ? `<button class="button" type="button" data-assign="${item.id}">Asignar</button>` : ""}
          <button class="button" type="button" data-status="${item.id}" data-next-status="Respondido">Marcar respondido</button>
          <button class="button ghost" type="button" data-email="${item.id}">Avisar director</button>
          ${documentHref ? `<a class="button ghost" href="${escapeHtml(documentHref)}" target="_blank" rel="noopener" download="${escapeHtml(item.document.name)}">Ver escaneo</a>` : ""}
          ${canDelete ? `<button class="link-button" type="button" data-delete-incoming="${item.id}">Eliminar</button>` : ""}
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
        ${hasRole("admin") ? `<button class="link-button" type="button" data-delete-outgoing="${item.id}">Eliminar</button>` : ""}
      </div>
    </article>
  `).join("");
}

function renderEmpty(list) {
  list.innerHTML = $("#emptyTemplate").innerHTML;
}

function renderAssignmentDocument(item) {
  const container = $("#assignmentDocument");
  if (!container) return;
  const documentUrl = item.document?.url || item.document?.dataUrl;
  const safeHref = safeDocumentHref(documentUrl);
  if (!safeHref) {
    container.innerHTML = `
      <span>Documento recibido</span>
      <p>Este oficio no tiene escaneo adjunto.</p>
    `;
    return;
  }
  const name = item.document?.name || "Documento recibido";
  container.innerHTML = `
    <span>Documento recibido</span>
    <a class="button ghost" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener" download="${escapeHtml(name)}">Ver documento</a>
  `;
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

function showMessage(message, type = "info") {
  let box = $("#appMessage");
  if (!box) {
    box = document.createElement("div");
    box.id = "appMessage";
    box.className = "app-message";
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.dataset.type = type;
  box.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    box.hidden = true;
  }, 7000);
}

function describeError(error) {
  return error?.message || String(error);
}

function showAuthScreen(show) {
  const authScreen = $("#authScreen");
  const appShell = $(".app-shell");
  if (authScreen) authScreen.hidden = !show;
  if (appShell) appShell.hidden = show;
  const logoutBtn = $("#logoutBtn");
  if (logoutBtn) logoutBtn.hidden = show || !supabaseOnline;
}

function bindAuth() {
  const authForm = $("#authForm");
  const logoutBtn = $("#logoutBtn");
  if (authForm) {
    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        if (!supabase) throw new Error("Supabase no esta configurado.");
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        const { data: authData, error } = await supabase.auth.signInWithPassword({
          email: data.email.trim(),
          password: data.password,
        });
        if (error) throw error;
        currentUser = authData.user;
        await detectSupabase();
        renderConnectionMode();
        showAuthScreen(false);
        await loadState();
        showMessage("Sesion iniciada.", "success");
      } catch (error) {
        showMessage(`No se pudo iniciar sesion: ${describeError(error)}`, "error");
      }
    });
  }
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (supabase) await supabase.auth.signOut();
      currentUser = null;
      currentProfile = null;
      supabaseOnline = false;
      supabaseStatus = "auth-required";
      renderConnectionMode();
      showAuthScreen(true);
    });
  }
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
    try {
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
      showMessage("Oficio guardado correctamente.", "success");
      openDirectorEmail(item);
    } catch (error) {
      showMessage(`No se pudo guardar el oficio: ${describeError(error)}`, "error");
    }
  });

  $("#outgoingForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
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
      if (supabaseOnline) {
        await put("outgoing", item);
      } else {
        state.settings.nextNumber += 1;
        await Promise.all([put("outgoing", item), saveSettings()]);
      }
      form.reset();
      form.elements.prefix.value = "DPDU";
      form.elements.createdAt.value = today();
      await refresh();
      showMessage("Consecutivo guardado correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo guardar el consecutivo: ${describeError(error)}`, "error");
    }
  });

  $("#personForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
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
      showMessage("Persona guardada correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo guardar la persona: ${describeError(error)}`, "error");
    }
  });

  $("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const form = event.currentTarget;
      state.settings.directorEmail = form.elements.directorEmail.value.trim();
      await saveSettings();
      await refresh();
      showMessage("Configuracion guardada correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo guardar la configuracion: ${describeError(error)}`, "error");
    }
  });

  $("#assignmentForm").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "assign") return;
    event.preventDefault();
    try {
      requireRole("admin", "director");
      const dialog = $("#assignmentDialog");
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const item = state.incoming.find((row) => row.id === data.id);
      if (!item) return;
      item.assignee = data.assignee;
      item.dueAt = data.dueAt;
      item.status = "Asignado";
      await put("incoming", item);
      dialog.close();
      await refresh();
      showMessage("Asignacion guardada correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo guardar la asignacion: ${describeError(error)}`, "error");
    }
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
      renderAssignmentDocument(item);
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
  await detectSupabase();
  await detectApi();
  bindAuth();
  renderConnectionMode();
  if (isSupabaseConfigured() && supabaseStatus === "auth-required") {
    showAuthScreen(true);
    return;
  }
  if (isSupabaseConfigured() && !supabaseOnline) {
    showAuthScreen(false);
    throw new Error(supabaseStatus.replace("error: ", "") || "No se pudo conectar a Supabase.");
  }
  showAuthScreen(false);
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
