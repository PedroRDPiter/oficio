@echo off
setlocal
call "%~dp0iniciar-cloud.bat" %*
exit /b %ERRORLEVEL%
