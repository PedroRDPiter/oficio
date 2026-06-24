const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "0.0.0.0";
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(PROJECT_ROOT, "data", "oficios-data.json"));
const DOCUMENTS_DIR = path.resolve(process.env.DOCUMENTS_DIR || path.join(PROJECT_ROOT, "storage", "documentos"));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const API_TOKEN = process.env.API_TOKEN || "";
const STORES = ["incoming", "outgoing", "people", "settings"];
const ALLOWED_DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

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
};

if (!fs.existsSync(DOCUMENTS_DIR)) {
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function initialData() {
  return {
    incoming: [],
    outgoing: [],
    people: [],
    settings: [{ id: "main", nextNumber: 1, directorEmail: "director@municipio.gob.mx" }],
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

function storeDocument(record) {
  if (!record.document?.dataUrl) return record;

  const match = /^data:([^;]+);base64,(.+)$/.exec(record.document.dataUrl);
  if (!match) return record;

  const type = match[1];
  if (!ALLOWED_DOCUMENT_TYPES.has(type)) {
    throw new Error("Tipo de documento no permitido");
  }
  const base64 = match[2];
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("Archivo demasiado grande");
  }
  const folder = path.join(DOCUMENTS_DIR, String(new Date().getFullYear()));
  fs.mkdirSync(folder, { recursive: true });

  const originalName = safeFilename(record.document.name);
  const filename = `${record.id}-${originalName}`;
  const filePath = path.join(folder, filename);
  fs.writeFileSync(filePath, buffer);

  return {
    ...record,
    document: {
      name: record.document.name,
      type,
      size: record.document.size,
      url: `/documentos/${new Date().getFullYear()}/${encodeURIComponent(filename)}`,
    },
  };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
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

function isApiAuthorized(req) {
  if (!API_TOKEN) return true;
  const authorization = req.headers.authorization || "";
  return authorization === `Bearer ${API_TOKEN}`;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/health") {
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }

  if (!isApiAuthorized(req)) {
    send(res, 401, JSON.stringify({ error: "No autorizado" }));
    return;
  }

  const store = parts[1];
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;
  if (parts[0] !== "api" || !STORES.includes(store)) {
    send(res, 404, JSON.stringify({ error: "Ruta no encontrada" }));
    return;
  }

  const data = readData();
  if (req.method === "GET" && !id) {
    send(res, 200, JSON.stringify(data[store]));
    return;
  }

  if (req.method === "PUT" && id) {
    let record = JSON.parse(await readBody(req));
    record.id = id;
    if (store === "incoming") record = storeDocument(record);
    const index = data[store].findIndex((item) => item.id === id);
    if (index >= 0) data[store][index] = record;
    else data[store].push(record);
    writeData(data);
    send(res, 200, JSON.stringify(record));
    return;
  }

  if (req.method === "DELETE" && id) {
    data[store] = data[store].filter((item) => item.id !== id);
    writeData(data);
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
    handleApi(req, res).catch((error) => send(res, 500, JSON.stringify({ error: error.message })));
    return;
  }
  if (req.url.startsWith("/documentos/")) {
    serveDocument(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Control de Oficios listo en http://localhost:${PORT}/`);
  console.log("Para usarlo en telefono, abre la IP de este equipo en la misma red con el mismo puerto.");
});
