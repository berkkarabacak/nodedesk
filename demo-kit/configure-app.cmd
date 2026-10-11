@echo off
setlocal EnableDelayedExpansion
rem NodeDesk demo: writes account.json into the desktop app's config dir
rem (%APPDATA%\dev.nodedesk.app\account.json) from demo-config.txt.

set "KIT=%~dp0"
set "CFG=%KIT%demo-config.txt"
for /f "usebackq tokens=1,2 delims== eol=#" %%A in ("%CFG%") do (
  if "%%A"=="GOOGLE_CLIENT_ID" set "GOOGLE_CLIENT_ID=%%B"
  if "%%A"=="DIRECTORY_URL" set "DIRECTORY_URL=%%B"
)

if "%GOOGLE_CLIENT_ID%"=="" goto bad
echo %GOOGLE_CLIENT_ID% | findstr /i "PASTE_YOUR" >nul && goto bad
if "%DIRECTORY_URL%"=="" goto bad
goto ok
:bad
echo Fill in demo-config.txt first (client ID and directory URL).
pause
exit /b 1
:ok

set "APPCFG=%APPDATA%\dev.nodedesk.app"
if not exist "%APPCFG%" mkdir "%APPCFG%"
(
  echo {
  echo   "clientId": "%GOOGLE_CLIENT_ID%",
  echo   "directoryUrl": "%DIRECTORY_URL%"
  echo }
) > "%APPCFG%\account.json"
echo Wrote %APPCFG%\account.json
type "%APPCFG%\account.json"
echo.
pause
