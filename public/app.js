import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LOCAL_DOCUMENT_SERVER_URL, SUPABASE_ANON_KEY, SUPABASE_DOCUMENT_BUCKET, SUPABASE_URL } from "./supabase-config.js";

const DB_NAME = "oficios-pwa";
const DB_VERSION = 1;
const STORES = ["incoming", "outgoing", "people", "settings"];
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const DEFAULT_ADMIN_DELETE_KEY = "1234";

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let db;
let apiOnline = false;
let supabaseOnline = false;
let supabaseStatus = "not-configured";
let supabase = null;
let currentUser = null;
let currentProfile = null;
let particleCleanup = null;
let state = {
  incoming: [],
  outgoing: [],
  people: [],
  settings: { nextNumber: 1, directorEmail: "director@municipio.gob.mx", adminDeleteKey: DEFAULT_ADMIN_DELETE_KEY },
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
  if (isSupabaseConfigured()) {
    apiOnline = false;
    return;
  }
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
    phone: row.telefono || "",
  };
}

function personToDb(person) {
  return {
    id: supabaseRecordId(person.id),
    nombre: person.name,
    cargo: person.role,
    correo: person.email || null,
    telefono: person.phone || null,
  };
}

function supabaseRecordId(value) {
  return UUID_PATTERN.test(String(value || "")) ? value : uid();
}

function supabaseOptionalUuid(value) {
  return UUID_PATTERN.test(String(value || "")) ? value : null;
}

async function signedStorageDocument(pathValue, nameValue) {
  if (!pathValue) return null;
  if (/^https?:\/\//i.test(pathValue)) {
    return {
      name: nameValue || "documento",
      path: pathValue,
      url: pathValue,
    };
  }
  const { data, error } = await supabase.storage
    .from(SUPABASE_DOCUMENT_BUCKET)
    .createSignedUrl(pathValue, 60 * 10);
  if (error) throw error;
  return {
    name: nameValue || "documento",
    path: pathValue,
    url: data.signedUrl,
  };
}

async function incomingToApp(row) {
  const person = state.people.find((item) => item.id === row.asignado_a);
  const assignees = person ? [person.name] : [];
  return {
    id: row.id,
    folio: row.folio,
    receivedAt: row.fecha_recepcion,
    sender: row.remitente,
    subject: row.asunto,
    priority: row.prioridad || "Normal",
    status: row.estado || "Pendiente de asignacion",
    notes: row.observaciones || "",
    document: await signedStorageDocument(row.documento_url, row.documento_nombre),
    responseText: row.respuesta || "",
    responseAt: row.fecha_respuesta || "",
    responseDocument: await signedStorageDocument(row.respuesta_documento_url, row.respuesta_documento_nombre),
    assignee: person?.name || "",
    assignees,
    assigneeId: row.asignado_a || "",
    assigneeIds: row.asignado_a ? [row.asignado_a] : [],
    dueAt: row.fecha_limite || "",
    createdAt: row.creado_en || new Date().toISOString(),
  };
}

async function incomingToDb(item) {
  const recordId = supabaseRecordId(item.id);
  const uploadedDocument = await uploadSupabaseDocument(item.document, recordId, "recibidos");
  const uploadedResponseDocument = await uploadSupabaseDocument(item.responseDocument, recordId, "respuestas");
  const assigneeId = item.assigneeIds?.[0] || item.assigneeId || state.people.find((person) => person.name === item.assignee)?.id || null;
  return {
    id: recordId,
    folio: item.folio,
    fecha_recepcion: item.receivedAt,
    remitente: item.sender,
    asunto: item.subject,
    prioridad: item.priority,
    estado: item.status,
    observaciones: item.notes || null,
    documento_url: uploadedDocument?.path || item.document?.path || null,
    documento_nombre: uploadedDocument?.name || item.document?.name || null,
    respuesta: item.responseText || null,
    fecha_respuesta: item.responseAt || null,
    respuesta_documento_url: uploadedResponseDocument?.path || item.responseDocument?.path || null,
    respuesta_documento_nombre: uploadedResponseDocument?.name || item.responseDocument?.name || null,
    asignado_a: supabaseOptionalUuid(assigneeId),
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
    id: supabaseRecordId(item.id),
    numero: item.number,
    numero_completo: item.fullNumber,
    prefijo: item.prefix,
    fecha: item.createdAt,
    destinatario: item.recipient,
    asunto: item.subject,
    elaboro: supabaseOptionalUuid(authorId),
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

async function uploadSupabaseDocument(documentRecord, ownerId, folderName) {
  if (!documentRecord?.dataUrl) return documentRecord || null;
  if (LOCAL_DOCUMENT_SERVER_URL) {
    const response = await fetch(`${LOCAL_DOCUMENT_SERVER_URL.replace(/\/$/, "")}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document: documentRecord,
        ownerId,
        folderName,
      }),
    });
    if (!response.ok) {
      throw new Error(`No se pudo guardar el documento local (${response.status}).`);
    }
    return response.json();
  }

  const response = await fetch(documentRecord.dataUrl);
  const blob = await response.blob();
  const year = new Date().getFullYear();
  const filename = `${ownerId}-${safeFilename(documentRecord.name)}`;
  const path = `${folderName}/${year}/${filename}`;
  const { error } = await supabase.storage
    .from(SUPABASE_DOCUMENT_BUCKET)
    .upload(path, blob, {
      contentType: documentRecord.type || blob.type || "application/octet-stream",
      upsert: true,
    });
  if (error) throw error;
  return {
    name: documentRecord.name,
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
      p_elaboro: supabaseOptionalUuid(authorId),
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

function normalizePrefix(value = "") {
  return String(value || "DPDU").trim().toUpperCase() || "DPDU";
}

function outgoingYear(value) {
  return new Date(`${value || today()}T00:00:00`).getFullYear();
}

function nextOutgoingNumber(prefixValue, dateValue) {
  const prefix = normalizePrefix(prefixValue);
  const year = outgoingYear(dateValue);
  const lastNumber = state.outgoing
    .filter((item) => normalizePrefix(item.prefix) === prefix && outgoingYear(item.createdAt) === year)
    .reduce((max, item) => Math.max(max, Number(item.number) || 0), 0);
  return lastNumber + 1;
}

function nextOutgoingFullNumber(prefixValue, dateValue) {
  const prefix = normalizePrefix(prefixValue);
  const number = nextOutgoingNumber(prefix, dateValue);
  return `${prefix}-${String(number).padStart(3, "0")}/${outgoingYear(dateValue)}`;
}

function statusClass(value = "") {
  const normalized = normalize(value);
  if (normalized.includes("respondido")) return " done";
  if (normalized.includes("asignado")) return " assigned";
  if (normalized.includes("revision")) return " review";
  return " pending";
}

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "");
}

function whatsappPhone(value = "") {
  const phone = normalizePhone(value);
  if (!phone) return "";
  return phone.startsWith("52") ? phone : `52${phone}`;
}

function getAssigneeNames(item) {
  if (Array.isArray(item.assignees) && item.assignees.length) return item.assignees.filter(Boolean);
  if (item.assignee) return [item.assignee];
  return [];
}

function getAdminDeleteKey() {
  return state.settings.adminDeleteKey || DEFAULT_ADMIN_DELETE_KEY;
}

function confirmAdminDelete() {
  const key = window.prompt("Clave de administrador para borrar:");
  if (key === null) return false;
  if (key !== getAdminDeleteKey()) {
    showMessage("Clave de administrador incorrecta.", "error");
    return false;
  }
  return window.confirm("Esta accion borrara el registro. Deseas continuar?");
}

function normalizeIncomingItem(item) {
  const assignees = Array.isArray(item.assignees)
    ? item.assignees.filter(Boolean)
    : String(item.assignees || item.assignee || "").split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  return {
    ...item,
    assignees,
    assignee: assignees.join(", ") || item.assignee || "",
  };
}

let xlsxPromise;
function loadXlsx() {
  if (!xlsxPromise) xlsxPromise = import(XLSX_URL);
  return xlsxPromise;
}

async function loadState() {
  const [people, settingsRows] = await Promise.all([
    getAll("people"),
    getAll("settings"),
  ]);
  state.people = people.sort((a, b) => a.name.localeCompare(b.name));
  state.settings = settingsRows.find((row) => row.id === "main") || state.settings;
  state.settings = { adminDeleteKey: DEFAULT_ADMIN_DELETE_KEY, ...state.settings };
  if (!state.people.length) {
    await seedPeople();
    state.people = await getAll("people");
  }
  const [incoming, outgoing] = await Promise.all([
    getAll("incoming"),
    getAll("outgoing"),
  ]);
  state.incoming = incoming.map(normalizeIncomingItem).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const assigned = state.incoming.filter((item) => getAssigneeNames(item).length).length;
  const outgoingForm = $("#outgoingForm");
  const nextFullNumber = nextOutgoingFullNumber(
    outgoingForm?.elements.prefix.value,
    outgoingForm?.elements.createdAt.value
  );
  $("#statReceived").textContent = state.incoming.length;
  $("#statPending").textContent = pending;
  $("#statAssigned").textContent = assigned;
  $("#statNext").textContent = nextFullNumber;
  $("#nextBadge").textContent = `Siguiente ${nextFullNumber}`;
  $("#settingsForm").elements.directorEmail.value = state.settings.directorEmail;
  $("#settingsForm").elements.adminDeleteKey.value = state.settings.adminDeleteKey || "";
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
        <span class="meta-chip">${escapeHtml(person.role)}</span>
        ${person.email ? `<span class="meta-chip">${escapeHtml(person.email)}</span>` : ""}
        ${person.phone ? `<span class="meta-chip">WhatsApp: ${escapeHtml(person.phone)}</span>` : ""}
      </div>
    </article>
  `).join("");
}

function renderIncoming() {
  const list = $("#incomingList");
  const q = normalize($("#searchIncoming").value);
  const status = $("#statusFilter").value;
  const rows = state.incoming.filter((item) => {
    const matchesText = !q || normalize(`${item.folio} ${item.sender} ${item.subject} ${getAssigneeNames(item).join(" ")}`).includes(q);
    const matchesStatus = !status || item.status === status;
    return matchesText && matchesStatus;
  });
  if (!rows.length) return renderEmpty(list);
  list.innerHTML = rows.map((item) => {
    const priorityClass = item.priority === "Alta" || item.priority === "Urgente" ? " high" : "";
    const statusPillClass = statusClass(item.status);
    const documentHref = safeDocumentHref(item.document?.url || item.document?.dataUrl);
    const responseDocumentHref = safeDocumentHref(item.responseDocument?.url || item.responseDocument?.dataUrl);
    const canAssign = hasRole("admin", "director");
    const canDelete = hasRole("admin", "director");
    const canRespond = hasRole("admin", "director", "ventanilla", "responsable");
    return `
      <article class="record-card">
        <div class="record-main">
          <div class="record-title">
            <strong>${escapeHtml(item.folio)} - ${escapeHtml(item.sender)}</strong>
            <span class="pill${priorityClass}">${escapeHtml(item.priority)}</span>
          </div>
          <p class="record-subject">${escapeHtml(item.subject)}</p>
          <div class="meta">
            <span class="status-pill${statusPillClass}">${escapeHtml(item.status)}</span>
            <span class="meta-chip">Recibido: ${escapeHtml(item.receivedAt)}</span>
            ${getAssigneeNames(item).length ? `<span class="meta-chip">Asignado a: ${escapeHtml(getAssigneeNames(item).join(", "))}</span>` : ""}
            ${item.dueAt ? `<span class="meta-chip">Limite: ${escapeHtml(item.dueAt)}</span>` : ""}
            ${item.responseAt ? `<span class="meta-chip">Respondido: ${escapeHtml(item.responseAt)}</span>` : ""}
          </div>
          ${item.responseText ? `<div class="response-summary"><strong>Respuesta</strong><p>${escapeHtml(item.responseText)}</p></div>` : ""}
        </div>
        <div class="card-actions">
          ${canAssign ? `<button class="button primary soft-primary" type="button" data-assign="${item.id}">Asignar</button>` : ""}
          ${canRespond ? `<button class="button" type="button" data-response="${item.id}">Responder</button>` : ""}
          <button class="button ghost" type="button" data-email="${item.id}">Avisar director</button>
          ${documentHref ? `<a class="button ghost" href="${escapeHtml(documentHref)}" target="_blank" rel="noopener" download="${escapeHtml(item.document.name)}">Ver escaneo</a>` : ""}
          ${responseDocumentHref ? `<a class="button ghost" href="${escapeHtml(responseDocumentHref)}" target="_blank" rel="noopener" download="${escapeHtml(item.responseDocument.name)}">Ver respuesta</a>` : ""}
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
        <strong class="code-number">${escapeHtml(item.fullNumber)}</strong>
        <span class="pill">${escapeHtml(item.createdAt)}</span>
      </div>
      <p class="record-subject">${escapeHtml(item.subject)}</p>
      <div class="meta">
        <span class="meta-chip">Para: ${escapeHtml(item.recipient)}</span>
        <span class="meta-chip">Elabora: ${escapeHtml(item.author)}</span>
      </div>
      <div class="card-actions">
        <button class="button primary soft-primary" type="button" data-copy="${item.fullNumber}">Copiar numero</button>
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
  const prefixOptions = $("#prefixOptions");
  if (prefixOptions) {
    const prefixes = new Set(["DPDU", "CFAGU", "IP", "PP", "MR", "PYSP", ...state.outgoing.map((item) => normalizePrefix(item.prefix))]);
    prefixOptions.innerHTML = [...prefixes].map((prefix) => `<option value="${escapeHtml(prefix)}"></option>`).join("");
  }
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

function peopleForAssignees(item) {
  const names = new Set(getAssigneeNames(item));
  return state.people.filter((person) => names.has(person.name));
}

function buildAssignmentMessage(item) {
  return [
    "Se te asigno un oficio para seguimiento.",
    `Folio: ${item.folio}`,
    `Remitente: ${item.sender}`,
    `Asunto: ${item.subject}`,
    item.dueAt ? `Fecha limite: ${item.dueAt}` : "",
  ].filter(Boolean).join("\n");
}

function mailtoAssignment(item, people) {
  const emails = people.map((person) => person.email).filter(Boolean);
  if (!emails.length) return "";
  const subject = encodeURIComponent(`Oficio asignado: ${item.folio}`);
  const body = encodeURIComponent(buildAssignmentMessage(item));
  return `mailto:${emails.join(",")}?subject=${subject}&body=${body}`;
}

function whatsappAssignmentLinks(item, people) {
  const text = encodeURIComponent(buildAssignmentMessage(item));
  return people
    .map((person) => whatsappPhone(person.phone))
    .filter(Boolean)
    .map((phone) => `https://wa.me/52${phone}?text=${text}`);
}

function openAssignmentNotifications(item) {
  const people = peopleForAssignees(item);
  const mail = mailtoAssignment(item, people);
  const whatsappLinks = whatsappAssignmentLinks(item, people);
  if (mail) window.location.href = mail;
  whatsappLinks.slice(0, 3).forEach((link) => window.open(link, "_blank", "noopener"));
  if (!mail && !whatsappLinks.length) {
    showMessage("Asignacion guardada. Agrega correo o WhatsApp al personal para notificar.", "info");
  }
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
  if (!error) return "Error desconocido";
  const parts = [error.message, error.details, error.hint, error.code].filter(Boolean);
  return parts.length ? parts.join(" ") : String(error);
}

function showAuthScreen(show) {
  const authScreen = $("#authScreen");
  const appShell = $(".app-shell");
  if (authScreen) authScreen.hidden = !show;
  if (appShell) appShell.hidden = show;
  const logoutBtn = $("#logoutBtn");
  if (logoutBtn) logoutBtn.hidden = show || !supabaseOnline;
  if (show) startParticles();
  else stopParticles();
}

function startParticles() {
  if (particleCleanup || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("#particleCanvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  let width = 0;
  let height = 0;
  let frame = 0;
  let particles = [];
  const palette = ["rgba(255,255,255,0.72)", "rgba(240,228,207,0.7)", "rgba(128,181,156,0.55)"];

  function resize() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const count = Math.max(28, Math.min(82, Math.floor((width * height) / 13500)));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() - 0.5) * 0.28,
      radius: 1.2 + Math.random() * 2.4,
      color: palette[Math.floor(Math.random() * palette.length)],
    }));
  }

  function tick() {
    context.clearRect(0, 0, width, height);
    particles.forEach((particle, index) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      if (particle.x < -10) particle.x = width + 10;
      if (particle.x > width + 10) particle.x = -10;
      if (particle.y < -10) particle.y = height + 10;
      if (particle.y > height + 10) particle.y = -10;

      context.beginPath();
      context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      context.fillStyle = particle.color;
      context.fill();

      for (let next = index + 1; next < particles.length; next += 1) {
        const other = particles[next];
        const dx = particle.x - other.x;
        const dy = particle.y - other.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 115) {
          context.beginPath();
          context.moveTo(particle.x, particle.y);
          context.lineTo(other.x, other.y);
          context.strokeStyle = `rgba(255,255,255,${0.12 * (1 - distance / 115)})`;
          context.lineWidth = 1;
          context.stroke();
        }
      }
    });
    frame = requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener("resize", resize);
  frame = requestAnimationFrame(tick);
  particleCleanup = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    context.clearRect(0, 0, width, height);
    particleCleanup = null;
  };
}

function stopParticles() {
  if (particleCleanup) particleCleanup();
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
  ["prefix", "createdAt"].forEach((name) => {
    $("#outgoingForm").elements[name].addEventListener("input", renderStats);
  });

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
      const prefix = normalizePrefix(data.prefix);
      const number = nextOutgoingNumber(prefix, data.createdAt);
      const year = outgoingYear(data.createdAt);
      const item = {
        id: uid(),
        number,
        fullNumber: `${prefix}-${String(number).padStart(3, "0")}/${year}`,
        prefix,
        createdAt: data.createdAt,
        recipient: data.recipient.trim(),
        subject: data.subject.trim(),
        author: data.author,
      };
      if (supabaseOnline) {
        await put("outgoing", item);
      } else {
        await put("outgoing", item);
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
        phone: normalizePhone(data.phone),
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
      state.settings.adminDeleteKey = form.elements.adminDeleteKey.value.trim() || DEFAULT_ADMIN_DELETE_KEY;
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
      const formData = new FormData(event.currentTarget);
      const data = Object.fromEntries(formData);
      const item = state.incoming.find((row) => row.id === data.id);
      if (!item) return;
      const assignees = formData.getAll("assignee").filter(Boolean);
      item.assignees = assignees;
      item.assignee = assignees.join(", ");
      item.assigneeIds = assignees
        .map((name) => state.people.find((person) => person.name === name)?.id)
        .filter(Boolean);
      item.dueAt = data.dueAt;
      item.status = "Asignado";
      await put("incoming", item);
      dialog.close();
      await refresh();
      showMessage("Asignacion guardada correctamente.", "success");
      openAssignmentNotifications(item);
    } catch (error) {
      showMessage(`No se pudo guardar la asignacion: ${describeError(error)}`, "error");
    }
  });

  $("#responseForm").addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "save-response") return;
    event.preventDefault();
    try {
      requireRole("admin", "director", "ventanilla", "responsable");
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      const item = state.incoming.find((row) => row.id === data.id);
      if (!item) return;
      const responseFile = form.elements.responseDocument.files[0];
      item.responseAt = data.responseAt;
      item.responseText = data.responseText.trim();
      item.responseDocument = await fileToRecord(responseFile) || item.responseDocument || null;
      item.status = "Respondido";
      await put("incoming", item);
      $("#responseDialog").close();
      form.reset();
      await refresh();
      showMessage("Respuesta guardada correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo guardar la respuesta: ${describeError(error)}`, "error");
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
      const selected = new Set(getAssigneeNames(item));
      [...form.elements.assignee.options].forEach((option) => {
        option.selected = selected.has(option.value);
      });
      form.elements.dueAt.value = item.dueAt || "";
      renderAssignmentDocument(item);
      $("#assignmentDialog").showModal();
      return;
    }

    if (target.dataset.response) {
      const item = state.incoming.find((row) => row.id === target.dataset.response);
      if (!item) return;
      const form = $("#responseForm");
      form.elements.id.value = item.id;
      form.elements.responseAt.value = item.responseAt || today();
      form.elements.responseText.value = item.responseText || "";
      form.elements.responseDocument.value = "";
      $("#responseDialog").showModal();
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
      if (!confirmAdminDelete()) return;
      await remove("incoming", target.dataset.deleteIncoming);
      await refresh();
      return;
    }

    if (target.dataset.deleteOutgoing) {
      if (!confirmAdminDelete()) return;
      await remove("outgoing", target.dataset.deleteOutgoing);
      await refresh();
      return;
    }

    if (target.dataset.deletePerson) {
      if (!confirmAdminDelete()) return;
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

function excelRows() {
  return {
    Recibidos: state.incoming.map((item) => ({
      id: item.id,
      folio: item.folio,
      fecha_recepcion: item.receivedAt,
      remitente: item.sender,
      asunto: item.subject,
      prioridad: item.priority,
      estado: item.status,
      responsables: getAssigneeNames(item).join("; "),
      fecha_limite: item.dueAt || "",
      fecha_respuesta: item.responseAt || "",
      observaciones: item.notes || "",
      respuesta: item.responseText || "",
    })),
    Consecutivos: state.outgoing.map((item) => ({
      id: item.id,
      numero: item.number,
      numero_completo: item.fullNumber,
      prefijo: item.prefix,
      fecha: item.createdAt,
      destinatario: item.recipient,
      asunto: item.subject,
      elaboro: item.author,
    })),
    Personal: state.people.map((person) => ({
      id: person.id,
      nombre: person.name,
      cargo: person.role,
      correo: person.email || "",
      whatsapp: person.phone || "",
    })),
    Configuracion: [{
      id: "main",
      siguiente_numero: state.settings.nextNumber,
      correo_director: state.settings.directorEmail,
      clave_borrado: state.settings.adminDeleteKey || DEFAULT_ADMIN_DELETE_KEY,
    }],
  };
}

async function exportExcel() {
  const XLSX = await loadXlsx();
  const workbook = XLSX.utils.book_new();
  const rows = excelRows();
  Object.entries(rows).forEach(([name, data]) => {
    const sheet = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  });
  XLSX.writeFile(workbook, `respaldo-oficios-${today()}.xlsx`);
}

function importedFromWorkbook(workbook, XLSX) {
  const sheet = (name) => XLSX.utils.sheet_to_json(workbook.Sheets[name] || {});
  const incoming = sheet("Recibidos").map((row) => normalizeIncomingItem({
    id: row.id || uid(),
    folio: row.folio || "",
    receivedAt: row.fecha_recepcion || today(),
    sender: row.remitente || "",
    subject: row.asunto || "",
    priority: row.prioridad || "Normal",
    status: row.estado || "Pendiente de asignacion",
    assignees: String(row.responsables || "").split(";").map((value) => value.trim()).filter(Boolean),
    dueAt: row.fecha_limite || "",
    responseAt: row.fecha_respuesta || "",
    notes: row.observaciones || "",
    responseText: row.respuesta || "",
    createdAt: new Date().toISOString(),
  }));
  const outgoing = sheet("Consecutivos").map((row) => ({
    id: row.id || uid(),
    number: Number(row.numero) || 1,
    fullNumber: row.numero_completo || "",
    prefix: row.prefijo || "DPDU",
    createdAt: row.fecha || today(),
    recipient: row.destinatario || "",
    subject: row.asunto || "",
    author: row.elaboro || "",
  }));
  const people = sheet("Personal").map((row) => ({
    id: row.id || uid(),
    name: row.nombre || "",
    role: row.cargo || "",
    email: row.correo || "",
    phone: row.whatsapp || "",
  })).filter((person) => person.name);
  const config = sheet("Configuracion")[0] || {};
  return {
    incoming,
    outgoing,
    people,
    settings: {
      id: "main",
      nextNumber: Number(config.siguiente_numero) || state.settings.nextNumber,
      directorEmail: config.correo_director || state.settings.directorEmail,
      adminDeleteKey: config.clave_borrado || state.settings.adminDeleteKey || DEFAULT_ADMIN_DELETE_KEY,
    },
  };
}

async function parseImportFile(file) {
  if (file.name.toLowerCase().endsWith(".json")) return JSON.parse(await file.text());
  const XLSX = await loadXlsx();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer);
  return importedFromWorkbook(workbook, XLSX);
}

function bindImportExport() {
  $("#exportBtn").addEventListener("click", async () => {
    try {
      await exportExcel();
      showMessage("Respaldo de Excel generado.", "success");
    } catch (error) {
      showMessage(`No se pudo exportar Excel: ${describeError(error)}`, "error");
    }
  });

  $("#importInput").addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      const imported = await parseImportFile(file);
      const incoming = imported.incoming || [];
      const outgoing = imported.outgoing || [];
      const people = imported.people || [];
      const settings = imported.settings || state.settings;
      await Promise.all([
        ...incoming.map((item) => put("incoming", normalizeIncomingItem(item))),
        ...outgoing.map((item) => put("outgoing", item)),
        ...people.map((item) => put("people", item)),
        put("settings", { id: "main", ...settings }),
      ]);
      event.target.value = "";
      await refresh();
      showMessage("Importacion completada.", "success");
    } catch (error) {
      showMessage(`No se pudo importar: ${describeError(error)}`, "error");
    }
  });
}

function bindInstallPrompt() {
  let deferredPrompt;
  const installBtn = $("#installBtn");
  if (!installBtn) return;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isStandalone) {
    installBtn.hidden = true;
    return;
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installBtn.hidden = false;
  });
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) {
      showMessage("Para instalar: en Android/Chrome usa menu > Instalar app. En iPhone/Safari usa Compartir > Agregar a pantalla de inicio.", "info");
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
    showMessage("App instalada correctamente.", "success");
  });
}

function bindLiveRefresh() {
  let refreshing = false;
  const isEditing = () => {
    const active = document.activeElement;
    const editingTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);
    return document.hidden
      || Boolean($("dialog[open]"))
      || Boolean(active && editingTags.has(active.tagName));
  };
  const run = async () => {
    if (refreshing || isEditing()) return;
    refreshing = true;
    try {
      await refresh();
    } catch (error) {
      console.warn("No se pudo actualizar en vivo:", error);
    } finally {
      refreshing = false;
    }
  };
  setInterval(run, 6000);
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) run();
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
  bindLiveRefresh();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }
  await loadState();
}

init().catch((error) => {
  document.body.innerHTML = `<main class="workspace"><section class="panel"><h1>No se pudo iniciar</h1><p>${escapeHtml(error.message)}</p></section></main>`;
});
