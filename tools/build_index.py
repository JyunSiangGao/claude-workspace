#!/usr/bin/env python3
"""
從「正覺教團弘法視頻」網站 (https://video.enlighten.org.tw) 抓取所有節目的文字稿，
建立搜尋網頁用的索引（data/catalog.js 與 data/series/*.js）。

只需要 Python 3.9 以上，不用安裝其他套件。在專案根目錄執行：
    python tools/build_index.py                # 抓取新節目並重建索引
    python tools/build_index.py --series a01   # 只抓某些系列（可列多個）
    python tools/build_index.py --build-only   # 不連網，只用已下載的資料重建索引（例如修改名詞表之後）
    python tools/build_index.py --refresh      # 全部重新下載

下載的網頁資料會存在 cache/（不需要上傳到 GitHub），中斷後重跑會從上次進度繼續。

時間點說明：網站的文字稿沒有時間標記，所以用「該段文字在全文中的位置 × 節目長度」估算，
節目長度從網站提供的 mp3 檔頭讀取。估算值通常與實際相差數十秒以內。
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import html
import json
import re
import struct
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://video.enlighten.org.tw"
LANG = "zh-tw"
UA = "Mozilla/5.0 (personal subtitle search index; +https://video.enlighten.org.tw)"


# ---------- 網路 ----------

def get(url, headers=None, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read(), dict(r.headers)
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 ** i)


def get_text(url):
    return get(url)[0].decode("utf-8", "replace")


# ---------- 網頁解析 ----------

def strip_tags(s):
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", s).strip()


def list_series():
    """從首頁選單取得所有系列 (a01, a02, ...)"""
    page = get_text(f"{BASE}/{LANG}/a")
    codes = sorted(set(re.findall(rf'href="/{LANG}/a/(a\d+)"', page)))
    return codes


def parse_series_page(code):
    page = get_text(f"{BASE}/{LANG}/a/{code}")
    m = re.search(r"<title>([^<]*)</title>", page)
    name = strip_tags(m.group(1)) if m else code
    episodes = []
    for row in re.findall(r"<tr class=\"cat-list-row\d\">(.*?)</tr>", page, re.S):
        link = re.search(rf'href="(/{LANG}/a/{code}/([^"]+))"[^>]*>(.*?)</a>', row, re.S)
        if not link:
            continue
        num = re.search(r'<div class="[^"]*">\s*([^<]*?)\s*</div>', row)
        mp3 = re.search(r'href="([^"]+\.mp3)"', row)
        author = re.search(r'class="list-author"[^>]*>(.*?)</td>', row, re.S)
        episodes.append({
            "slug": link.group(2),
            "url": BASE + link.group(1),
            "title": strip_tags(link.group(3)),
            "ep": strip_tags(num.group(1)) if num else "",
            "mp3": mp3.group(1) if mp3 else "",
            "teacher": strip_tags(author.group(1)) if author else "",
        })
    # 去除重複
    seen, uniq = set(), []
    for e in episodes:
        if e["slug"] not in seen:
            seen.add(e["slug"])
            uniq.append(e)
    return name, uniq


def parse_episode_page(page):
    yt = re.search(r"youtube\.com/embed/([\w-]{11})", page) or re.search(r"img\.youtube\.com/vi/([\w-]{11})", page)
    teacher = re.search(r'<h5 class="enlighten-h5">(.*?)</h5>', page, re.S)
    m = re.search(r'<div[^>]*class="[^"]*enlighten-video-content[^"]*"[^>]*>', page)
    paras = []
    if m:
        body = page[m.end():]
        # 文字稿之後接著的是頁面其他區塊，以第一個 </div> 之後的區塊開頭為界
        end = len(body)
        for marker in ("<div class=\"enlighten-", "<dl class=", "點擊數", "</article>"):
            i = body.find(marker)
            if i != -1:
                end = min(end, i)
        body = body[:end]
        chunks = re.findall(r"<p[^>]*>(.*?)</p>", body, re.S) or [body]
        for c in chunks:
            for line in strip_tags(c).split("\n"):
                line = line.strip()
                if line:
                    paras.append(line)
    t = strip_tags(teacher.group(1)) if teacher else ""
    t = re.sub(r"^由|開示$", "", t)
    return {"yt": yt.group(1) if yt else "", "teacher": t, "paras": paras}


# ---------- mp3 長度 ----------

_BR = {1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
       2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
_SR = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def mp3_duration(head, total):
    off = 0
    if head[:3] == b"ID3":
        off = 10 + (head[6] << 21 | head[7] << 14 | head[8] << 7 | head[9])
        if off + 4 > len(head):
            return None
    i = off
    while i < len(head) - 4:
        if head[i] == 0xFF and head[i + 1] & 0xE0 == 0xE0:
            ver, layer = (head[i + 1] >> 3) & 3, (head[i + 1] >> 1) & 3
            bri, sri = head[i + 2] >> 4, (head[i + 2] >> 2) & 3
            if ver != 1 and layer == 1 and 0 < bri < 15 and sri < 3:
                break
        i += 1
    else:
        return None
    ver, bri, sri, mode = (head[i + 1] >> 3) & 3, head[i + 2] >> 4, (head[i + 2] >> 2) & 3, head[i + 3] >> 6
    br = _BR[1 if ver == 3 else 2][bri] * 1000
    sr = _SR[ver][sri]
    spf = 1152 if ver == 3 else 576
    xo = i + 4 + ((32 if mode != 3 else 17) if ver == 3 else (17 if mode != 3 else 9))
    if head[xo:xo + 4] in (b"Xing", b"Info") and len(head) >= xo + 12:
        if struct.unpack(">I", head[xo + 4:xo + 8])[0] & 1:
            return struct.unpack(">I", head[xo + 8:xo + 12])[0] * spf / sr
    return (total - i) * 8 / br


def fetch_duration(mp3_url):
    if not mp3_url:
        return 0
    try:
        head, hdr = get(mp3_url, {"Range": "bytes=0-65535"})
        total = 0
        cr = hdr.get("Content-Range") or hdr.get("content-range") or ""
        if "/" in cr:
            total = int(cr.split("/")[-1])
        if not total:
            total = int(hdr.get("Content-Length") or hdr.get("content-length") or 0)
        d = mp3_duration(head, total)
        return int(round(d)) if d else 0
    except Exception:  # noqa: BLE001
        return 0


# ---------- 抓取 ----------

def fetch_episode(ep, series_code, cache_dir):
    page = get_text(ep["url"])
    info = parse_episode_page(page)
    rec = {**ep, "series": series_code, **{k: v for k, v in info.items() if k != "teacher"}}
    rec["teacher"] = ep.get("teacher") or info["teacher"]
    rec["dur"] = fetch_duration(ep["mp3"])
    rec["fetched"] = dt.datetime.now().isoformat(timespec="seconds")
    (cache_dir / f"{ep['slug']}.json").write_text(json.dumps(rec, ensure_ascii=False), "utf-8")
    return rec


def crawl(args, cache_dir):
    codes = args.series or list_series()
    print(f"共 {len(codes)} 個系列：{' '.join(codes)}")
    series_meta = {}
    todo = []
    for code in codes:
        name, eps = parse_series_page(code)
        series_meta[code] = {"code": code, "name": name, "count": len(eps)}
        new = []
        for e in eps:
            path = cache_dir / f"{e['slug']}.json"
            if args.refresh or not path.exists() or needs_refetch(json.loads(path.read_text("utf-8"))):
                new.append(e)
        print(f"  {code} {name}：{len(eps)} 集，需下載 {len(new)} 集")
        todo += [(e, code) for e in new]
        time.sleep(args.sleep)
    meta_path = cache_dir / "_series.json"
    old_meta = json.loads(meta_path.read_text("utf-8")) if meta_path.exists() else {}
    meta_path.write_text(json.dumps({**old_meta, **series_meta}, ensure_ascii=False), "utf-8")

    if args.limit:
        todo = todo[: args.limit]
    print(f"\n開始下載 {len(todo)} 集（同時 {args.workers} 個連線）…")
    done = fails = 0
    t0 = time.time()

    def job(item):
        ep, code = item
        time.sleep(args.sleep)
        return fetch_episode(ep, code, cache_dir)

    with cf.ThreadPoolExecutor(args.workers) as pool:
        futs = {pool.submit(job, it): it for it in todo}
        for f in cf.as_completed(futs):
            ep, code = futs[f]
            try:
                rec = f.result()
                done += 1
                if not rec["paras"]:
                    print(f"  （{rec['slug']} 沒有文字稿）")
            except Exception as e:  # noqa: BLE001
                fails += 1
                print(f"  失敗 {ep['slug']}：{e}")
            n = done + fails
            if n % 50 == 0 or n == len(todo):
                el = time.time() - t0
                print(f"  進度 {n}/{len(todo)}（{el / 60:.1f} 分鐘）")
    if fails:
        print(f"\n有 {fails} 集下載失敗，再執行一次會重試。")


# ---------- 建立索引 ----------

CHARS_PER_MIN = 190  # 沒有 mp3 時，用平均語速估算節目長度


def is_placeholder(paras):
    t = "".join(paras)
    return len(t) < 60 and ("敬請期待" in t or "敬请期待" in t)


def needs_refetch(rec):
    """文字稿還沒上線或沒抓到長度的節目，下次執行時再檢查一次"""
    return not rec.get("paras") or is_placeholder(rec["paras"]) or not rec.get("dur")


def ep_sort_key(rec):
    m = re.search(r"(\d+)", rec.get("ep") or "")
    n = int(m.group(1)) if m else 0
    m2 = re.search(r"_(\d+)$", rec["slug"])
    return (n or (int(m2.group(1)) if m2 else 0), rec["slug"])


def norm(s):
    return re.sub(r"\s+", "", s or "").lower()


def build(args, data_dir, cache_dir):
    series_meta = json.loads((cache_dir / "_series.json").read_text("utf-8")) if (cache_dir / "_series.json").exists() else {}
    by_series = {}
    for p in cache_dir.glob("*.json"):
        if p.name.startswith("_"):
            continue
        rec = json.loads(p.read_text("utf-8"))
        by_series.setdefault(rec["series"], []).append(rec)

    out_dir = data_dir / "series"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.js"):
        old.unlink()

    catalog = []
    total_chars = 0
    all_text = []
    for code in sorted(by_series):
        recs = sorted(by_series[code], key=ep_sort_key)
        eps = []
        for r in recs:
            paras = [] if is_placeholder(r.get("paras", [])) else r.get("paras", [])
            who = r.get("teacher", "")
            if not re.search(r"\w", who):  # 網站用「─」表示沒有主講人
                who = ""
            dur = r.get("dur", 0) if r.get("dur", 0) >= 60 else 0
            item = {"id": r["slug"], "ep": r.get("ep", ""), "t": r["title"], "who": who,
                    "yt": r.get("yt", ""), "dur": dur, "p": paras}
            if not dur and paras:
                item["dur"] = int(len("".join(paras)) / CHARS_PER_MIN * 60)
                item["durEst"] = 1
            eps.append(item)
        all_text += [norm("".join(e["p"])) for e in eps]
        chars = sum(len("".join(e["p"])) for e in eps)
        total_chars += chars
        meta = series_meta.get(code, {})
        catalog.append({"code": code, "name": meta.get("name", code), "count": len(eps), "chars": chars,
                        "file": f"data/series/{code}.js"})
        (out_dir / f"{code}.js").write_text(
            "// 由 tools/build_index.py 自動產生\nwindow.ENL_ADD(" +
            json.dumps({"code": code, "episodes": eps}, ensure_ascii=False, separators=(",", ":")) + ");\n", "utf-8")

    # 名詞表中每個名詞的出現次數（首頁「常見名詞」使用）
    term_counts = {}
    gpath = data_dir / "glossary.js"
    if gpath.exists():
        src = gpath.read_text("utf-8")
        for m in re.finditer(r'term:\s*"([^"]+)",\s*aliases:\s*\[([^\]]*)\]', src):
            variants = [m.group(1)] + re.findall(r'"([^"]+)"', m.group(2))
            variants = sorted({norm(v) for v in variants if v}, key=len, reverse=True)
            n = 0
            for t in all_text:
                taken = []
                for v in variants:
                    for mm in re.finditer(re.escape(v), t):
                        a, b = mm.span()
                        if not any(a < y and b > x for x, y in taken):
                            taken.append((a, b))
                            n += 1
            term_counts[m.group(1)] = n

    cat = {
        "site": BASE + f"/{LANG}/",
        "generated": dt.datetime.now().isoformat(timespec="minutes"),
        "series": catalog,
        "termCounts": term_counts,
    }
    (data_dir / "catalog.js").write_text(
        "// 由 tools/build_index.py 自動產生\nwindow.ENL_CATALOG = " +
        json.dumps(cat, ensure_ascii=False, separators=(",", ":")) + ";\n", "utf-8")
    n = sum(c["count"] for c in catalog)
    size = sum(p.stat().st_size for p in out_dir.glob("*.js")) / 1024 / 1024
    print(f"\n索引完成：{len(catalog)} 個系列、{n} 集、{total_chars / 10000:.0f} 萬字（{size:.1f} MB）")


def main():
    p = argparse.ArgumentParser(description="抓取正覺教團弘法視頻的文字稿並建立搜尋索引")
    p.add_argument("--series", nargs="+", help="只抓這些系列，例如 a01 a02")
    p.add_argument("--limit", type=int, default=0, help="這次最多下載幾集")
    p.add_argument("--workers", type=int, default=4, help="同時下載的連線數")
    p.add_argument("--sleep", type=float, default=0.3, help="每個請求前暫停秒數")
    p.add_argument("--refresh", action="store_true", help="全部重新下載")
    p.add_argument("--build-only", action="store_true", help="不連網，只重建索引")
    p.add_argument("--cache-dir", default=str(ROOT / "cache"), help=argparse.SUPPRESS)
    p.add_argument("--data-dir", default=str(ROOT / "data"), help=argparse.SUPPRESS)
    args = p.parse_args()

    cache_dir, data_dir = Path(args.cache_dir), Path(args.data_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    if not args.build_only:
        try:
            crawl(args, cache_dir)
        except KeyboardInterrupt:
            print("\n已中斷，先用目前下載好的資料建立索引。")
    build(args, data_dir, cache_dir)


if __name__ == "__main__":
    sys.exit(main())
