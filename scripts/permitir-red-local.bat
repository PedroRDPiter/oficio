@echo off
setlocal

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Solicitando permisos de administrador para abrir el puerto 3344...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Configurando firewall para Control de Oficios...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$rule='Control Oficios DPDU - Puerto 3344'; if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) { Set-NetFirewallRule -DisplayName $rule -Enabled True -Direction Inbound -Action Allow -Profile Private } else { New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3344 -Profile Private | Out-Null }; Write-Output 'Puerto 3344 permitido en redes privadas.'"

echo.
echo Listo. Ahora abre la app desde otros equipos con la URL que muestra iniciar-servidor.bat.
pause
