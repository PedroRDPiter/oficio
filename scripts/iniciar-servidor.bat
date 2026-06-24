@echo off
cd /d "%~dp0.."
set PORT=3344
set HOST=0.0.0.0
echo Iniciando Control de Oficios...
echo.
echo En este equipo:
echo   http://localhost:%PORT%/
echo.
echo En otros equipos de la red:
echo   http://10.1.85.9:%PORT%/
echo.
echo No cerrar ventana.
echo.
node src\server\server.js
pause
