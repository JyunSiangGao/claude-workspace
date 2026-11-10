@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".git" goto nogit
where git >nul 2>nul || goto nogitexe
echo 正在從 GitHub 下載最新資料...
git pull
echo.
echo 更新完成。
pause
goto end
:nogitexe
echo 這台電腦沒有安裝 Git，請到 https://git-scm.com 下載安裝後再試一次。
pause
goto end
:nogit
echo 這個資料夾不是用 git 下載的，沒辦法自動更新。
echo 請到 GitHub 重新下載最新的 ZIP，解壓縮後覆蓋這個資料夾。
pause
:end
