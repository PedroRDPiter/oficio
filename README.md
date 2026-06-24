# Control de Oficios DPDU

PWA para recibir oficios, adjuntar escaneos, avisar al director, asignar responsables y controlar numeros consecutivos.

## Estructura

```txt
public/                 Archivos de la PWA servidos al navegador
  index.html
  app.js
  styles.css
  manifest.webmanifest
  sw.js
  icon.svg
src/server/             Servidor Node.js y API
  server.js
data/                   Base local JSON
  oficios-data.json
storage/documentos/     Escaneos y PDFs subidos
scripts/                Utilidades para Windows
  iniciar-servidor.bat
```

## Ejecutar local

```bash
npm start
```

Tambien puedes usar `scripts/iniciar-servidor.bat` en Windows.

## Variables de entorno

- `PORT`: puerto del servidor. En nube normalmente lo define el proveedor.
- `HOST`: usa `0.0.0.0` para aceptar conexiones externas.
- `DATA_FILE`: ruta del archivo JSON de datos. Por defecto `data/oficios-data.json`.
- `DOCUMENTS_DIR`: carpeta donde se guardan los documentos escaneados. Por defecto `storage/documentos`.
- `MAX_UPLOAD_BYTES`: limite de subida. Por defecto 25 MB.

## Nube

Esta version usa archivo JSON y carpeta de documentos. En proveedores con disco temporal, configura un disco persistente para `DATA_FILE` y `DOCUMENTS_DIR`, o migra la base a PostgreSQL/Supabase y documentos a un storage.

Comando de inicio:

```bash
npm start
```

Comando de verificacion:

```bash
npm run check
```

## Render con disco persistente

El archivo `render.yaml` deja preparado un servicio web con disco persistente en `/var/data`.

Variables recomendadas:

- `DATA_FILE=/var/data/oficios-data.json`
- `DOCUMENTS_DIR=/var/data/documentos`
- `HOST=0.0.0.0`
- `MAX_UPLOAD_BYTES=26214400`

Los escaneos se sirven desde `/documentos/...`, pero se guardan fisicamente en `DOCUMENTS_DIR`.

## Supabase + Netlify

Para usar la app sin servidor Node en Netlify:

1. Ejecuta `data/query.sql` en el SQL Editor de Supabase si aun no creaste las tablas.
2. Ejecuta `data/supabase-produccion.sql` para habilitar autenticacion, RLS, roles y consecutivos seguros.
3. Crea el bucket `documentos` en Supabase Storage.
4. Deja el bucket `documentos` como privado.
5. En Netlify configura estas variables de entorno:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_DOCUMENT_BUCKET`
6. Netlify ejecutara `node scripts/create-supabase-config.js` y publicara la carpeta `public/`.

Mientras Supabase este configurado, la PWA guarda en la nube. Si no esta configurado, conserva el modo local/servidor como respaldo.

Despues de crear usuarios en Supabase Auth, registra su rol en la tabla `perfiles`.
Roles admitidos:

- `admin`
- `director`
- `ventanilla`
- `responsable`
