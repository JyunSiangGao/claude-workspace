@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8765
set PY=
where py >nul 2>nul && set PY=py
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY goto nopython
echo 正在啟動學佛影片搜尋...
echo 要停止時，關閉工作列上名為「學佛影片搜尋伺服器」的視窗。
start "學佛影片搜尋伺服器" /min %PY% -m http.server %PORT% --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/"
goto end
:nopython
echo 找不到 Python，改用直接開啟檔案的方式（影片會在 YouTube 新分頁播放）。
start "" "%~dp0index.html"
timeout /t 3 /nobreak >nul
:end
