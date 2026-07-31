@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required for the Vercel deploy command.
  echo Install the current LTS version from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
echo.
echo Step 1: Sign in to Vercel in the browser.
call npx vercel@latest login
if errorlevel 1 goto failed
echo.
echo Step 2: Deploy Adscope HRMS to production.
echo When asked, choose your Vercel account, create a NEW project, and accept the current folder as the project root.
call npx vercel@latest --prod
if errorlevel 1 goto failed
echo.
echo Deployment finished. Copy the vercel.app URL shown above.
pause
exit /b 0
:failed
echo.
echo Deployment did not finish. Read the error above and try again.
pause
exit /b 1
