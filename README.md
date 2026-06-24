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
