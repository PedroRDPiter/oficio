const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { Pool } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const WORD_TEMPLATE_FILES = [
  path.join(PROJECT_ROOT, "storage", "BaseOficios", "OficioMembretado.docx"),
  path.join(PROJECT_ROOT, "storage", "BaseOficios", "OficiosBase.docx"),
  path.join(PROJECT_ROOT, "templates", "Oficios.docx"),
  path.join(PROJECT_ROOT, "Oficios.docx"),
];
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(PROJECT_ROOT, "data", "oficios-data.json"));
const DOCUMENTS_DIR = path.resolve(process.env.DOCUMENTS_DIR || path.join(PROJECT_ROOT, "storage", "documentos"));
const AUDIT_FILE = path.resolve(process.env.AUDIT_FILE || path.join(PROJECT_ROOT, "storage", "audit.log"));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const API_TOKEN = process.env.API_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
const STORES = ["incoming", "outgoing", "people", "settings"];
const PRIORITIES = new Set(["Normal", "Alta", "Urgente"]);
const INCOMING_STATUSES = new Set(["Pendiente de asignacion", "En revision", "Asignado", "Respondido"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

if (!fs.existsSync(DOCUMENTS_DIR)) {
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

const auditDir = path.dirname(AUDIT_FILE);
if (!fs.existsSync(auditDir)) {
  fs.mkdirSync(auditDir, { recursive: true });
}

const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function databaseUrlConfig(value) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || process.env.PGPASSWORD || ""),
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  };
}

function postgresConfig() {
  if (process.env.DATABASE_URL) {
    return databaseUrlConfig(process.env.DATABASE_URL);
  }
  if (!process.env.PGDATABASE && !process.env.PGHOST && !process.env.PGUSER) return null;
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "oficios",
    user: process.env.PGUSER || "postgres",
    password: String(process.env.PGPASSWORD || ""),
  };
}

const pgConfig = postgresConfig();
const pgPool = pgConfig ? new Pool(pgConfig) : null;

function initialData() {
  return {
    incoming: [],
    outgoing: [],
    people: [],
    settings: [{ id: "main", nextNumber: 1, directorEmail: "dir.planeacionydu@gmail.com", adminDeleteKey: "" }],
  };
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) return initialData();
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return { ...initialData(), ...data };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function uuidOrNew(value) {
  return UUID_PATTERN.test(String(value || "")) ? value : crypto.randomUUID();
}

function optionalUuid(value) {
  return UUID_PATTERN.test(String(value || "")) ? value : null;
}

function documentToApp(pathValue, nameValue) {
  if (!pathValue) return null;
  return {
    name: nameValue || "documento",
    path: pathValue,
    url: pathValue,
  };
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dateTime(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
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
    id: uuidOrNew(person.id),
    nombre: person.name,
    cargo: person.role,
    correo: person.email || null,
    telefono: person.phone || null,
  };
}

function incomingToApp(row, people = []) {
  const person = people.find((item) => item.id === row.asignado_a);
  const assignees = person ? [person.name] : [];
  return {
    id: row.id,
    folio: row.folio,
    receivedAt: dateOnly(row.fecha_recepcion),
    sender: row.remitente,
    subject: row.asunto,
    priority: row.prioridad || "Normal",
    status: row.estado || "Pendiente de asignacion",
    notes: row.observaciones || "",
    document: documentToApp(row.documento_url, row.documento_nombre),
    responseText: row.respuesta || "",
    responseAt: dateOnly(row.fecha_respuesta),
    responseDocument: documentToApp(row.respuesta_documento_url, row.respuesta_documento_nombre),
    assignee: person?.name || "",
    assignees,
    assigneeId: row.asignado_a || "",
    assigneeIds: row.asignado_a ? [row.asignado_a] : [],
    dueAt: dateOnly(row.fecha_limite),
    instructions: row.instrucciones || "",
    createdAt: dateTime(row.creado_en),
  };
}

function incomingToDb(item, people = []) {
  const assigneeNames = Array.isArray(item.assignees)
    ? item.assignees
    : String(item.assignee || "").split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  const personFromName = assigneeNames
    .map((name) => people.find((person) => normalizeText(person.nombre) === normalizeText(name)))
    .find(Boolean);
  const assigneeId = item.assigneeIds?.[0] || item.assigneeId || personFromName?.id || null;
  return {
    id: uuidOrNew(item.id),
    folio: item.folio,
    fecha_recepcion: item.receivedAt,
    remitente: item.sender,
    asunto: item.subject,
    prioridad: item.priority || "Normal",
    estado: item.status || "Pendiente de asignacion",
    observaciones: item.notes || null,
    documento_url: item.document?.path || item.document?.url || null,
    documento_nombre: item.document?.name || null,
    respuesta: item.responseText || null,
    fecha_respuesta: item.responseAt || null,
    respuesta_documento_url: item.responseDocument?.path || item.responseDocument?.url || null,
    respuesta_documento_nombre: item.responseDocument?.name || null,
    asignado_a: optionalUuid(assigneeId),
    fecha_limite: item.dueAt || null,
    instrucciones: item.instructions || null,
    creado_en: item.createdAt || new Date().toISOString(),
  };
}

function outgoingToApp(row, people = []) {
  const person = people.find((item) => item.id === row.elaboro);
  return {
    id: row.id,
    number: row.numero,
    fullNumber: row.numero_completo,
    prefix: row.prefijo,
    createdAt: dateOnly(row.fecha),
    recipient: row.destinatario,
    subject: row.asunto,
    author: person?.name || "",
    authorId: row.elaboro || "",
    document: documentToApp(row.documento_url, row.documento_nombre),
  };
}

function outgoingToDb(item) {
  return {
    id: uuidOrNew(item.id),
    numero: Number(item.number),
    numero_completo: item.fullNumber,
    prefijo: item.prefix || "DPDU",
    fecha: item.createdAt,
    destinatario: item.recipient,
    asunto: item.subject,
    elaboro: optionalUuid(item.authorId),
    documento_url: item.document?.path || item.document?.url || null,
    documento_nombre: item.document?.name || null,
  };
}

function settingsToApp(row) {
  return {
    id: row.id,
    nextNumber: row.siguiente_numero,
    directorEmail: row.correo_director,
    directorPhone: row.telefono_director || "",
    adminDeleteKey: "",
    notifyEmail: row.notificar_correo ?? true,
    notifyWhatsapp: row.notificar_whatsapp ?? false,
    notifySystem: row.notificar_sistema ?? true,
  };
}

function settingsToDb(settings) {
  return {
    id: settings.id || "main",
    siguiente_numero: Number(settings.nextNumber) || 1,
    correo_director: settings.directorEmail || "dir.planeacionydu@gmail.com",
    telefono_director: settings.directorPhone || null,
    clave_borrado: settings.adminDeleteKey || null,
    notificar_correo: Boolean(settings.notifyEmail),
    notificar_whatsapp: Boolean(settings.notifyWhatsapp),
    notificar_sistema: Boolean(settings.notifySystem),
  };
}

async function getPeopleRows(client = pgPool) {
  const { rows } = await client.query("select * from personal order by nombre");
  return rows;
}

async function readPostgresStore(store) {
  if (store === "people") {
    const rows = await getPeopleRows();
    return rows.map(personToApp);
  }
  if (store === "settings") {
    const { rows } = await pgPool.query("select * from configuracion order by id");
    return rows.map(settingsToApp);
  }
  if (store === "incoming") {
    const people = await getPeopleRows();
    const { rows } = await pgPool.query("select * from oficios_recibidos order by creado_en desc");
    return rows.map((row) => incomingToApp(row, people));
  }
  if (store === "outgoing") {
    const people = await getPeopleRows();
    const { rows } = await pgPool.query("select * from oficios_generados order by numero desc");
    return rows.map((row) => outgoingToApp(row, people));
  }
  return [];
}

async function putPostgresStore(store, value) {
  if (store === "people") {
    const payload = personToDb(value);
    const { rows } = await pgPool.query(
      `insert into personal (id, nombre, cargo, correo, telefono)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set
         nombre = excluded.nombre,
         cargo = excluded.cargo,
         correo = excluded.correo,
         telefono = excluded.telefono
       returning *`,
      [payload.id, payload.nombre, payload.cargo, payload.correo, payload.telefono],
    );
    return personToApp(rows[0]);
  }

  if (store === "settings") {
    const payload = settingsToDb(value);
    const { rows } = await pgPool.query(
      `insert into configuracion (
         id, siguiente_numero, correo_director, telefono_director, clave_borrado,
         notificar_correo, notificar_whatsapp, notificar_sistema
       )
       values ($1, $2, $3, $4, coalesce($5, 'deshabilitada'), $6, $7, $8)
       on conflict (id) do update set
         siguiente_numero = excluded.siguiente_numero,
         correo_director = excluded.correo_director,
         telefono_director = excluded.telefono_director,
         clave_borrado = coalesce(excluded.clave_borrado, configuracion.clave_borrado),
         notificar_correo = excluded.notificar_correo,
         notificar_whatsapp = excluded.notificar_whatsapp,
         notificar_sistema = excluded.notificar_sistema
       returning *`,
      [
        payload.id,
        payload.siguiente_numero,
        payload.correo_director,
        payload.telefono_director,
        payload.clave_borrado,
        payload.notificar_correo,
        payload.notificar_whatsapp,
        payload.notificar_sistema,
      ],
    );
    return settingsToApp(rows[0]);
  }

  if (store === "incoming") {
    const people = await getPeopleRows();
    const payload = incomingToDb(value, people);
    const { rows } = await pgPool.query(
      `insert into oficios_recibidos (
         id, folio, fecha_recepcion, remitente, asunto, prioridad, estado,
         observaciones, documento_url, documento_nombre, respuesta, fecha_respuesta,
         respuesta_documento_url, respuesta_documento_nombre, asignado_a, fecha_limite,
         instrucciones, creado_en
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       on conflict (id) do update set
         folio = excluded.folio,
         fecha_recepcion = excluded.fecha_recepcion,
         remitente = excluded.remitente,
         asunto = excluded.asunto,
         prioridad = excluded.prioridad,
         estado = excluded.estado,
         observaciones = excluded.observaciones,
         documento_url = excluded.documento_url,
         documento_nombre = excluded.documento_nombre,
         respuesta = excluded.respuesta,
         fecha_respuesta = excluded.fecha_respuesta,
         respuesta_documento_url = excluded.respuesta_documento_url,
         respuesta_documento_nombre = excluded.respuesta_documento_nombre,
         asignado_a = excluded.asignado_a,
         fecha_limite = excluded.fecha_limite,
         instrucciones = excluded.instrucciones
       returning *`,
      [
        payload.id,
        payload.folio,
        payload.fecha_recepcion,
        payload.remitente,
        payload.asunto,
        payload.prioridad,
        payload.estado,
        payload.observaciones,
        payload.documento_url,
        payload.documento_nombre,
        payload.respuesta,
        payload.fecha_respuesta,
        payload.respuesta_documento_url,
        payload.respuesta_documento_nombre,
        payload.asignado_a,
        payload.fecha_limite,
        payload.instrucciones,
        payload.creado_en,
      ],
    );
    return incomingToApp(rows[0], people);
  }

  if (store === "outgoing") {
    const payload = outgoingToDb(value);
    const { rows } = await pgPool.query(
      `insert into oficios_generados (
         id, numero, numero_completo, prefijo, fecha, destinatario, asunto,
         elaboro, documento_url, documento_nombre
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set
         numero = excluded.numero,
         numero_completo = excluded.numero_completo,
         prefijo = excluded.prefijo,
         fecha = excluded.fecha,
         destinatario = excluded.destinatario,
         asunto = excluded.asunto,
         elaboro = excluded.elaboro,
         documento_url = excluded.documento_url,
         documento_nombre = excluded.documento_nombre
       returning *`,
      [
        payload.id,
        payload.numero,
        payload.numero_completo,
        payload.prefijo,
        payload.fecha,
        payload.destinatario,
        payload.asunto,
        payload.elaboro,
        payload.documento_url,
        payload.documento_nombre,
      ],
    );
    const people = await getPeopleRows();
    return outgoingToApp(rows[0], people);
  }

  throw new Error("Almacen no soportado");
}

async function deletePostgresStore(store, id) {
  const tables = {
    people: "personal",
    incoming: "oficios_recibidos",
    outgoing: "oficios_generados",
    settings: "configuracion",
  };
  await pgPool.query(`delete from ${tables[store]} where id = $1`, [id]);
}

function isInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeFilename(value) {
  return String(value || "documento")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "documento";
}

function uniqueFilePath(folder, ownerId, originalName) {
  const extension = path.extname(originalName);
  const baseName = safeFilename(`${safeFilename(ownerId)}-${path.basename(originalName, extension)}`).slice(0, 100);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const filename = `${baseName}${suffix}${extension}`;
    const filePath = path.join(folder, filename);
    if (!fs.existsSync(filePath)) return { filename, filePath };
  }
  const filename = `${baseName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
  return { filename, filePath: path.join(folder, filename) };
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseZip(buffer) {
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Plantilla DOCX invalida");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Plantilla DOCX invalida");
    const method = buffer.readUInt16LE(offset + 10);
    const flags = buffer.readUInt16LE(offset + 8);
    const modifiedTime = buffer.readUInt16LE(offset + 12);
    const modifiedDate = buffer.readUInt16LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Plantilla DOCX invalida");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(compressedData) : compressedData;
    if (data.length !== uncompressedSize) throw new Error("Plantilla DOCX invalida");

    entries.push({
      name,
      flags,
      method,
      modifiedTime,
      modifiedDate,
      externalAttributes,
      data,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function writeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(entry.modifiedTime || 0, 10);
    local.writeUInt16LE(entry.modifiedDate || 0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(entry.modifiedTime || 0, 12);
    central.writeUInt16LE(entry.modifiedDate || 0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function docxParagraph(text, options = {}) {
  const align = options.align ? `<w:jc w:val="${options.align}"/>` : "";
  const spacing = options.spacingAfter === 0 ? '<w:spacing w:after="0"/>' : "";
  const bold = options.bold ? "<w:b/>" : "";
  const size = options.size || 22;
  return `<w:p><w:pPr>${align}${spacing}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${bold}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function docxHeaderParagraph(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Encabezado"/><w:rPr><w:rFonts w:ascii="Galatea" w:hAnsi="Galatea"/><w:noProof/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Galatea" w:hAnsi="Galatea"/><w:noProof/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function formatTemplateNumber(item) {
  if (item.fullNumber) return String(item.fullNumber);
  const year = new Date(`${item.createdAt || new Date().toISOString().slice(0, 10)}T00:00:00`).getFullYear();
  if (item.prefix && item.number) return `${item.prefix}-${String(item.number).padStart(3, "0")}/${year}`;
  return "";
}

function replaceHeaderValue(xml, label, value) {
  const safeLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(<w:t>${safeLabel}</w:t>[\\s\\S]*?</w:tc>\\s*<w:tc>)([\\s\\S]*?)(</w:tc>)`);
  return xml.replace(pattern, (_, start, content, end) => {
    const tcPr = content.match(/<w:tcPr[\s\S]*?<\/w:tcPr>/)?.[0] || "";
    return `${start}${tcPr}${docxHeaderParagraph(value)}${end}`;
  });
}

function outgoingWordDocumentXml(templateXml, item) {
  const createdAt = item.createdAt || new Date().toISOString().slice(0, 10);
  const body = [
    docxParagraph(`Rincon de Romos, Ags., a ${createdAt}`, { align: "right" }),
    docxParagraph(""),
    docxParagraph(String(item.recipient || "").toUpperCase(), { bold: true }),
    docxParagraph("PRESENTE", { bold: true }),
    docxParagraph(""),
    docxParagraph("Por medio del presente, me permito comunicarle lo siguiente:"),
    docxParagraph(""),
    docxParagraph(""),
    docxParagraph("Sin otro particular, reciba un cordial saludo."),
    docxParagraph(""),
    docxParagraph("ATENTAMENTE", { align: "center", bold: true }),
    docxParagraph(""),
    docxParagraph(""),
    docxParagraph(item.author || "", { align: "center", bold: true }),
  ].join("");
  return templateXml.replace(/(<w:sectPr[\s\S]*?<\/w:sectPr>)/, `${body}$1`);
}

function generateOutgoingDocx(item) {
  const templateFile = WORD_TEMPLATE_FILES.find((file) => fs.existsSync(file));
  if (!templateFile) {
    throw new Error("No se encontro la plantilla OficioMembretado.docx");
  }
  const entries = parseZip(fs.readFileSync(templateFile));
  const number = formatTemplateNumber(item);

  entries.forEach((entry) => {
    if (entry.name === "word/header1.xml") {
      let xml = entry.data.toString("utf8");
      xml = replaceHeaderValue(xml, "No. de Oficio:", number);
      xml = replaceHeaderValue(xml, "Asunto:", item.subject || "");
      entry.data = Buffer.from(xml, "utf8");
    }
    if (entry.name === "word/document.xml") {
      entry.data = Buffer.from(outgoingWordDocumentXml(entry.data.toString("utf8"), item), "utf8");
    }
  });

  return writeZip(entries);
}

function storeDocument(record) {
  if (!record.document?.dataUrl) return record;
  const stored = saveDocumentFile({
    document: record.document,
    ownerId: record.documentOwnerName || record.id,
    folderName: record.documentFolder || "recibidos",
  });

  return {
    ...record,
    documentFolder: undefined,
    documentOwnerName: undefined,
    document: stored,
  };
}

function storeResponseDocument(record) {
  if (!record.responseDocument?.dataUrl) return record;
  const stored = saveDocumentFile({
    document: record.responseDocument,
    ownerId: record.id,
    folderName: "respuestas",
  });

  return {
    ...record,
    responseDocument: stored,
  };
}

function saveDocumentFile({ document, ownerId, folderName }) {
  if (!document?.dataUrl) throw new Error("Documento invalido");
  const match = /^data:([^;]+);base64,(.+)$/.exec(document.dataUrl);
  if (!match) throw new Error("Documento invalido");
  const type = match[1];
  if (!ALLOWED_DOCUMENT_TYPES.has(type)) {
    throw new Error("Tipo de documento no permitido. Usa PDF, Word, JPG, PNG o WebP");
  }
  const base64 = match[2];
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("Archivo demasiado grande");
  }
  const year = String(new Date().getFullYear());
  const safeFolder = safeFilename(folderName || "documentos");
  const folder = path.join(DOCUMENTS_DIR, safeFolder, year);
  fs.mkdirSync(folder, { recursive: true });

  const originalName = safeFilename(document.name);
  const { filename, filePath } = uniqueFilePath(folder, ownerId, originalName);
  fs.writeFileSync(filePath, buffer);
  const publicPath = `/documentos/${encodeURIComponent(safeFolder)}/${year}/${encodeURIComponent(filename)}`;

  return {
    name: document.name,
    type,
    size: document.size,
    path: publicPath,
    url: `${PUBLIC_BASE_URL}${publicPath}`,
  };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Delete-Key",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_UPLOAD_BYTES) {
        req.destroy();
        reject(new Error("Archivo demasiado grande"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) throw httpError(400, "El cuerpo JSON es requerido");
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "JSON invalido");
  }
}

function isApiAuthorized(req) {
  if (!API_TOKEN) return true;
  const authorization = req.headers.authorization || "";
  return authorization === `Bearer ${API_TOKEN}`;
}

function secureCompare(value, expected) {
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(String(expected || ""));
  if (!left.length || !right.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function configuredDeleteKey() {
  if (process.env.DELETE_PASSWORD) return process.env.DELETE_PASSWORD;
  if (pgPool) {
    const { rows } = await pgPool.query("select clave_borrado from configuracion where id = $1", ["main"]);
    return rows[0]?.clave_borrado || "";
  }
  return readData().settings?.find((item) => item.id === "main")?.adminDeleteKey || "";
}

async function assertDeleteAuthorized(req) {
  const expected = await configuredDeleteKey();
  if (!expected || expected === "deshabilitada") {
    throw httpError(403, "Configura una contrasena de borrado antes de eliminar registros");
  }
  if (!secureCompare(req.headers["x-delete-key"], expected)) {
    throw httpError(403, "Contrasena de borrado incorrecta");
  }
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, `El campo ${field} es requerido`);
  return text;
}

function requiredDate(value, field) {
  const text = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00`).getTime())) {
    throw httpError(400, `El campo ${field} debe tener formato YYYY-MM-DD`);
  }
  return text;
}

function normalizeOutgoingRecord(record) {
  const prefix = requiredText(record.prefix || "DPDU", "prefix").toUpperCase();
  return {
    ...record,
    prefix,
    createdAt: requiredDate(record.createdAt, "createdAt"),
    recipient: requiredText(record.recipient, "recipient"),
    subject: requiredText(record.subject, "subject"),
    author: String(record.author || "").trim(),
  };
}

function normalizeIncomingRecord(record) {
  const priority = record.priority || "Normal";
  const status = record.status || "Pendiente de asignacion";
  if (!PRIORITIES.has(priority)) throw httpError(400, "Prioridad no permitida");
  if (!INCOMING_STATUSES.has(status)) throw httpError(400, "Estado no permitido");
  return {
    ...record,
    folio: requiredText(record.folio, "folio"),
    receivedAt: requiredDate(record.receivedAt, "receivedAt"),
    sender: requiredText(record.sender, "sender"),
    subject: requiredText(record.subject, "subject"),
    priority,
    status,
    dueAt: record.dueAt ? requiredDate(record.dueAt, "dueAt") : "",
    responseAt: record.responseAt ? requiredDate(record.responseAt, "responseAt") : "",
  };
}

function normalizePersonRecord(record) {
  return {
    ...record,
    name: requiredText(record.name, "name"),
    role: requiredText(record.role, "role"),
    email: String(record.email || "").trim(),
    phone: String(record.phone || "").trim(),
  };
}

function normalizeSettingsRecord(record) {
  return {
    ...record,
    id: record.id || "main",
    nextNumber: Number(record.nextNumber) || 1,
    directorEmail: requiredText(record.directorEmail, "directorEmail"),
    directorPhone: String(record.directorPhone || "").trim(),
  };
}

function normalizeStoreRecord(store, record) {
  if (store === "incoming") return normalizeIncomingRecord(record);
  if (store === "outgoing") return normalizeOutgoingRecord(record);
  if (store === "people") return normalizePersonRecord(record);
  if (store === "settings") return normalizeSettingsRecord(record);
  return record;
}

function auditSummary(store, record = {}) {
  if (store === "incoming") return { folio: record.folio, sender: record.sender, status: record.status };
  if (store === "outgoing") return { fullNumber: record.fullNumber, recipient: record.recipient, prefix: record.prefix };
  if (store === "people") return { name: record.name, role: record.role };
  if (store === "settings") return { id: record.id || "main" };
  return {};
}

function appendAudit(req, action, store, id, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    action,
    store,
    id,
    ip: req.socket.remoteAddress || "",
    userAgent: req.headers["user-agent"] || "",
    details,
  };
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
}

async function createPostgresOutgoing(record) {
  const payload = normalizeOutgoingRecord(record);
  const authorId = optionalUuid(payload.authorId);
  const { rows } = await pgPool.query(
    "select * from generar_oficio_local($1, $2, $3, $4, $5)",
    [payload.prefix, payload.createdAt, payload.recipient, payload.subject, authorId],
  );
  let saved = outgoingToApp(rows[0], await getPeopleRows());
  if (payload.document?.dataUrl) {
    const withDocument = storeDocument({
      ...saved,
      document: payload.document,
      documentFolder: "expedidos",
      documentOwnerName: saved.fullNumber || saved.id,
    });
    saved = await putPostgresStore("outgoing", withDocument);
  }
  return saved;
}

function nextJsonOutgoingNumber(outgoing, prefix, dateValue) {
  const year = new Date(`${dateValue}T00:00:00`).getFullYear();
  const numbers = outgoing
    .filter((item) => (item.prefix || "DPDU").toUpperCase() === prefix)
    .filter((item) => new Date(`${item.createdAt || dateValue}T00:00:00`).getFullYear() === year)
    .map((item) => Number(item.number) || 0);
  return Math.max(0, ...numbers) + 1;
}

async function createOutgoing(record) {
  if (pgPool) return createPostgresOutgoing(record);
  const payload = normalizeOutgoingRecord(record);
  const data = readData();
  const number = nextJsonOutgoingNumber(data.outgoing, payload.prefix, payload.createdAt);
  const year = new Date(`${payload.createdAt}T00:00:00`).getFullYear();
  let saved = {
    ...payload,
    id: uuidOrNew(payload.id),
    number,
    fullNumber: `${payload.prefix}-${String(number).padStart(3, "0")}/${year}`,
  };
  saved = storeDocument({
    ...saved,
    documentFolder: "expedidos",
    documentOwnerName: saved.fullNumber || saved.id,
  });
  data.outgoing.push(saved);
  writeData(data);
  return saved;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  if (url.pathname === "/api/health") {
    if (pgPool) await pgPool.query("select 1");
    send(res, 200, JSON.stringify({ ok: true, storage: pgPool ? "postgresql" : "json", authConfigured: Boolean(API_TOKEN) }));
    return;
  }

  if (!isApiAuthorized(req)) {
    send(res, 401, JSON.stringify({ error: "No autorizado" }));
    return;
  }

  if (url.pathname === "/api/documents" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const stored = saveDocumentFile(payload);
    if (!PUBLIC_BASE_URL) stored.url = `${url.origin}${stored.path}`;
    send(res, 200, JSON.stringify(stored));
    return;
  }

  if (parts[0] === "api" && parts[1] === "outgoing-word" && parts[2] && req.method === "GET") {
    const templateFile = WORD_TEMPLATE_FILES.find((file) => fs.existsSync(file));
    if (!templateFile) {
      send(res, 404, JSON.stringify({ error: "No se encontro la plantilla OficioMembretado.docx" }));
      return;
    }
    const outgoing = pgPool ? await readPostgresStore("outgoing") : readData().outgoing;
    const item = outgoing.find((row) => row.id === decodeURIComponent(parts[2]));
    if (!item) {
      send(res, 404, JSON.stringify({ error: "Oficio no encontrado" }));
      return;
    }
    const filename = `${safeFilename(item?.fullNumber || "OficioMembretado")}.docx`;
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    });
    res.end(generateOutgoingDocx(item));
    return;
  }

  const store = parts[1];
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;
  if (parts[0] !== "api" || !STORES.includes(store)) {
    send(res, 404, JSON.stringify({ error: "Ruta no encontrada" }));
    return;
  }

  if (req.method === "GET" && !id) {
    const records = pgPool ? await readPostgresStore(store) : readData()[store];
    send(res, 200, JSON.stringify(records));
    return;
  }

  if (req.method === "POST" && store === "outgoing" && !id) {
    const saved = await createOutgoing(await readJsonBody(req));
    appendAudit(req, "create", store, saved.id, auditSummary(store, saved));
    send(res, 201, JSON.stringify(saved));
    return;
  }

  if (req.method === "PUT" && id) {
    let record = normalizeStoreRecord(store, await readJsonBody(req));
    record.id = id;
    if (store === "incoming") {
      record = storeDocument(record);
      record = storeResponseDocument(record);
    }
    if (store === "outgoing") {
      record = storeDocument({
        ...record,
        documentFolder: "expedidos",
        documentOwnerName: record.fullNumber || record.id,
      });
    }
    if (pgPool) {
      const saved = await putPostgresStore(store, record);
      appendAudit(req, "upsert", store, id, auditSummary(store, saved));
      send(res, 200, JSON.stringify(saved));
      return;
    }
    const data = readData();
    if (store === "settings" && !record.adminDeleteKey) {
      const currentSettings = data.settings.find((item) => item.id === id);
      record.adminDeleteKey = currentSettings?.adminDeleteKey || "";
    }
    const index = data[store].findIndex((item) => item.id === id);
    if (index >= 0) data[store][index] = record;
    else data[store].push(record);
    writeData(data);
    appendAudit(req, "upsert", store, id, auditSummary(store, record));
    send(res, 200, JSON.stringify(record));
    return;
  }

  if (req.method === "DELETE" && id) {
    await assertDeleteAuthorized(req);
    if (pgPool) {
      await deletePostgresStore(store, id);
      appendAudit(req, "delete", store, id);
      send(res, 204, "");
      return;
    }
    const data = readData();
    data[store] = data[store].filter((item) => item.id !== id);
    writeData(data);
    appendAudit(req, "delete", store, id);
    send(res, 204, "");
    return;
  }

  send(res, 405, JSON.stringify({ error: "Metodo no permitido" }));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!isInside(PUBLIC_DIR, filePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "No encontrado", "text/plain; charset=utf-8");
    return;
  }

  const ext = path.extname(filePath);
  const headers = {
    "Content-Type": mime[ext] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  };
  if ([".html", ".js", ".css", ".webmanifest"].includes(ext)) {
    headers["Cache-Control"] = "no-cache";
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function serveDocument(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/documentos\/?/, ""));
  const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(DOCUMENTS_DIR, safePath);

  if (!isInside(DOCUMENTS_DIR, filePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "Documento no encontrado", "text/plain; charset=utf-8");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": mime[ext] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "private, max-age=3600",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => {
      const statusCode = error.statusCode || 500;
      send(res, statusCode, JSON.stringify({ error: error.message }));
    });
    return;
  }
  if (req.url.startsWith("/documentos/")) {
    serveDocument(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}/`);
  console.log(`Control de Oficios listo en http://localhost:${PORT}/`);
  if (lanAddresses.length) {
    console.log("En otros equipos de la red:");
    lanAddresses.forEach((address) => console.log(`  ${address}`));
  } else {
    console.log("No se detecto una IP de red local. Revisa la conexion de red.");
  }
});
