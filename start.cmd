@echo off
cd /d "%~dp0"
set "PARTYBUS_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "PARTYBUS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%PARTYBUS_NODE%" server.js
pause
