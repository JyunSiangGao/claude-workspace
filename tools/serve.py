#!/usr/bin/env python3
"""
在本機開一個小伺服器並打開瀏覽器，由「開啟搜尋.bat」呼叫；也可以自己執行：
    python tools/serve.py

- 伺服器確定啟動之後才打開瀏覽器，不會出現「無法連上這個網站」。
- 已經開著的話不會重複啟動，只會再打開一次瀏覽器。
- 8765 被別的程式佔用時，自動改用下一個可用的埠。
- 關閉這個視窗（或按 Ctrl+C）就停止。

只需要 Python 3.9 以上，不用安裝其他套件。
"""
import http.server
import sys
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = "127.0.0.1"
FIRST_PORT = 8765
TRIES = 10
TITLE = "正覺弘法視頻搜尋"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # 每次都向伺服器確認檔案有沒有變，資料或網頁更新後不必按 Ctrl+F5
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # 不把每個請求印出來
        pass


class Server(http.server.ThreadingHTTPServer):
    # Windows 上開啟位址重用會讓兩個程式同時佔用同一個埠，所以關掉
    allow_reuse_address = False
    daemon_threads = True


def is_our_site(port):
    """這個埠上是不是已經有本搜尋網頁在執行"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://{HOST}:{port}/", timeout=2) as r:
            return TITLE in r.read(4096).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return False


def set_window_title(text):
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW(text)
        except Exception:  # noqa: BLE001
            pass


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:  # noqa: BLE001
            pass
    set_window_title("學佛影片搜尋（關閉這個視窗就會停止）")

    if not (ROOT / "index.html").exists():
        print(f"找不到 {ROOT / 'index.html'}，請確認整個資料夾都有下載完整。")
        return 1

    server = None
    for port in range(FIRST_PORT, FIRST_PORT + TRIES):
        try:
            server = Server((HOST, port), Handler)
            break
        except OSError:
            if is_our_site(port):
                url = f"http://localhost:{port}/"
                print(f"學佛影片搜尋已經在執行了，直接打開瀏覽器：{url}")
                webbrowser.open(url)
                return 0
    if server is None:
        print(f"{FIRST_PORT}～{FIRST_PORT + TRIES - 1} 這幾個埠都被其他程式佔用，無法啟動。")
        print("請關掉佔用的程式後再試一次。")
        return 1

    url = f"http://localhost:{server.server_address[1]}/"
    print("學佛影片搜尋已啟動。")
    print(f"  網址：{url}")
    print()
    print("使用期間請不要關閉這個視窗（可以縮到最小）。")
    print("用完之後，關閉這個視窗就會停止。")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
