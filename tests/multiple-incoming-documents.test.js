const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oficios-multiple-documents-"));
const port = 4197;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["src/server/server.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATABASE_URL: "",
    PGDATABASE: "",
    PGHOST: "",
    PGUSER: "",
    API_TOKEN: "disabled",
    DATA_FILE: path.join(testRoot, "data.json"),
    DOCUMENTS_DIR: path.join(testRoot, "documents"),
    AUDIT_FILE: path.join(testRoot, "audit.log"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let serverOutput = "";
child.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
child.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`El servidor de prueba no inicio.\n${serverOutput}`);
}

async function run() {
  await waitForServer();
  const id = "9ecaf5c0-2c77-47a7-a962-49a235cc6e82";
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const response = await fetch(`${baseUrl}/api/incoming/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      folio: "PRUEBA-2",
      receivedAt: "2026-07-24",
      sender: "Prueba automatizada",
      subject: "Oficio con dos archivos",
      priority: "Normal",
      status: "Pendiente de asignacion",
      documents: [
        { name: "uno.png", type: "image/png", size: 8, dataUrl },
        { name: "dos.png", type: "image/png", size: 8, dataUrl },
      ],
      createdAt: "2026-07-24T12:00:00.000Z",
    }),
  });
  assert.equal(response.status, 200);

  const saved = await response.json();
  assert.equal(saved.status, "Pendiente de asignacion");
  assert.equal(saved.documents.length, 2);
  assert.deepEqual(saved.documents.map((document) => document.name), ["uno.png", "dos.png"]);
  assert.notEqual(saved.documents[0].path, saved.documents[1].path);
  assert.equal(saved.document.name, "uno.png");

  const firstPaths = saved.documents.map((document) => document.path);
  const appendResponse = await fetch(`${baseUrl}/api/incoming/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...saved,
      documents: [
        ...saved.documents,
        { name: "tres.png", type: "image/png", size: 8, dataUrl },
      ],
    }),
  });
  assert.equal(appendResponse.status, 200);
  const updated = await appendResponse.json();
  assert.equal(updated.documents.length, 3);
  assert.deepEqual(updated.documents.slice(0, 2).map((document) => document.path), firstPaths);
  assert.equal(updated.documents[2].name, "tres.png");

  updated.documents.forEach((document) => {
    const relativePath = document.path
      .replace(/^\/documentos\//, "")
      .split("/")
      .map(decodeURIComponent);
    assert.equal(fs.existsSync(path.join(testRoot, "documents", ...relativePath)), true);
  });
}

run()
  .then(() => {
    console.log("Carga multiple de archivos recibidos: OK");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
