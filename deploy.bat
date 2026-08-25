@echo off
rem Builds and uploads this stage to chub.ai from your own machine.
rem See deploy.ps1 for the actual logic and prerequisites - this is just
rem a launcher so you can double-click it or run `deploy.bat` from a shell.

setlocal
set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%deploy.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo deploy.bat failed with exit code %EXIT_CODE%.
)

pause
exit /b %EXIT_CODE%
