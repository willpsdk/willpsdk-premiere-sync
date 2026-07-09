@echo off
setlocal
title willpsdk Premiere Sync - Installer

echo.
echo  ==============================================
echo   willpsdk Premiere Sync - Premiere Pro plugin
echo  ==============================================
echo.

set "SRC=%~dp0..\extension"
set "DEST=%APPDATA%\Adobe\CEP\extensions\willpsdk-premiere-sync"
set "OLD=%APPDATA%\Adobe\CEP\extensions\willps-video-sync"

if not exist "%SRC%\CSXS\manifest.xml" (
    echo  [ERROR] Could not find the extension files next to this installer.
    echo          Keep the folder structure from the download intact.
    pause
    exit /b 1
)

echo  [1/3] Enabling Adobe extension debug mode (needed for unsigned extensions)...
for %%V in (9 10 11 12) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
)

echo  [2/3] Installing extension...
if exist "%OLD%" rmdir /s /q "%OLD%"
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%\" /e /i /q /y >nul
if errorlevel 1 (
    echo  [ERROR] Copy failed.
    pause
    exit /b 1
)

echo  [3/3] Done!
echo.
echo  Next steps:
echo    1. Restart Premiere Pro (fully quit it first).
echo    2. Open:  Window ^> Extensions ^> willpsdk Premiere Sync
echo    3. If Windows Firewall asks, click "Allow" (private networks)
echo       so your computers can see each other.
echo.
echo  Your existing shared projects and synced files are kept.
echo.
pause
