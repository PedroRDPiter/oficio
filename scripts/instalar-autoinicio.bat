@echo off
setlocal
set SCRIPT_DIR=%~dp0
set VBS_PATH=%SCRIPT_DIR%iniciar-servidor-oculto.vbs

echo Instalando autoinicio de Control de Oficios...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$startup=[Environment]::GetFolderPath('Startup'); $linkPath=Join-Path $startup 'Control Oficios DPDU.lnk'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($linkPath); $link.TargetPath='wscript.exe'; $link.Arguments='\"%VBS_PATH%\"'; $link.WorkingDirectory='%SCRIPT_DIR%'; $link.IconLocation='C:\Windows\System32\shell32.dll,220'; $link.Save(); Write-Output $linkPath"

if errorlevel 1 (
  echo.
  echo No se pudo crear el acceso directo de autoinicio.
  pause
  exit /b 1
)

echo.
echo Autoinicio instalado correctamente.
echo Se ejecutara cuando inicies sesion en Windows.
pause
