const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "data", "migrations");

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

function connectionConfig() {
  if (process.env.DATABASE_URL) {
    const config = databaseUrlConfig(process.env.DATABASE_URL);
    if (!config.password && process.env.PGALLOW_EMPTY_PASSWORD !== "true") {
      throw new Error("DATABASE_URL no incluye contrasena. Agregala en .env o usa PGALLOW_EMPTY_PASSWORD=true si tu PostgreSQL local no requiere contrasena.");
    }
    return config;
  }
  const hasSeparateConfig = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].some((key) => process.env[key]);
  if (!hasSeparateConfig) {
    throw new Error("No encontre configuracion PostgreSQL. Copia .env.example a .env y cambia TU_PASSWORD por tu contrasena real.");
  }
  if (!process.env.PGPASSWORD && process.env.PGALLOW_EMPTY_PASSWORD !== "true") {
    throw new Error("Falta PGPASSWORD en .env. Agrega tu contrasena o usa PGALLOW_EMPTY_PASSWORD=true si tu PostgreSQL local no requiere contrasena.");
  }
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "oficios",
    user: process.env.PGUSER || "postgres",
    password: String(process.env.PGPASSWORD || ""),
  };
}

async function main() {
  loadEnvFile();
  const client = new Client(connectionConfig());
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await client.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Aplicando ${file}...`);
      await client.query(sql);
    }
    console.log("Migraciones completadas.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`No se pudo migrar PostgreSQL: ${error.message}`);
  process.exit(1);
});
