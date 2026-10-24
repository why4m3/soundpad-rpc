@echo off
rem Run in a console window to see the log (Ctrl+C to stop).
cd /d "%~dp0.."
node index.js %*
pause
