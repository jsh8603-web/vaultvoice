@echo off
title VaultVoice Server
echo.
echo  ============================
echo   VaultVoice 서버 시작
echo  ============================
echo.
cd /d "%~dp0"
if not exist node_modules (
  echo.
  echo [알림] node_modules가 없습니다. 설치를 진행합니다...
  call npm install
)
node server.js
pause
