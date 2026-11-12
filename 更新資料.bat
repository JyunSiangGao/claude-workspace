@echo off
rem Keep this file ASCII-only (see the note in the other .bat file).
rem Downloads new episodes from the website and rebuilds the search index.
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY goto nopython
%PY% tools\build_index.py
echo.
rem Books, e-paper and media pages from books.enlighten.org.tw (needs: python -m pip install pymupdf)
%PY% tools\build_books.py
echo.
pause
goto end
:nopython
echo Python was not found. Install Python 3.9 or later from https://www.python.org
echo and run this file again.
pause
:end
