@echo off
setlocal EnableDelayedExpansion
rem NodeDesk demo: one-click directory service.
rem Reads demo-config.txt next to this script.

set "KIT=%~dp0"
set "CFG=%KIT%demo-config.txt"
if not exist "%CFG%" (
  echo demo-config.txt not found next to this script.
  pause
  exit /b 1
)

for /f "usebackq tokens=1,2 delims== eol=#" %%A in ("%CFG%") do (
  if "%%A"=="GOOGLE_CLIENT_ID" set "GOOGLE_CLIENT_ID=%%B"
  if "%%A"=="DIRECTORY_URL" set "DIRECTORY_URL=%%B"
)

if "%GOOGLE_CLIENT_ID%"=="" goto noid
echo %GOOGLE_CLIENT_ID% | findstr /i "PASTE_YOUR" >nul && goto noid
goto haveid
:noid
echo.
echo  You still need to paste your Google OAuth client ID into demo-config.txt
echo  ^(line GOOGLE_CLIENT_ID=...^). See the comments in that file.
echo.
pause
exit /b 1
:haveid

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 22.5+ from nodejs.org and try again.
  pause
  exit /b 1
)

rem The service lives in the repo checkout, one level up from this kit by default.
set "SVC=%KIT%..\nodedesk\services\directory"
if not exist "%SVC%\src\server.js" set "SVC=%KIT%services\directory"
if not exist "%SVC%\src\server.js" (
  echo Could not find services\directory\src\server.js.
  echo Put this kit next to the nodedesk repo folder, or copy services\directory into it.
  pause
  exit /b 1
)

set "PORT=8787"
set "DB_PATH=%KIT%demo-directory.db"
cd /d "%SVC%"
echo.
echo  NodeDesk directory service starting on port 8787 ...
echo  Desktop apps should use: %DIRECTORY_URL%
echo  Leave this window open during the demo. Ctrl+C stops the service.
echo.
node src\server.js
pause
