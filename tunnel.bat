@echo off
title VaultVoice Tunnel
echo.
echo  ============================
echo   VaultVoice Cloudflare Tunnel
echo  ============================
echo.
echo  아래 나오는 https://....trycloudflare.com 주소를
echo  아이폰 Safari에서 접속하세요!
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:9097
pause
