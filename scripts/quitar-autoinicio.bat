@echo off
setlocal

echo Quitando autoinicio de Control de Oficios...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$startup=[Environment]::GetFolderPath('Startup'); $linkPath=Join-Path $startup 'Control Oficios DPDU.lnk'; if (Test-Path $linkPath) { Remove-Item -LiteralPath $linkPath -Force; Write-Output 'Eliminado' } else { Write-Output 'No existia' }"

echo.
pause
