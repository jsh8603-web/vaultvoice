@echo off
title VaultVoice Startup Registration
echo.
echo  =========================================
echo   VaultVoice 윈도우 시작 시 자동 실행 등록
echo  =========================================
echo.
echo   이 스크립트는 컴퓨터가 켜질 때 자동으로
echo   start.bat와 tunnel.bat를 실행하도록 설정합니다.
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "CURRENT_DIR=%~dp0"

REM Remove trailing backslash
if "%CURRENT_DIR:~-1%"=="\" set "CURRENT_DIR=%CURRENT_DIR:~0,-1%"

echo   [1] start.bat 바로가기 생성 중...
powershell "$s=(New-Object -COM WScript.Shell).CreateShortcut('%STARTUP_FOLDER%\VaultVoice_Server.lnk');$s.TargetPath='%CURRENT_DIR%\start.bat';$s.WorkingDirectory='%CURRENT_DIR%';$s.Save()"

echo   [2] tunnel.bat 바로가기 생성 중...
powershell "$s=(New-Object -COM WScript.Shell).CreateShortcut('%STARTUP_FOLDER%\VaultVoice_Tunnel.lnk');$s.TargetPath='%CURRENT_DIR%\tunnel.bat';$s.WorkingDirectory='%CURRENT_DIR%';$s.Save()"

echo.
echo   완료되었습니다!
echo   이제 컴퓨터를 재부팅하면 자동으로 서버와 터널이 켜집니다.
echo.
pause
