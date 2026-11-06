@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

set "PY=C:\Users\86131\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"

netstat -ano | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul
if errorlevel 1 (
  start "Reminder Service" /min "%PY%" -m http.server %PORT% --bind 127.0.0.1
  timeout /t 1 /nobreak >nul
)

start "" "http://localhost:%PORT%"
