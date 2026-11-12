@echo off
rem Keep this file ASCII-only (see the note in the other .bat file).
rem Speech-to-text for episodes that have no transcript on the website,
rem then rebuilds the search index. Safe to close and run again: it resumes.
cd /d "%~dp0"
if not exist D:\whisper-asr\venv\Scripts\python.exe goto noenv
D:\whisper-asr\venv\Scripts\python.exe tools\transcribe.py
echo.
D:\whisper-asr\venv\Scripts\python.exe tools\build_index.py --build-only
echo.
pause
goto end
:noenv
echo The speech recognition environment was not found at D:\whisper-asr\venv
echo See README for how to install it.
pause
:end
