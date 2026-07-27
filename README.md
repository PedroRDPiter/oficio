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
data/                   Migraciones SQL y base JSON de respaldo
  migrations/
  oficios-data.json
storage/documentos/     Escaneos y PDFs subidos
scripts/                Utilidades para Windows
  iniciar-servidor.bat
  iniciar-cloud.bat
```

## Ejecutar local

```bash
npm start
```

Tambien puedes usar `scripts/iniciar-servidor.bat` en Windows.

## PostgreSQL Local

Esta version puede guardar en PostgreSQL local. Si no configuras PostgreSQL, el servidor conserva el respaldo en `data/oficios-data.json`.

1. Instala dependencias:

```bash
npm install
```

2. Crea la base de datos en PostgreSQL. Si `psql` no esta en tu PATH, usa la ruta completa:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres oficios
```

Si la base ya existe, este paso puede marcar error y puedes continuar.

3. Copia `.env.example` a `.env` y ajusta la contrasena:

```txt
DATABASE_URL=postgresql://postgres:TU_PASSWORD@localhost:5432/oficios
PORT=3344
HOST=0.0.0.0
PUBLIC_BASE_URL=http://localhost:3344
```

4. Ejecuta la migracion:

```bash
npm run db:migrate
```

5. Abre el servidor local:

```bash
npm start
```

En esta PC abre `http://localhost:3344/`. En otros equipos de la misma red usa la IP que imprime el servidor, por ejemplo `http://192.168.1.50:3344/`.

## Variables de entorno

- `PORT`: puerto del servidor. En nube normalmente lo define el proveedor.
- `HOST`: usa `0.0.0.0` para aceptar conexiones externas.
- `DATA_FILE`: ruta del archivo JSON de datos. Por defecto `data/oficios-data.json`.
- `DOCUMENTS_DIR`: carpeta donde se guardan los documentos escaneados. Por defecto `storage/documentos`.
- `MAX_UPLOAD_BYTES`: limite de subida. Por defecto 25 MB.
- `PUBLIC_BASE_URL`: URL desde donde otros equipos descargan documentos del servidor local.
- `ALLOWED_ORIGIN`: origen permitido para subir documentos desde Netlify. Puede ser tu URL `https://sitio.netlify.app`.
- `CLOUDFLARE_TUNNEL_TOKEN`: token opcional de un tunel administrado para publicar la app con una URL estable.
- `DATABASE_URL`: conexion a PostgreSQL local, por ejemplo `postgresql://postgres:password@localhost:5432/oficios`.
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`: alternativa a `DATABASE_URL`.

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

## Acceso Fuera De La Red Local Por Mas De 48 Horas

Para que el sistema se pueda abrir desde equipos fuera de la red local y dure mas de 48 horas, usa un despliegue permanente en la nube. No uses enlaces temporales de ngrok, LocalTunnel o tuneles rapidos para operacion diaria, porque pueden cambiar, vencer o caerse cuando se cierre la sesion.

La opcion mas directa para este proyecto es Render con disco persistente:

1. Sube este repositorio a GitHub.
2. En Render crea un servicio desde `render.yaml` usando la opcion **Blueprint**.
3. Verifica que el servicio tenga disco persistente montado en `/var/data`.
4. Configura estas variables:

```txt
HOST=0.0.0.0
DATA_FILE=/var/data/oficios-data.json
DOCUMENTS_DIR=/var/data/documentos
MAX_UPLOAD_BYTES=26214400
PUBLIC_BASE_URL=https://TU-SERVICIO.onrender.com
ALLOWED_ORIGIN=https://TU-SERVICIO.onrender.com
API_TOKEN=UN_TOKEN_LARGO_Y_PRIVADO
```

5. Despliega el servicio y abre:

```txt
https://TU-SERVICIO.onrender.com/
```

6. En la app, cuando pida token de API local, usa el mismo valor configurado en `API_TOKEN`.

## Acceso HTTPS Desde Otras Redes Con Cloudflare

En Windows ejecuta:

```txt
scripts\iniciar-cloud.bat
```

El script inicia el servidor y Cloudflare Tunnel, espera a que ambos respondan y muestra:

- La URL publica HTTPS para abrir la app desde cualquier red.
- El token de acceso que deben capturar los dispositivos autorizados.

Si `cloudflared` no esta instalado, el script descarga el ejecutable oficial en `storage/tools/`.
Sin configuracion adicional crea un Quick Tunnel temporal; su URL cambia cada vez que se reinicia y solo debe usarse para pruebas.
Puedes comprobar la configuracion sin dejar procesos abiertos con `scripts\iniciar-cloud.bat -Check`.

Para una demostracion temporal sin solicitar token, usa `scripts\iniciar-presentacion.bat`. Este modo deja la API sin autenticacion mientras el tunel este activo; no debe utilizarse para operacion diaria ni compartirse fuera de la presentacion.
Si Cloudflare no puede generar temporalmente una URL, `scripts\iniciar-presentacion-local.bat` permite abrir la demostracion sin token desde la misma red, aunque ese acceso HTTP no permite instalar la PWA.

Para una URL estable y una PWA instalada que siga funcionando despues de reiniciar:

1. Crea un tunel administrado en Cloudflare y asignale un dominio HTTPS.
2. Agrega a `.env`:

```txt
PUBLIC_BASE_URL=https://oficios.tu-dominio.mx
ALLOWED_ORIGIN=https://oficios.tu-dominio.mx
CLOUDFLARE_TUNNEL_TOKEN=TOKEN_DEL_TUNEL
API_TOKEN=UN_TOKEN_LARGO_Y_PRIVADO
```

3. Ejecuta nuevamente `scripts\iniciar-cloud.bat`.

Para instalarla en el dispositivo, abre la URL HTTPS y pulsa **Instalar app**. En iPhone o iPad, si el navegador no muestra el dialogo automatico, usa **Compartir > Agregar a pantalla de inicio**.

Si se usara Netlify + Supabase, la app tambien puede durar mas de 48 horas, pero requiere configurar Supabase Auth, tablas, roles y storage. Esa ruta es mejor cuando se necesitan usuarios con permisos por rol.

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
   - `LOCAL_DOCUMENT_SERVER_URL`
6. Netlify ejecutara `node scripts/create-supabase-config.js` y publicara la carpeta `public/`.

Mientras Supabase este configurado, la PWA guarda en la nube. Si no esta configurado, conserva el modo local/servidor como respaldo.

Despues de crear usuarios en Supabase Auth, registra su rol en la tabla `perfiles`.
Roles admitidos:

- `admin`
- `director`
- `ventanilla`
- `responsable`

## Documentos En Equipo Local

Si quieres que Netlify/Supabase guarden solo datos y que los documentos se guarden en esta computadora:

1. Ejecuta `scripts/iniciar-servidor.bat`.
2. Asegurate de que la computadora tenga IP fija o reservada.
3. En Netlify agrega:

```txt
LOCAL_DOCUMENT_SERVER_URL=http://10.1.85.9:3344
```

4. Haz `Clear cache and deploy site`.

Los documentos se guardaran en `storage/documentos/`. Solo podran descargarse si esta computadora esta encendida y accesible desde donde se abra la app.

Para descargar fuera de la red local necesitas VPN o un tunel HTTPS. En ese caso `LOCAL_DOCUMENT_SERVER_URL` y `PUBLIC_BASE_URL` deben usar la URL publica del tunel.

## Autoinicio En Windows

Para que el servidor local arranque cuando prendas la computadora e inicies sesion:

```txt
scripts/instalar-autoinicio.bat
```

Esto crea un acceso directo en la carpeta de Inicio de Windows del usuario actual.

Para quitarlo:

```txt
scripts/quitar-autoinicio.bat
```
