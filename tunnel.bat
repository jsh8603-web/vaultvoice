@echo off
title VaultVoice Tunnel
cd /d "%~dp0"
echo.
echo  ============================
echo   VaultVoice Cloudflare Tunnel
echo  ============================
echo.
echo   Quick Tunnel 모드 (도메인 불필요)
echo   아래 출력에서 trycloudflare.com URL을 확인하세요.
echo.
npx cloudflared tunnel --url http://localhost:9097
pause
