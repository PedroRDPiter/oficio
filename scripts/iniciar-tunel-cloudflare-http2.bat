@echo off
setlocal
cd /d "%~dp0.."

if not exist "storage\tunnel" mkdir "storage\tunnel"

echo Iniciando tunel temporal de Cloudflare con http2...
echo La URL publica aparecera en storage\tunnel\cloudflared-http2.log
echo.

cloudflared tunnel --protocol http2 --url http://localhost:3344 > "storage\tunnel\cloudflared-http2.log" 2>&1
