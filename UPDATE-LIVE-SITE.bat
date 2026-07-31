@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required.
  echo Install the current LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

echo.
echo Updating the existing Adscope HRMS production website...
echo.

if not exist ".vercel\project.json" (
  echo This folder is not linked to the existing Vercel project yet.
  echo In the next prompts, choose your Vercel account and LINK TO THE EXISTING HRMS PROJECT.
  echo Do not create a new project.
  echo.
  call npx vercel@latest link
  if errorlevel 1 goto failed
)

echo.
echo Deploying the English, human-readable interface to production...
call npx vercel@latest --prod
if errorlevel 1 goto failed

echo.
echo Update finished. Open https://hrms.adscope.net/admin/ and refresh the page.
pause
exit /b 0

:failed
echo.
echo The update did not finish. Read the error shown above and try again.
pause
exit /b 1
