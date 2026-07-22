@echo off
setlocal
cd /d "%~dp0.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar-cloud.ps1" -SinToken %*
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo El modo presentacion termino con error.
  pause
)

exit /b %EXIT_CODE%
