import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LOCAL_DOCUMENT_SERVER_URL, SUPABASE_ANON_KEY, SUPABASE_DOCUMENT_BUCKET, SUPABASE_URL } from "./supabase-config.js";

const DB_NAME = "oficios-pwa";
const DB_VERSION = 1;
const DATA_SCHEMA_VERSION = 1;
const STORES = ["incoming", "outgoing", "people", "settings"];
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const LOCAL_API_TOKEN_KEY = "oficios-local-api-token";
const LOCAL_NOTIFICATION_SETTINGS_KEY = "oficios-notification-settings";
const REMINDER_STATE_KEY = "oficios-reminders-shown";
const PREFIX_OPTIONS = [
  { value: "DPDU", label: "DPDU", color: "#00a878" },
  { value: "CFAGU", label: "CFAGU", color: "#1e88ff" },
  { value: "IP", label: "IP", color: "#ffb000" },
  { value: "PP", label: "PP", color: "#ff4f7b" },
  { value: "MR", label: "MR", color: "#7c5cff" },
  { value: "PYSP", label: "PYSP", color: "#00bcd4" },
  { value: "DU", label: "DU", color: "#6cc24a" },
  { value: "OP", label: "OP", color: "#ff7a1a" },
];
const REMINDER_WINDOWS = [
  { key: "3d", label: "3 dias", hours: 72 },
  { key: "2d", label: "2 dias", hours: 48 },
  { key: "1d", label: "1 dia", hours: 24 },
  { key: "12h", label: "12 horas", hours: 12 },
  { key: "6h", label: "6 horas", hours: 6 },
  { key: "1h", label: "1 hora", hours: 1 },
];
const DEFAULT_SETTINGS = {
  nextNumber: 1,
  directorEmail: "dir.planeacionydu@gmail.com",
  directorPhone: "",
  adminDeleteKey: "",
  notifyEmail: true,
  notifyWhatsapp: false,
  notifySystem: true,
};

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let db;
let apiOnline = false;
let apiStorage = "local";
let supabaseOnline = false;
let supabaseStatus = "not-configured";
let supabase = null;
let currentUser = null;
let currentProfile = null;
let particleCleanup = null;
let calendarCursor = new Date(`${today()}T00:00:00`);
let state = {
  incoming: [],
  outgoing: [],
  people: [],
  settings: { ...DEFAULT_SETTINGS },
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
    apiOnline = false;
    if (response.ok) {
      const health = await response.json();
      apiStorage = health.storage || "local";
      apiOnline = true;
    }
  } catch {
    apiOnline = false;
    apiStorage = "local";
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
    if (apiOnline) {
      note.innerHTML = "<strong>Servidor activo</strong><span>Los registros y documentos se guardan en el servidor local.</span>";
      return;
    }
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
  const requestOptions = {
    ...options,
    headers: apiHeaders(options.headers),
  };
  const response = await fetch(path, {
    ...requestOptions,
  });
  if (response.status === 401 && promptForLocalApiToken()) {
    const retry = await fetch(path, {
      ...requestOptions,
      headers: apiHeaders(options.headers),
    });
    if (!retry.ok) throw new Error(await responseErrorMessage(retry));
    if (retry.status === 204) return null;
    return retry.json();
  }
  if (!response.ok) throw new Error(await responseErrorMessage(response));
  if (response.status === 204) return null;
  return response.json();
}

async function responseErrorMessage(response) {
  try {
    const payload = await response.json();
    if (payload?.error) return payload.error;
  } catch {
    // Ignore non-JSON error bodies.
  }
  return `Error del servidor ${response.status}`;
}

function localApiToken() {
  return localStorage.getItem(LOCAL_API_TOKEN_KEY) || "";
}

function apiHeaders(headers = {}) {
  const token = localApiToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
}

function promptForLocalApiToken() {
  const token = window.prompt("Token de acceso del servidor local:");
  if (!token) return false;
  localStorage.setItem(LOCAL_API_TOKEN_KEY, token.trim());
  return true;
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

function createOutgoing(value) {
  if (supabaseOnline) return supabasePut("outgoing", value);
  if (apiOnline) {
    return apiRequest("/api/outgoing", {
      method: "POST",
      body: JSON.stringify(value),
    });
  }
  return put("outgoing", value);
}

function remove(store, id) {
  if (supabaseOnline) return supabaseRemove(store, id);
  if (apiOnline) {
    return apiRequest(`/api/${store}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Delete-Key": state.pendingDeleteKey || "" },
    });
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
    instructions: row.instrucciones || "",
    createdAt: row.creado_en || new Date().toISOString(),
  };
}

async function incomingToDb(item) {
  const recordId = supabaseRecordId(item.id);
  const uploadedDocument = await uploadSupabaseDocument(item.document, recordId, "recibidos");
  const uploadedResponseDocument = await uploadSupabaseDocument(item.responseDocument, recordId, "respuestas");
  const assigneeNames = getAssigneeNames(item);
  const assigneeId = item.assigneeIds?.[0] || item.assigneeId || assigneeNames.map((name) => personByName(name)?.id).find(Boolean) || null;
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
    instrucciones: item.instructions || null,
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
    directorPhone: row.telefono_director || "",
    adminDeleteKey: row.clave_borrado || "",
    notifyEmail: row.notificar_correo ?? true,
    notifyWhatsapp: row.notificar_whatsapp ?? false,
    notifySystem: row.notificar_sistema ?? true,
  };
}

function settingsToDb(settings) {
  return {
    id: settings.id || "main",
    siguiente_numero: settings.nextNumber,
    correo_director: settings.directorEmail,
    telefono_director: settings.directorPhone || null,
    clave_borrado: settings.adminDeleteKey || null,
    notificar_correo: Boolean(settings.notifyEmail),
    notificar_whatsapp: Boolean(settings.notifyWhatsapp),
    notificar_sistema: Boolean(settings.notifySystem),
  };
}

function legacySettingsToDb(settings) {
  return {
    id: settings.id || "main",
    siguiente_numero: settings.nextNumber,
    correo_director: settings.directorEmail,
  };
}

function isSchemaCacheColumnError(error) {
  return error?.code === "PGRST204" || /schema cache|column/i.test(error?.message || "");
}

function loadLocalNotificationSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(LOCAL_NOTIFICATION_SETTINGS_KEY) || "{}");
    return {
      directorPhone: settings.directorPhone || "",
      notifyEmail: settings.notifyEmail ?? true,
      notifyWhatsapp: settings.notifyWhatsapp ?? false,
      notifySystem: settings.notifySystem ?? true,
    };
  } catch {
    return {};
  }
}

function saveLocalNotificationSettings(settings) {
  localStorage.setItem(LOCAL_NOTIFICATION_SETTINGS_KEY, JSON.stringify({
    directorPhone: settings.directorPhone || "",
    notifyEmail: Boolean(settings.notifyEmail),
    notifyWhatsapp: Boolean(settings.notifyWhatsapp),
    notifySystem: Boolean(settings.notifySystem),
  }));
}

function loadReminderState() {
  try {
    return JSON.parse(localStorage.getItem(REMINDER_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveReminderState(value) {
  localStorage.setItem(REMINDER_STATE_KEY, JSON.stringify(value));
}

function safeFilename(value) {
  return String(value || "documento")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "documento";
}

function fileExtension(name = "") {
  const match = String(name).match(/\.([a-zA-Z0-9]{1,12})$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function oficioDownloadName(fullNumber, fallbackName = "oficio.docx") {
  const baseName = safeFilename(fullNumber || "oficio");
  const extension = fileExtension(fallbackName) || ".docx";
  return `${baseName}${extension}`;
}

function basenameWithoutExtension(name = "") {
  const safeName = safeFilename(name);
  const extension = fileExtension(safeName);
  return extension ? safeName.slice(0, -extension.length) : safeName;
}

function assertValidDocument(file) {
  if (!file) return;
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error("El documento supera el limite de 15 MB.");
  }
  if (!ALLOWED_DOCUMENT_TYPES.has(file.type)) {
    throw new Error("Solo se permiten PDF, Word, JPG, PNG o WebP.");
  }
}

function safeDocumentHref(value) {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (["https:", "http:", "blob:"].includes(url.protocol)) return value;
    if (url.protocol === "data:" && /^data:(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|image\/(jpeg|png|webp));/i.test(value)) return value;
  } catch {
    return "";
  }
  return "";
}

function localDocumentServerBase() {
  if (LOCAL_DOCUMENT_SERVER_URL) return LOCAL_DOCUMENT_SERVER_URL.replace(/\/$/, "");
  if (apiOnline) return "";
  return "";
}

function outgoingWordHref(item) {
  const base = localDocumentServerBase();
  return `${base}/api/outgoing-word/${encodeURIComponent(item.id)}`;
}

async function downloadOutgoingWord(item) {
  const response = await fetch(outgoingWordHref(item), { headers: apiHeaders() });
  if (!response.ok) throw new Error(`No se pudo descargar el oficio (${response.status}).`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = oficioDownloadName(item.fullNumber, "oficio.docx");
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function uploadLocalDocument(documentRecord, ownerId, folderName) {
  if (!documentRecord?.dataUrl) return documentRecord || null;
  const base = localDocumentServerBase();
  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: apiHeaders(),
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

async function uploadSupabaseDocument(documentRecord, ownerId, folderName) {
  if (!documentRecord?.dataUrl) return documentRecord || null;
  if (localDocumentServerBase() || apiOnline) return uploadLocalDocument(documentRecord, ownerId, folderName);

  const response = await fetch(documentRecord.dataUrl);
  const blob = await response.blob();
  const year = new Date().getFullYear();
  const extension = fileExtension(documentRecord.name);
  const baseName = safeFilename(`${ownerId}-${basenameWithoutExtension(documentRecord.name)}`);
  const filename = `${baseName}-${Date.now()}-${uid().slice(0, 8)}${extension}`;
  const path = `${folderName}/${year}/${filename}`;
  const { error } = await supabase.storage
    .from(SUPABASE_DOCUMENT_BUCKET)
    .upload(path, blob, {
      contentType: documentRecord.type || blob.type || "application/octet-stream",
      upsert: false,
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
    const { data, error } = await supabase
      .from(SUPABASE_TABLES.settings)
      .upsert(payload)
      .select()
      .single();
    if (!error) return data;
    if (!isSchemaCacheColumnError(error)) throw error;
    console.warn("Configuracion con esquema anterior; se guardan preferencias nuevas localmente.", error.message);
    const fallback = await supabase
      .from(SUPABASE_TABLES.settings)
      .upsert(legacySettingsToDb(value))
      .select()
      .single();
    if (fallback.error) throw fallback.error;
    return fallback.data;
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

function prefixOption(value = "") {
  const prefix = normalizePrefix(value);
  return PREFIX_OPTIONS.find((item) => item.value === prefix) || { value: prefix, label: prefix, color: "#e056fd" };
}

function prefixStyle(value = "") {
  return `--prefix-color: ${prefixOption(value).color}`;
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

function canUseNativeNotifications() {
  return "Notification" in window && (window.isSecureContext || location.hostname === "localhost");
}

function getAssigneeNames(item) {
  if (Array.isArray(item.assignees) && item.assignees.length) return item.assignees.filter(Boolean);
  if (item.assignee) return [item.assignee];
  if (Array.isArray(item.assigneeIds) && item.assigneeIds.length) {
    return item.assigneeIds
      .map((id) => state.people.find((person) => person.id === id)?.name)
      .filter(Boolean);
  }
  if (item.assigneeId) {
    const person = state.people.find((row) => row.id === item.assigneeId);
    if (person) return [person.name];
  }
  return [];
}

function assignmentNote(item) {
  return item.instructions || item.instrucciones || item.assignmentNote || item.assignmentNotes || "";
}

function personByName(name) {
  const normalizedName = normalize(name);
  return state.people.find((person) => normalize(person.name) === normalizedName);
}

function dueDateTime(item) {
  if (!item.dueAt) return null;
  const date = new Date(`${item.dueAt}T23:59:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dueSummary(item) {
  const due = dueDateTime(item);
  if (!due || item.status === "Respondido") return "";
  const diffMs = due.getTime() - Date.now();
  const absHours = Math.abs(diffMs) / 36e5;
  const days = Math.floor(absHours / 24);
  const hours = Math.ceil(absHours % 24);
  if (diffMs < 0) return `Vencido hace ${days ? `${days} d ` : ""}${hours} h`;
  if (days > 0) return `Vence en ${days} d ${hours} h`;
  return `Vence en ${Math.max(1, Math.ceil(absHours))} h`;
}

function dueClass(item) {
  const due = dueDateTime(item);
  if (!due || item.status === "Respondido") return "";
  const hours = (due.getTime() - Date.now()) / 36e5;
  if (hours < 0) return " overdue";
  if (hours <= 24) return " urgent";
  if (hours <= 72) return " soon";
  return "";
}

function hashString(value = "") {
  return [...String(value)].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0);
}

function userColor(name = "") {
  const palette = ["#245b4e", "#3d6f92", "#946714", "#8f321f", "#455a64", "#5b4b8a", "#2f7f71", "#7a5428", "#276678", "#7b3f61"];
  const index = Math.abs(hashString(name || "Sin asignar")) % palette.length;
  return palette[index];
}

function itemAssigneeColor(item) {
  return userColor(getAssigneeNames(item)[0] || "Sin asignar");
}

function dateOnly(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  return new Date(`${value || today()}T00:00:00`);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function googleCalendarDate(value) {
  const date = dateOnly(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function matchesDueFilter(item, filter) {
  if (!filter) return true;
  if (filter === "none") return !item.dueAt;
  if (!item.dueAt) return false;
  const due = dateOnly(item.dueAt);
  const now = dateOnly(today());
  const diffDays = Math.round((due.getTime() - now.getTime()) / 86400000);
  if (filter === "overdue") return diffDays < 0 && item.status !== "Respondido";
  if (filter === "today") return diffDays === 0;
  if (filter === "week") return diffDays >= 0 && diffDays <= 7;
  return true;
}

function confirmAdminDelete() {
  if (!hasRole("admin", "director")) {
    showMessage("No tienes permisos para borrar este registro.", "error");
    return "";
  }
  const key = window.prompt("Contraseña para borrar:");
  if (key === null) return "";
  if (!key.trim()) {
    showMessage("Ingresa la contraseña para borrar.", "error");
    return "";
  }
  if (!apiOnline && key !== state.settings.adminDeleteKey) {
    showMessage("Contraseña incorrecta. No se borro el registro.", "error");
    return "";
  }
  if (!window.confirm("Esta accion borrara el registro. Deseas continuar?")) return "";
  return key;
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
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...(settingsRows.find((row) => row.id === "main") || state.settings),
    ...loadLocalNotificationSettings(),
  };
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
    { id: uid(), name: "Ventanilla", role: "Recepción documental", email: "" },
    { id: uid(), name: "Tecnico de Desarrollo Urbano", role: "Respuesta tecnica", email: "" },
  ];
  await Promise.all(starter.map((person) => put("people", person)));
}

function render() {
  renderStats();
  renderPeople();
  renderIncoming();
  renderOutgoing();
  renderCalendar();
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
  $("#settingsForm").elements.directorPhone.value = state.settings.directorPhone || "";
  $("#settingsForm").elements.adminDeleteKey.value = state.settings.adminDeleteKey || "";
  $("#settingsForm").elements.notifyEmail.checked = Boolean(state.settings.notifyEmail);
  $("#settingsForm").elements.notifyWhatsapp.checked = Boolean(state.settings.notifyWhatsapp);
  $("#settingsForm").elements.notifySystem.checked = Boolean(state.settings.notifySystem);
  const deviceButton = $("#enableNotificationsBtn");
  if (deviceButton) {
    if (!canUseNativeNotifications()) {
      deviceButton.textContent = "No disponible en este navegador";
      deviceButton.disabled = true;
    } else if (Notification.permission === "granted") {
      deviceButton.textContent = "Notificaciones activas";
    } else if (Notification.permission === "denied") {
      deviceButton.textContent = "Permiso bloqueado";
    } else {
      deviceButton.textContent = "Activar en este dispositivo";
    }
  }
}

function storageModeLabel() {
  if (supabaseOnline) return "Supabase";
  if (apiOnline) return apiStorage === "postgresql" ? "Servidor PostgreSQL" : "Servidor local";
  return "Este equipo";
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
  const priority = $("#priorityFilter")?.value || "";
  const assignee = $("#assigneeFilter")?.value || "";
  const due = $("#dueFilter")?.value || "";
  const rows = state.incoming.filter((item) => {
    const matchesText = !q || normalize(`${item.folio} ${item.sender} ${item.subject} ${getAssigneeNames(item).join(" ")}`).includes(q);
    const matchesStatus = !status || item.status === status;
    const matchesPriority = !priority || item.priority === priority;
    const matchesAssignee = !assignee || getAssigneeNames(item).includes(assignee);
    return matchesText && matchesStatus && matchesPriority && matchesAssignee && matchesDueFilter(item, due);
  });
  if (!rows.length) return renderEmpty(list);
  list.innerHTML = rows.map((item) => {
    const priorityClass = item.priority === "Alta" || item.priority === "Urgente" ? " high" : "";
    const statusPillClass = statusClass(item.status);
    const documentHref = safeDocumentHref(item.document?.url || item.document?.dataUrl);
    const responseDocumentHref = safeDocumentHref(item.responseDocument?.url || item.responseDocument?.dataUrl);
    const dueText = dueSummary(item);
    const canAssign = hasRole("admin", "director");
    const canDelete = hasRole("admin", "director");
    const canRespond = hasRole("admin", "director", "ventanilla", "responsable");
    const canUploadDocument = hasRole("admin", "director", "ventanilla", "responsable");
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
            <span class="meta-chip">Creado: ${escapeHtml((item.createdAt || "").slice(0, 10))}</span>
            <span class="meta-chip">Guardado: ${escapeHtml(storageModeLabel())}</span>
            ${getAssigneeNames(item).length ? `<span class="meta-chip">Asignado a: ${escapeHtml(getAssigneeNames(item).join(", "))}</span>` : ""}
            ${item.dueAt ? `<span class="meta-chip due-chip${dueClass(item)}">Limite: ${escapeHtml(item.dueAt)}${dueText ? ` · ${escapeHtml(dueText)}` : ""}</span>` : ""}
            ${item.responseAt ? `<span class="meta-chip">Respondido: ${escapeHtml(item.responseAt)}</span>` : ""}
            ${item.document ? `<span class="meta-chip">Escaneo adjunto</span>` : `<span class="meta-chip">Sin escaneo</span>`}
            ${item.responseDocument ? `<span class="meta-chip">Respuesta adjunta</span>` : ""}
          </div>
          ${item.notes ? `<div class="response-summary muted"><strong>Observaciones</strong><p>${escapeHtml(item.notes)}</p></div>` : ""}
          ${assignmentNote(item) ? `<div class="response-summary muted"><strong>Notas de asignacion</strong><p>${escapeHtml(assignmentNote(item))}</p></div>` : ""}
          ${item.responseText ? `<div class="response-summary"><strong>Respuesta</strong><p>${escapeHtml(item.responseText)}</p></div>` : ""}
        </div>
        <div class="card-actions">
          ${canAssign ? `<button class="button primary soft-primary" type="button" data-assign="${item.id}">Asignar</button>` : ""}
          ${canRespond ? `<button class="button" type="button" data-response="${item.id}">Responder</button>` : ""}
          <button class="button ghost" type="button" data-email="${item.id}">Avisar director</button>
          ${canUploadDocument ? `<button class="button ghost" type="button" data-upload-incoming-document="${item.id}">${item.document ? "Modificar archivo" : "Subir archivo"}</button>` : ""}
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
  const prefix = $("#prefixFilter")?.value || "";
  const author = $("#authorFilter")?.value || "";
  const rows = state.outgoing.filter((item) => {
    const matchesText = !q || normalize(`${item.fullNumber} ${item.recipient} ${item.subject} ${item.author}`).includes(q);
    const matchesPrefix = !prefix || normalizePrefix(item.prefix) === prefix;
    const matchesAuthor = !author || item.author === author;
    return matchesText && matchesPrefix && matchesAuthor;
  });
  if (!rows.length) return renderEmpty(list);
  list.innerHTML = rows.map((item) => `
    <article class="record-card">
      <div class="record-title">
        <strong class="code-number">${escapeHtml(item.fullNumber)}</strong>
        <span class="pill">${escapeHtml(item.createdAt)}</span>
      </div>
      <p class="record-subject">${escapeHtml(item.subject)}</p>
      <div class="meta">
        <span class="prefix-pill" style="${escapeHtml(prefixStyle(item.prefix))}">${escapeHtml(normalizePrefix(item.prefix))}</span>
        <span class="meta-chip">Para: ${escapeHtml(item.recipient)}</span>
        <span class="meta-chip">Elabora: ${escapeHtml(item.author)}</span>
        <span class="meta-chip">Guardado: ${escapeHtml(storageModeLabel())}</span>
        ${item.document ? `<span class="meta-chip">Oficio guardado</span>` : ""}
      </div>
      <div class="card-actions">
        <button class="button primary soft-primary" type="button" data-download-outgoing-word="${escapeHtml(item.id)}">Descargar oficio membretado</button>
        ${item.document ? `<a class="button ghost" href="${escapeHtml(safeDocumentHref(item.document.url || item.document.dataUrl))}" target="_blank" rel="noopener" download="${escapeHtml(oficioDownloadName(item.fullNumber, item.document.name))}">Ver oficio guardado</a>` : ""}
        ${hasRole("admin") ? `<button class="link-button" type="button" data-delete-outgoing="${item.id}">Eliminar</button>` : ""}
      </div>
    </article>
  `).join("");
}

function renderCalendar() {
  const pending = state.incoming
    .filter((item) => item.dueAt && item.status !== "Respondido")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const renderList = (list) => {
    if (!list) return;
    if (!pending.length) {
      list.innerHTML = `<div class="empty-state compact"><strong>Sin fechas limite</strong><span>Las asignaciones con fecha limite apareceran aqui.</span></div>`;
      return;
    }
    list.innerHTML = pending.slice(0, 12).map((item) => `
      <article class="calendar-item${dueClass(item)}" style="--user-color: ${itemAssigneeColor(item)}">
        <div>
          <strong>${escapeHtml(item.dueAt)}</strong>
          <span>${escapeHtml(item.folio)} - ${escapeHtml(item.sender)}</span>
          <span>Asignado a: ${escapeHtml(getAssigneeNames(item).join(", ") || "Sin asignar")}</span>
          ${assignmentNote(item) ? `<p class="calendar-note"><strong>Nota:</strong> ${escapeHtml(assignmentNote(item))}</p>` : ""}
        </div>
        <span>${escapeHtml(dueSummary(item))}</span>
      </article>
    `).join("");
  };

  renderList($("#calendarList"));

  const month = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), 1);
  const monthEnd = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 0);
  const startOffset = month.getDay();
  const totalCells = Math.ceil((startOffset + monthEnd.getDate()) / 7) * 7;
  const title = $("#calendarTitle");
  if (title) {
    title.textContent = month.toLocaleDateString("es-MX", { month: "long", year: "numeric" });
  }

  const legend = $("#calendarLegend");
  if (legend) {
    const names = [...new Set(pending.flatMap((item) => getAssigneeNames(item)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    legend.innerHTML = names.length
      ? names.map((name) => `<span class="legend-chip" style="--user-color: ${userColor(name)}">${escapeHtml(name)}</span>`).join("")
      : `<span class="legend-chip" style="--user-color: ${userColor("Sin asignar")}">Sin asignar</span>`;
  }

  const calendar = $("#monthCalendar");
  if (!calendar) return;
  const weekdays = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
  const dayCells = Array.from({ length: totalCells }, (_, index) => {
    const dayNumber = index - startOffset + 1;
    const inMonth = dayNumber >= 1 && dayNumber <= monthEnd.getDate();
    const cellDate = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth(), dayNumber);
    const isoDate = inMonth ? cellDate.toISOString().slice(0, 10) : "";
    const items = inMonth ? pending.filter((item) => item.dueAt === isoDate) : [];
    const isToday = isoDate === today();
    return `
      <div class="month-day${inMonth ? "" : " muted"}${isToday ? " today" : ""}">
        <span class="day-number">${inMonth ? dayNumber : ""}</span>
        <div class="day-activities">
          ${items.map((item) => `
            <article class="day-activity${dueClass(item)}" style="--user-color: ${itemAssigneeColor(item)}" title="${escapeHtml(`${item.folio}\nAsignado a: ${getAssigneeNames(item).join(", ") || "Sin asignar"}${assignmentNote(item) ? `\nNotas: ${assignmentNote(item)}` : ""}\n${item.subject}`)}">
              <strong>${escapeHtml(item.folio)}</strong>
              <span>Asignado a: ${escapeHtml(getAssigneeNames(item).join(", ") || "Sin asignar")}</span>
              ${assignmentNote(item) ? `<p class="calendar-note"><strong>Nota:</strong> ${escapeHtml(assignmentNote(item))}</p>` : ""}
            </article>
          `).join("")}
        </div>
      </div>
    `;
  }).join("");
  calendar.innerHTML = `
    ${weekdays.map((day) => `<div class="month-weekday">${day}</div>`).join("")}
    ${dayCells}
  `;
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
  const assigneeChecklist = $("#assigneeChecklist");
  if (assigneeChecklist) {
    assigneeChecklist.innerHTML = state.people.map((person) => `
      <button class="assignee-option" type="button" data-assignee="${escapeHtml(person.name)}" aria-pressed="false">
        <input type="hidden" name="assignee" value="${escapeHtml(person.name)}" disabled>
        <span>
          <strong>${escapeHtml(person.name)}</strong>
          <small>${escapeHtml(person.role || "Sin cargo")}</small>
        </span>
      </button>
    `).join("");
  }
  const assigneeFilter = $("#assigneeFilter");
  if (assigneeFilter) {
    const current = assigneeFilter.value;
    const names = [...new Set(state.people.map((person) => person.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    assigneeFilter.innerHTML = `<option value="">Todos los responsables</option>${names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
    assigneeFilter.value = names.includes(current) ? current : "";
  }
  const authorFilter = $("#authorFilter");
  if (authorFilter) {
    const current = authorFilter.value;
    const names = [...new Set(state.outgoing.map((item) => item.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    authorFilter.innerHTML = `<option value="">Todos los responsables</option>${names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
    authorFilter.value = names.includes(current) ? current : "";
  }
  const prefixSelect = $("#prefixSelect");
  const prefixValues = new Set(["DPDU", "CFAGU", "IP", "PP", "MR", "PYSP", ...state.outgoing.map((item) => normalizePrefix(item.prefix))]);
  if (prefixSelect) {
    const currentPrefix = normalizePrefix(prefixSelect.value);
    prefixSelect.innerHTML = [...prefixValues].map((prefix) => {
      const option = prefixOption(prefix);
      return `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`;
    }).join("");
    prefixSelect.value = prefixValues.has(currentPrefix) ? currentPrefix : "DPDU";
    prefixSelect.style.setProperty("--prefix-color", prefixOption(prefixSelect.value).color);
  }
  const prefixFilter = $("#prefixFilter");
  if (prefixFilter) {
    const current = prefixFilter.value;
    prefixFilter.innerHTML = `<option value="">Todos los prefijos</option>${[...prefixValues].map((prefix) => `<option value="${escapeHtml(prefix)}">${escapeHtml(prefix)}</option>`).join("")}`;
    prefixFilter.value = prefixValues.has(current) ? current : "";
  }
}

function directorMessage(item) {
  const calendarHref = googleCalendarForIncoming(item);
  return [
    "Director, le escribo este mensaje para informarle que se recibió el oficio siguiente:",
    "",
    `Folio: ${item.folio}`,
    `Fecha de recepcion: ${item.receivedAt}`,
    `Remitente: ${item.sender}`,
    `Prioridad: ${item.priority}`,
    `Asunto: ${item.subject}`,
    item.notes ? `Observaciones: ${item.notes}` : "",
    "",
    calendarHref ? `Agendar en Google Calendar: ${calendarHref}` : "",
    "",
    "Ya se encuentra registrado en el Sistema",
  ].filter(Boolean).join("\n");
}

function googleCalendarUrl({ title, date, details, guests = [] }) {
  if (!date) return "";
  const start = googleCalendarDate(date);
  const end = googleCalendarDate(addDays(dateOnly(date), 1));
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${start}/${end}`,
    details,
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Mexico_City",
  });
  const guestList = guests.filter(Boolean).join(",");
  if (guestList) params.set("add", guestList);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function googleCalendarForIncoming(item) {
  const date = item.dueAt || item.receivedAt || today();
  return googleCalendarUrl({
    title: `Seguimiento oficio ${item.folio}`,
    date,
    details: notificationTextForIncoming(item),
    guests: [state.settings.directorEmail],
  });
}

function googleCalendarForAssignment(item, people = []) {
  const date = item.dueAt || today();
  return googleCalendarUrl({
    title: `Responder oficio ${item.folio}`,
    date,
    details: buildAssignmentMessage(item),
    guests: people.map((person) => person.email),
  });
}

function buildGmailCompose(to, subjectText, bodyText) {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to,
    su: subjectText,
    body: bodyText,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function buildDirectorGmail(item) {
  return buildGmailCompose(
    state.settings.directorEmail,
    `Nuevo oficio recibido: ${item.folio}`,
    directorMessage(item)
  );
}

function buildDirectorWhatsapp(item) {
  const phone = whatsappPhone(state.settings.directorPhone);
  if (!phone) return "";
  const text = encodeURIComponent(directorMessage(item));
  return `https://wa.me/${phone}?text=${text}`;
}

function notificationSettings() {
  return {
    email: Boolean(state.settings.notifyEmail),
    whatsapp: Boolean(state.settings.notifyWhatsapp),
    system: Boolean(state.settings.notifySystem),
  };
}

function notificationTextForIncoming(item) {
  return [
    `Folio: ${item.folio}`,
    `Remitente: ${item.sender}`,
    `Asunto: ${item.subject}`,
  ].join("\n");
}

function notificationTextForAssignment(item) {
  return [
    `Folio: ${item.folio}`,
    `Responsable: ${getAssigneeNames(item).join(", ")}`,
    item.dueAt ? `Limite: ${item.dueAt}` : "",
    `Asunto: ${item.subject}`,
  ].filter(Boolean).join("\n");
}

function ensureNotificationCenter() {
  let center = $("#notificationCenter");
  if (center) return center;
  center = document.createElement("section");
  center.id = "notificationCenter";
  center.className = "notification-center";
  center.setAttribute("aria-live", "polite");
  center.innerHTML = `
    <div class="notification-card" role="status">
      <div class="notification-heading">
        <div>
          <span class="notification-kicker">Notificacion</span>
          <strong id="notificationTitle"></strong>
        </div>
        <button class="icon-button" type="button" data-close-notification aria-label="Cerrar">x</button>
      </div>
      <p id="notificationBody"></p>
      <div class="notification-actions" id="notificationActions"></div>
    </div>
  `;
  document.body.appendChild(center);
  return center;
}

function showNotificationPopup({ title, body, actions = [], type = "info" }) {
  const center = ensureNotificationCenter();
  $("#notificationTitle", center).textContent = title;
  $("#notificationBody", center).textContent = body;
  $("#notificationActions", center).innerHTML = actions.length
    ? actions.map((action) => `<a class="button ${action.primary ? "primary" : "ghost"}" href="${escapeHtml(action.href)}" target="${action.target || "_self"}" rel="noopener">${escapeHtml(action.label)}</a>`).join("")
    : `<span class="notification-empty">Sin canales disponibles. Revisa la configuracion y el directorio.</span>`;
  center.dataset.type = type;
  center.hidden = false;
}

async function showNativeNotification(title, body) {
  if (!notificationSettings().system || !canUseNativeNotifications() || Notification.permission !== "granted") return;
  const options = {
    body,
    icon: "icon.svg",
    badge: "icon.svg",
    tag: "oficios-notification",
    data: { url: location.href },
  };
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return;
    }
  } catch (error) {
    console.warn("No se pudo usar el service worker para notificaciones:", error);
  }
  new Notification(title, options);
}

async function requestNativeNotifications() {
  if (!canUseNativeNotifications()) {
    showMessage("Este navegador no permite notificaciones del dispositivo en esta instalacion.", "error");
    renderStats();
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    state.settings.notifySystem = true;
    await saveSettings();
    await showNativeNotification("Control de Oficios", "Las notificaciones del dispositivo estan activas.");
    showMessage("Notificaciones del dispositivo activadas.", "success");
  } else {
    showMessage("El permiso de notificaciones no fue concedido.", "info");
  }
  renderStats();
}

function openDirectorEmail(item) {
  notifyDirector(item);
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
    assignmentNote(item) ? `Notas: ${assignmentNote(item)}` : "",
  ].filter(Boolean).join("\n");
}

function gmailAssignment(item, people) {
  const emails = people.map((person) => person.email).filter(Boolean);
  if (!emails.length) return "";
  const calendarHref = googleCalendarForAssignment(item, people);
  const body = [
    buildAssignmentMessage(item),
    "",
    calendarHref ? `Agendar en Google Calendar: ${calendarHref}` : "",
  ].filter(Boolean).join("\n");
  return buildGmailCompose(emails.join(","), `Oficio asignado: ${item.folio}`, body);
}

function whatsappAssignmentLinks(item, people) {
  const text = encodeURIComponent(buildAssignmentMessage(item));
  return people
    .map((person) => whatsappPhone(person.phone))
    .filter(Boolean)
    .map((phone) => `https://wa.me/${phone}?text=${text}`);
}

function openAssignmentNotifications(item) {
  notifyAssignment(item);
}

function notifyDirector(item) {
  const channels = notificationSettings();
  const actions = [];
  const gmail = buildDirectorGmail(item);
  const whatsapp = buildDirectorWhatsapp(item);
  const calendarHref = googleCalendarForIncoming(item);
  if (channels.email && state.settings.directorEmail) {
    actions.push({ label: "Enviar Correo", href: gmail, target: "_blank", primary: true });
  }
  if (calendarHref) {
    actions.push({ label: "Agendar en Google Calendar", href: calendarHref, target: "_blank" });
  }
  if (channels.whatsapp && whatsapp) {
    actions.push({ label: "Enviar WhatsApp", href: whatsapp, target: "_blank" });
  }
  const title = `Nuevo oficio: ${item.folio}`;
  const body = notificationTextForIncoming(item);
  showNotificationPopup({ title, body, actions, type: "success" });
  showNativeNotification(title, body);
}

function notifyAssignment(item) {
  const people = peopleForAssignees(item);
  const channels = notificationSettings();
  const actions = [];
  const gmail = gmailAssignment(item, people);
  const whatsappLinks = whatsappAssignmentLinks(item, people);
  const calendarHref = googleCalendarForAssignment(item, people);
  if (channels.email && gmail) {
    actions.push({ label: "Enviar Correo", href: gmail, target: "_blank", primary: true });
  }
  if (calendarHref) {
    actions.push({ label: "Agendar en Google Calendar", href: calendarHref, target: "_blank" });
  }
  if (channels.whatsapp) {
    whatsappLinks.slice(0, 4).forEach((href, index) => {
      actions.push({ label: `WhatsApp ${index + 1}`, href, target: "_blank" });
    });
  }
  if (!actions.length) {
    showMessage("Asignacion guardada. Agrega correo o WhatsApp al personal y revisa los canales activos.", "info");
  }
  const title = `Oficio asignado: ${item.folio}`;
  const body = notificationTextForAssignment(item);
  showNotificationPopup({ title, body, actions, type: "success" });
  showNativeNotification(title, body);
}

function checkDueReminders() {
  const shown = loadReminderState();
  let changed = false;
  state.incoming
    .filter((item) => item.dueAt && item.status !== "Respondido")
    .forEach((item) => {
      const due = dueDateTime(item);
      if (!due) return;
      const hoursLeft = (due.getTime() - Date.now()) / 36e5;
      REMINDER_WINDOWS.forEach((windowItem, index) => {
        const nextWindow = REMINDER_WINDOWS[index + 1];
        const reminderKey = `${item.id}:${windowItem.key}`;
        if (shown[reminderKey] || hoursLeft < 0 || hoursLeft > windowItem.hours) return;
        if (nextWindow && hoursLeft <= nextWindow.hours) return;
        shown[reminderKey] = new Date().toISOString();
        changed = true;
        const title = `Vence en ${windowItem.label}: ${item.folio}`;
        const body = [
          `Remitente: ${item.sender}`,
          `Responsable: ${getAssigneeNames(item).join(", ") || "Sin asignar"}`,
          `Fecha limite: ${item.dueAt}`,
          `Asunto: ${item.subject}`,
        ].join("\n");
        showNotificationPopup({ title, body, actions: [], type: "info" });
        showNativeNotification(title, body);
      });
    });
  if (changed) saveReminderState(shown);
}

function bindReminders() {
  checkDueReminders();
  setInterval(checkDueReminders, 5 * 60 * 1000);
}

async function saveSettings() {
  saveLocalNotificationSettings(state.settings);
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
      if (tab.dataset.view === "calendar") renderCalendar();
    });
  });
}

function bindCalendarControls() {
  $("#calendarPrev")?.addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  $("#calendarNext")?.addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  $("#calendarToday")?.addEventListener("click", () => {
    calendarCursor = new Date(`${today()}T00:00:00`);
    renderCalendar();
  });
}

function bindForms() {
  const trackedForms = ["incomingForm", "outgoingForm", "personForm", "settingsForm"];
  trackedForms.forEach((id) => {
    const form = $(`#${id}`);
    if (!form) return;
    const markDirty = () => { form.dataset.dirty = "true"; };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    form.addEventListener("reset", () => { form.dataset.dirty = "false"; });
    form.dataset.dirty = "false";
  });

  $("#incomingForm").elements.receivedAt.value = today();
  $("#outgoingForm").elements.createdAt.value = today();
  ["prefix", "createdAt"].forEach((name) => {
    $("#outgoingForm").elements[name].addEventListener("input", renderStats);
  });
  $("#prefixSelect")?.addEventListener("change", (event) => {
    event.currentTarget.style.setProperty("--prefix-color", prefixOption(event.currentTarget.value).color);
    renderStats();
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
      form.dataset.dirty = "false";
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
      const documentFile = form.elements.document?.files[0];
      const item = {
        id: uid(),
        number,
        fullNumber: `${prefix}-${String(number).padStart(3, "0")}/${year}`,
        prefix,
        createdAt: data.createdAt,
        recipient: data.recipient.trim(),
        subject: data.subject.trim(),
        author: data.author,
        document: await fileToRecord(documentFile),
      };
      await createOutgoing(item);
      form.dataset.dirty = "false";
      form.reset();
      form.elements.prefix.value = "DPDU";
      form.elements.createdAt.value = today();
      form.elements.prefix.style.setProperty("--prefix-color", prefixOption("DPDU").color);
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
      form.dataset.dirty = "false";
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
      state.settings.directorPhone = normalizePhone(form.elements.directorPhone.value);
      state.settings.adminDeleteKey = form.elements.adminDeleteKey.value.trim();
      state.settings.notifyEmail = form.elements.notifyEmail.checked;
      state.settings.notifyWhatsapp = form.elements.notifyWhatsapp.checked;
      state.settings.notifySystem = form.elements.notifySystem.checked;
      await saveSettings();
      form.dataset.dirty = "false";
      await refresh();
      showMessage("Configuracion guardada correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo guardar la configuracion: ${describeError(error)}`, "error");
    }
  });

  $("#enableNotificationsBtn")?.addEventListener("click", requestNativeNotifications);

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
      if (!assignees.length) {
        showMessage("Selecciona al menos una persona responsable.", "error");
        return;
      }
      item.assignees = assignees;
      item.assignee = assignees.join(", ");
      item.assigneeIds = assignees
        .map((name) => personByName(name)?.id)
        .filter(Boolean);
      item.assigneeId = item.assigneeIds[0] || "";
      item.dueAt = data.dueAt;
      item.instructions = String(data.instructions || "").trim();
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

    if (target.dataset.closeNotification !== undefined) {
      const center = $("#notificationCenter");
      if (center) center.hidden = true;
      return;
    }

    const incomingId = target.dataset.assign;
    if (incomingId) {
      const item = state.incoming.find((row) => row.id === incomingId);
      if (!item) return;
      const form = $("#assignmentForm");
      form.elements.id.value = item.id;
      const selected = new Set(getAssigneeNames(item));
      $$(".assignee-option", form).forEach((option) => {
        const isSelected = selected.has(option.dataset.assignee);
        option.classList.toggle("is-selected", isSelected);
        option.setAttribute("aria-pressed", String(isSelected));
        option.querySelector("input[name='assignee']").disabled = !isSelected;
      });
      form.elements.dueAt.value = item.dueAt || "";
      form.elements.instructions.value = item.instructions || "";
      renderAssignmentDocument(item);
      $("#assignmentDialog").showModal();
      return;
    }

    if (target.classList.contains("assignee-option")) {
      const input = target.querySelector("input[name='assignee']");
      const isSelected = target.getAttribute("aria-pressed") === "true";
      target.classList.toggle("is-selected", !isSelected);
      target.setAttribute("aria-pressed", String(!isSelected));
      if (input) input.disabled = isSelected;
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

    if (target.dataset.uploadIncomingDocument) {
      const input = $("#incomingDocumentUpload");
      if (!input) return;
      input.value = "";
      input.dataset.incomingId = target.dataset.uploadIncomingDocument;
      input.click();
      return;
    }

    if (target.dataset.email) {
      const item = state.incoming.find((row) => row.id === target.dataset.email);
      if (item) openDirectorEmail(item);
      return;
    }

    if (target.dataset.downloadOutgoingWord) {
      try {
        const item = state.outgoing.find((row) => row.id === target.dataset.downloadOutgoingWord);
        if (item) await downloadOutgoingWord(item);
      } catch (error) {
        showMessage(`No se pudo descargar el oficio: ${describeError(error)}`, "error");
      }
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
      const deleteKey = confirmAdminDelete();
      if (!deleteKey) return;
      state.pendingDeleteKey = deleteKey;
      try {
        await remove("incoming", target.dataset.deleteIncoming);
        await refresh();
      } catch (error) {
        showMessage(`No se pudo borrar: ${describeError(error)}`, "error");
      } finally {
        state.pendingDeleteKey = "";
      }
      return;
    }

    if (target.dataset.deleteOutgoing) {
      const deleteKey = confirmAdminDelete();
      if (!deleteKey) return;
      state.pendingDeleteKey = deleteKey;
      try {
        await remove("outgoing", target.dataset.deleteOutgoing);
        await refresh();
      } catch (error) {
        showMessage(`No se pudo borrar: ${describeError(error)}`, "error");
      } finally {
        state.pendingDeleteKey = "";
      }
      return;
    }

    if (target.dataset.deletePerson) {
      const deleteKey = confirmAdminDelete();
      if (!deleteKey) return;
      state.pendingDeleteKey = deleteKey;
      try {
        await remove("people", target.dataset.deletePerson);
        await refresh();
      } catch (error) {
        showMessage(`No se pudo borrar: ${describeError(error)}`, "error");
      } finally {
        state.pendingDeleteKey = "";
      }
      return;
    }

  });

  $("#incomingDocumentUpload")?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const item = state.incoming.find((row) => row.id === input.dataset.incomingId);
    const file = input.files?.[0];
    if (!item || !file) return;
    try {
      requireRole("admin", "director", "ventanilla", "responsable");
      item.document = await fileToRecord(file);
      await put("incoming", item);
      await refresh();
      showMessage("Archivo del oficio actualizado correctamente.", "success");
    } catch (error) {
      showMessage(`No se pudo subir el archivo: ${describeError(error)}`, "error");
    } finally {
      input.value = "";
      input.dataset.incomingId = "";
    }
  });

  ["searchIncoming", "statusFilter", "priorityFilter", "assigneeFilter", "dueFilter", "searchOutgoing", "prefixFilter", "authorFilter"].forEach((id) => {
    $(`#${id}`)?.addEventListener("input", render);
  });
}

function excelRows() {
  return {
    Metadatos: [{
      schema_version: DATA_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      app: "Control de Oficios DPDU",
    }],
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
      instrucciones: assignmentNote(item),
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
      telefono_director: state.settings.directorPhone,
      notificar_correo: state.settings.notifyEmail,
      notificar_whatsapp: state.settings.notifyWhatsapp,
      notificar_sistema: state.settings.notifySystem,
      clave_borrado: state.settings.adminDeleteKey || "",
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
  const metadata = sheet("Metadatos")[0] || {};
  const schemaVersion = Number(metadata.schema_version || 0) || 0;
  if (schemaVersion > DATA_SCHEMA_VERSION) {
    throw new Error(`El respaldo usa una version de datos mas nueva (${schemaVersion}). Actualiza la app antes de importar.`);
  }
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
    instructions: row.instrucciones || "",
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
    metadata: {
      schemaVersion: schemaVersion || 1,
      exportedAt: metadata.exported_at || "",
    },
    incoming,
    outgoing,
    people,
    settings: {
      id: "main",
      nextNumber: Number(config.siguiente_numero) || state.settings.nextNumber,
      directorEmail: config.correo_director || state.settings.directorEmail,
      directorPhone: config.telefono_director || state.settings.directorPhone,
      notifyEmail: config.notificar_correo ?? state.settings.notifyEmail,
      notifyWhatsapp: config.notificar_whatsapp ?? state.settings.notifyWhatsapp,
      notifySystem: config.notificar_sistema ?? state.settings.notifySystem,
      adminDeleteKey: config.clave_borrado || state.settings.adminDeleteKey || "",
    },
  };
}

async function parseImportFile(file) {
  if (file.name.toLowerCase().endsWith(".json")) {
    const imported = JSON.parse(await file.text());
    const schemaVersion = Number(imported.metadata?.schemaVersion || imported.schemaVersion || 0) || 0;
    if (schemaVersion > DATA_SCHEMA_VERSION) {
      throw new Error(`El respaldo usa una version de datos mas nueva (${schemaVersion}). Actualiza la app antes de importar.`);
    }
    return imported;
  }
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
      || Boolean($("form[data-dirty='true']"))
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
  bindCalendarControls();
  bindForms();
  bindLists();
  bindImportExport();
  bindInstallPrompt();
  bindLiveRefresh();
  bindReminders();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }
  await loadState();
}

init().catch((error) => {
  document.body.innerHTML = `<main class="workspace"><section class="panel"><h1>No se pudo iniciar</h1><p>${escapeHtml(error.message)}</p></section></main>`;
});
