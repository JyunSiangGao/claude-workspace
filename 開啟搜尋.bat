@echo off
rem Keep this file ASCII-only. cmd.exe mis-reads batch files that contain
rem Chinese text and can silently skip the next command (the server never
rem started). All Chinese messages are printed by tools\serve.py instead.
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY goto nopython
%PY% tools\serve.py
if errorlevel 1 pause
goto end
:nopython
echo Python was not found, so the page is opened directly as a file.
echo Videos will open in a new YouTube tab instead of playing inside the page.
start "" "%~dp0index.html"
timeout /t 6 >nul
:end
