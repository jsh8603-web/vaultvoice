@echo off
title VaultVoice Tunnel
cd /d "%~dp0"
echo.
echo  ============================
echo   VaultVoice Cloudflare Tunnel
echo  ============================
echo.
echo   https://vault.wwwmoksu.com
echo.
echo   이 주소는 고정입니다.
echo   아이폰 홈 화면에 추가하면 항상 같은 주소로 접속됩니다.
echo.
npx cloudflared tunnel --config .cloudflared\config.yml run
pause
