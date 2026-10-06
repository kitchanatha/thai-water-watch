@echo off
REM Starts the BMA camera relay for Thai Water Watch. Keep this window open.
cd /d "%~dp0"
node relay.js
pause
