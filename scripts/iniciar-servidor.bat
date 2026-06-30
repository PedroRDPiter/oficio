@echo off
setlocal
cd /d "%~dp0.."
set PORT=3344
set HOST=0.0.0.0
set LAN_IP=

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$profiles=Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Private' | Select-Object -ExpandProperty InterfaceAlias; Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $profiles -contains $_.InterfaceAlias } | Select-Object -First 1 -ExpandProperty IPAddress"`) do set LAN_IP=%%I

if "%LAN_IP%"=="" (
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'WARP|Loopback|Virtual|VPN' } | Select-Object -First 1 -ExpandProperty IPAddress"`) do set LAN_IP=%%I
)

if "%LAN_IP%"=="" set LAN_IP=localhost

set PUBLIC_BASE_URL=http://%LAN_IP%:%PORT%
set ALLOWED_ORIGIN=*
echo Iniciando Control de Oficios...
echo.
echo En este equipo:
echo   http://localhost:%PORT%/
echo.
echo En otros equipos de la red:
echo   http://%LAN_IP%:%PORT%/
echo.
echo No cerrar ventana.
echo.
node src\server\server.js
pause
