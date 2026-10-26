@echo off
rem Run in a console window to see the log (Ctrl+C to stop).
cd /d "%~dp0.."
if exist soundpad-rpc.exe (soundpad-rpc.exe %*) else (node index.js %*)
pause
