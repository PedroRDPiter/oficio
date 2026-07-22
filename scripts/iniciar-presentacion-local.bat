@echo off
setlocal
cd /d "%~dp0.."

set PORT=3344
set HOST=0.0.0.0
set API_TOKEN=disabled
set ALLOWED_ORIGIN=*

echo Iniciando presentacion local sin token...
echo Abre http://IP-DE-ESTE-EQUIPO:3344 desde la misma red.
echo Este modo permite presentar la app, pero la instalacion requiere la URL HTTPS.
echo.
node src\server\server.js
