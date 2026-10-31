#!/usr/bin/env python3
"""
下載 YouTube 頻道所有影片的字幕，並建立搜尋網頁用的索引檔 data/index.js。

用法（在專案根目錄執行）：
    pip install -r tools/requirements.txt
    python tools/build_index.py                 # 抓取新影片字幕並重建索引
    python tools/build_index.py --limit 5       # 先試抓 5 部
    python tools/build_index.py --build-only    # 只用已下載的字幕重建索引
    python tools/build_index.py --retry         # 重試之前失敗或沒有字幕的影片
    python tools/build_index.py --cookies-from-browser chrome   # 遇到「請登入確認不是機器人」時使用

已下載的字幕會存在 data/subs/<影片ID>.json，中斷後重跑會從上次進度繼續。
"""
import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

try:
    import yt_dlp
except ImportError:  # --build-only 不需要 yt-dlp
    yt_dlp = None

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CHANNEL = "https://www.youtube.com/@enlightenvideo"
# 字幕語言偏好順序（人工字幕優先，其次自動字幕）
LANG_PREF = ["zh-TW", "zh-Hant", "zh-HK", "zh", "zh-Hans", "zh-CN"]


class RateLimited(Exception):
    pass


# ---------- 字幕解析 ----------

def parse_json3(raw):
    data = json.loads(raw)
    segs = []
    for ev in data.get("events", []):
        parts = ev.get("segs")
        if not parts:
            continue
        text = "".join(p.get("utf8", "") for p in parts).replace("\n", " ").strip()
        if text:
            segs.append([round(ev.get("tStartMs", 0) / 1000, 1), text])
    return segs


def _vtt_time(s):
    secs = 0.0
    for part in s.replace(",", ".").split(":"):
        secs = secs * 60 + float(part)
    return secs


def parse_vtt(raw):
    segs, last = [], None
    blocks = re.split(r"\n\s*\n", raw.replace("\r", ""))
    for b in blocks:
        lines = b.strip().split("\n")
        for i, line in enumerate(lines):
            if "-->" in line:
                start = _vtt_time(line.split("-->")[0].strip())
                for t in lines[i + 1:]:
                    t = re.sub(r"<[^>]+>", "", t).strip()
                    if t and t != last:  # 自動字幕的 VTT 會重複前一行
                        segs.append([round(start, 1), t])
                        last = t
                break
    return segs


# ---------- YouTube 抓取 ----------

def make_ydl(args, **extra):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignore_no_formats_error": True,
    }
    if args.cookies_from_browser:
        opts["cookiesfrombrowser"] = (args.cookies_from_browser,)
    if args.cookies:
        opts["cookiefile"] = args.cookies
    opts.update(extra)
    return yt_dlp.YoutubeDL(opts)


def check_rate_limit(err):
    msg = str(err)
    if "429" in msg or "Sign in to confirm" in msg or "not a bot" in msg:
        raise RateLimited(msg)


def list_channel_videos(args):
    found = {}
    with make_ydl(args, extract_flat="in_playlist") as ydl:
        for tab in args.tabs:
            url = f"{args.channel.rstrip('/')}/{tab}"
            print(f"讀取影片清單：{url}")
            try:
                info = ydl.extract_info(url, download=False)
            except yt_dlp.utils.DownloadError as e:
                check_rate_limit(e)
                print(f"  （略過：{str(e).splitlines()[0]}）")
                continue
            for e in (info or {}).get("entries") or []:
                vid = (e or {}).get("id")
                if vid and len(vid) == 11 and vid not in found:
                    found[vid] = {"id": vid, "title": e.get("title") or ""}
            print(f"  目前共 {len(found)} 部影片")
    return list(found.values())


def choose_track(info):
    manual = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat" and v}
    auto = {k: v for k, v in (info.get("automatic_captions") or {}).items() if v}

    for k in LANG_PREF:
        if k in manual:
            return "manual", k, manual[k]
    for k in manual:
        if k.lower().startswith("zh"):
            return "manual", k, manual[k]
    # 自動字幕：優先使用原始語言（yt-dlp 會標成 xx-orig），避免拿到機器翻譯
    for k in auto:
        if k.endswith("-orig"):
            return "auto", k, auto[k]
    for k in LANG_PREF:
        if k in auto:
            return "auto", k, auto[k]
    if manual:
        k = next(iter(manual))
        return "manual", k, manual[k]
    return None


def download_track(ydl, formats):
    by_ext = {f.get("ext"): f for f in formats}
    for ext, parser in (("json3", parse_json3), ("vtt", parse_vtt)):
        f = by_ext.get(ext)
        if f and f.get("url"):
            raw = ydl.urlopen(f["url"]).read().decode("utf-8", "replace")
            return parser(raw)
    return []


def fetch_video(ydl, vid):
    try:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    except yt_dlp.utils.DownloadError as e:
        check_rate_limit(e)
        return {"id": vid, "error": str(e).splitlines()[0]}

    rec = {
        "id": vid,
        "title": info.get("title") or "",
        "upload_date": info.get("upload_date") or "",
        "duration": info.get("duration") or 0,
        "description": info.get("description") or "",
        "kind": None,
        "lang": None,
        "segments": [],
        "fetched": dt.datetime.now().isoformat(timespec="seconds"),
    }
    track = choose_track(info)
    if track:
        kind, lang, formats = track
        try:
            rec["segments"] = download_track(ydl, formats)
            rec["kind"], rec["lang"] = kind, lang
        except Exception as e:  # noqa: BLE001
            check_rate_limit(e)
            rec["error"] = f"字幕下載失敗：{e}"
    return rec


def fetch_all(args, cache_dir):
    videos = list_channel_videos(args)
    todo = []
    for v in videos:
        path = cache_dir / f"{v['id']}.json"
        if path.exists():
            if not args.retry:
                continue
            old = json.loads(path.read_text("utf-8"))
            if old.get("segments") and not old.get("error"):
                continue
        todo.append(v)
    if args.limit:
        todo = todo[: args.limit]
    print(f"\n頻道共 {len(videos)} 部影片，這次要抓 {len(todo)} 部。\n")

    with make_ydl(args) as ydl:
        for i, v in enumerate(todo, 1):
            print(f"[{i}/{len(todo)}] {v['id']} {v['title'][:40]}", end=" … ", flush=True)
            rec = fetch_video(ydl, v["id"])
            (cache_dir / f"{v['id']}.json").write_text(
                json.dumps(rec, ensure_ascii=False), "utf-8")
            if rec.get("error"):
                print(f"失敗（{rec['error'][:80]}）")
            elif rec["segments"]:
                kind = "人工字幕" if rec["kind"] == "manual" else "自動字幕"
                print(f"{kind} {rec['lang']}，{len(rec['segments'])} 段")
            else:
                print("沒有字幕（仍可搜尋標題與說明）")
            time.sleep(args.sleep)


# ---------- 建立索引 ----------

def get_converter(args):
    if args.no_convert:
        return lambda s: s
    try:
        from opencc import OpenCC
    except ImportError:
        print("（未安裝 opencc，簡體字幕不會轉成繁體。可執行 pip install opencc-python-reimplemented）")
        return lambda s: s
    cc = OpenCC("s2t")
    return cc.convert


def build_index(args, data_dir, cache_dir):
    conv = get_converter(args)
    videos = []
    for path in sorted(cache_dir.glob("*.json")):
        rec = json.loads(path.read_text("utf-8"))
        if not rec.get("title"):  # 抓取失敗、連標題都沒有
            continue
        d = rec.get("upload_date") or ""
        segs = [[int(t), conv(s)] for t, s in rec.get("segments") or []]
        videos.append({
            "id": rec["id"],
            "t": conv(rec["title"]),
            "d": f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else "",
            "dur": int(rec.get("duration") or (segs[-1][0] + 5 if segs else 0)),
            "desc": conv((rec.get("description") or "")[:2000]),
            "kind": rec.get("kind"),
            "seg": segs,
        })
    videos.sort(key=lambda v: v["d"], reverse=True)
    out = {
        "demo": False,
        "channel": args.channel,
        "generated": dt.datetime.now().isoformat(timespec="minutes"),
        "videos": videos,
    }
    target = data_dir / "index.js"
    target.write_text(
        "// 由 tools/build_index.py 自動產生，請勿手動編輯\nwindow.ENLIGHTEN_INDEX = "
        + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n", "utf-8")
    with_subs = sum(1 for v in videos if v["seg"])
    size = target.stat().st_size / 1024 / 1024
    print(f"\n已寫入 {target}（{len(videos)} 部影片，其中 {with_subs} 部有字幕，{size:.1f} MB）")


def main():
    p = argparse.ArgumentParser(description="下載頻道字幕並建立搜尋索引")
    p.add_argument("--channel", default=DEFAULT_CHANNEL, help="頻道網址")
    p.add_argument("--tabs", nargs="+", default=["videos", "streams"],
                   help="要抓的頻道分頁（預設 videos streams）")
    p.add_argument("--limit", type=int, default=0, help="這次最多抓幾部新影片")
    p.add_argument("--sleep", type=float, default=1.5, help="每部影片之間暫停秒數")
    p.add_argument("--retry", action="store_true", help="重試之前失敗或沒有字幕的影片")
    p.add_argument("--build-only", action="store_true", help="不連網，只重建索引")
    p.add_argument("--no-convert", action="store_true", help="不要把簡體轉成繁體")
    p.add_argument("--cookies-from-browser", metavar="BROWSER",
                   help="使用瀏覽器的登入 cookies，例如 chrome、firefox、edge、safari")
    p.add_argument("--cookies", metavar="FILE", help="cookies.txt 檔案路徑")
    p.add_argument("--data-dir", default=str(ROOT / "data"), help=argparse.SUPPRESS)
    args = p.parse_args()

    data_dir = Path(args.data_dir)
    cache_dir = data_dir / "subs"
    cache_dir.mkdir(parents=True, exist_ok=True)

    if not args.build_only:
        if yt_dlp is None:
            sys.exit("請先安裝套件：pip install -r tools/requirements.txt")
        try:
            fetch_all(args, cache_dir)
        except RateLimited as e:
            print(f"\n\nYouTube 暫時限制了請求：{str(e).splitlines()[0][:200]}")
            print("已下載的進度都保存了。請稍後再執行，或加上 --cookies-from-browser chrome。")
        except KeyboardInterrupt:
            print("\n\n已中斷，先用目前下載好的字幕建立索引。")
    build_index(args, data_dir, cache_dir)


if __name__ == "__main__":
    main()
