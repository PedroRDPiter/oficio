@echo off
setlocal
cd /d "%~dp0.."

if not exist "storage\tunnel" mkdir "storage\tunnel"

echo Iniciando tunel temporal de Cloudflare...
echo La URL publica aparecera en storage\tunnel\cloudflared.log
echo.

cloudflared tunnel --protocol http2 --url http://localhost:3344 > "storage\tunnel\cloudflared.log" 2>&1
