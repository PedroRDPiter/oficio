const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "public", "supabase-config.js");

const config = `export const SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || "")};
export const SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || "")};
export const SUPABASE_DOCUMENT_BUCKET = ${JSON.stringify(process.env.SUPABASE_DOCUMENT_BUCKET || "documentos")};
`;

fs.writeFileSync(configPath, config);
console.log("Supabase config generated.");
