@echo off
setlocal EnableExtensions

rem ASCII only: UTF-8 Cyrillic in .bat breaks cmd line parsing on some Windows setups.
cd /d "%~dp0tutor-app" || (
  echo ERROR: tutor-app folder not found next to this .bat file.
  echo Expected: %~dp0tutor-app
  pause
  exit /b 1
)

if not exist "package.json" (
  echo ERROR: package.json not found in tutor-app. Wrong folder?
  echo Current directory:
  cd
  pause
  exit /b 1
)

where npm >nul 2>&1 || (
  echo ERROR: npm not in PATH. Install Node.js from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Running npm install...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

:server_loop
echo.
echo Starting dev server...
echo Open the URL shown below in your browser ^(usually http://localhost:5173^).
echo Press Ctrl+C to stop the server, then choose restart or quit.
echo.
call npm run dev

echo.
echo --- Server stopped ---
choice /C RN /M "R = Restart   N = Quit"
if errorlevel 2 goto :done
goto server_loop

:done
echo Bye.
pause
endlocal
