#!/usr/bin/env python3
"""
從「正智書香園地」(https://books.enlighten.org.tw) 抓取贈閱書籍、正覺電子報、正智影音的資料，
建立搜尋網頁用的索引（data/books_catalog.js 與 data/books/*.js）。

需要 Python 3.9 以上，以及讀 PDF 用的套件 PyMuPDF：
    python -m pip install pymupdf

在專案根目錄執行：
    python tools/build_books.py                 # 抓取新的書刊並重建索引
    python tools/build_books.py --only e        # 只抓某一類（g 贈閱書籍、e 電子報、m 影音，可列多個）
    python tools/build_books.py --build-only    # 不連網，只用已下載的資料重建索引
    python tools/build_books.py --reextract     # 不連網，用留下來的 PDF 重新擷取文字（改了擷取規則之後）
    python tools/build_books.py --refresh       # 全部重新下載
    python tools/build_books.py --keep-pdf      # 擷取文字後保留 PDF（預設會刪除以節省空間）

關於 PDF 的權限：出版社在部分 PDF 設定了「不允許複製／擷取內容」。這些 PDF 本腳本不會擷取文字，
只收錄官網頁面上公開的簡介與目錄，並附上 PDF 連結供開啟閱讀。只有允許擷取的 PDF 才會建立全文索引。

下載的資料存在 cache/books/，中斷後重跑會從上次進度繼續。
"""
import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import html
import json
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://books.enlighten.org.tw"
LANG = "zh-tw"
UA = "Mozilla/5.0 (personal study search index)"

# 類別：代號 → (清單網址, 系列代號, 名稱, 單位)
CATS = {
    "e": (f"/{LANG}/e/e-1", "bke", "正覺電子報", "期"),
    "g": (f"/{LANG}/g/g-name", "bkg", "贈閱書籍", "本"),
    "m": (f"/{LANG}/m/m-cover", "bkm", "正智影音", "項"),
}
CHUNK_CHARS = 1_500_000   # 每個資料檔大約放多少字


# ---------- 網路 ----------

def get(url, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 ** i)


def get_text(url):
    return get(url).decode("utf-8", "replace")


def absolute(href):
    return urllib.parse.urljoin(BASE + "/", html.unescape(href.strip()))


# ---------- 網頁解析 ----------

def strip_tags(s):
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ").replace("　", " ")
    return re.sub(r"[ \t\r\n]+", " ", s).strip()


def to_paras(fragment):
    """把一段 HTML 轉成段落清單"""
    s = re.sub(r"<(script|style)\b.*?</\1>", "", fragment, flags=re.S | re.I)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<br\s*/?>|</(p|h\d|li|div|tr|dd|dt|blockquote)>", "\n", s, flags=re.I)
    out = []
    for line in s.split("\n"):
        line = strip_tags(line)
        if line:
            out.append(line)
    return out


def list_items(cat):
    path = CATS[cat][0]
    page = get_text(f"{BASE}{path}?limit=0")
    prefix = path.rsplit("/", 1)[0] if cat != "g" else path
    pat = re.compile(r'href="(?:https?://books\.enlighten\.org\.tw)?(' + re.escape(prefix) + r'/(\d+)-([a-z0-9_]+))"', re.I)
    seen, out = set(), []
    for m in pat.finditer(page):
        if m.group(3) not in seen:
            seen.add(m.group(3))
            out.append({"id": m.group(3), "url": BASE + m.group(1)})
    return out


def parse_item(page, cat):
    m = re.search(r'<h1 class="article-title"[^>]*>(.*?)</h1>', page, re.S)
    title = strip_tags(m.group(1)) if m else ""
    i = page.find('<section class="article-content')
    j = page.find("</section>", i)
    body = page[i:j] if i != -1 else ""
    fields = dict(re.findall(r"<h4>\s*【([^】]+)】(.*?)</h4>", body, re.S))
    who = strip_tags(fields.get("作者", ""))
    date = strip_tags(fields.get("出版日期", ""))
    # 下載按鈕
    pdf = ""
    for href, label in re.findall(r'<a[^>]+href="([^"]+\.pdf(?:\?[^"]*)?)"[^>]*>(.*?)</a>', body, re.S | re.I):
        if "簡體" in strip_tags(label):
            continue
        pdf = absolute(href)
        break
    # 簡介：分享按鈕之後的內容
    k = body.find("<!-- END: Modules Anywhere -->")
    main = body[k:] if k != -1 else body
    intro = to_paras(main)
    # 影音頁面的下載／播放連結
    links = []
    if cat == "m":
        for href, label in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', main, re.S | re.I):
            label = strip_tags(label)
            if re.search(r"\.(mp3|mp4|zip)(\?|$)|filename=|video\.enlighten|youtu", href, re.I):
                links.append([label or "連結", absolute(href)])
        for vid in re.findall(r'youtube(?:-nocookie)?\.com/embed/([\w-]{11})', main):
            links.append(["YouTube 影片", "https://www.youtube.com/watch?v=" + vid])
    ep = ""
    if cat == "e":
        n = re.search(r"(\d+)\s*期", title)
        ep = n.group(1) if n else ""
    return {"title": title, "who": who, "date": date, "pdf": pdf, "intro": intro, "links": links, "ep": ep}


# ---------- PDF 擷取 ----------

# 直排用的標點（相容形式）換回一般標點
_VERT = str.maketrans({
    "︰": "：", "︱": "｜", "︳": "｜", "︵": "（", "︶": "）", "︷": "｛", "︸": "｝", "︹": "〔", "︺": "〕",
    "︻": "【", "︼": "】", "︽": "《", "︾": "》", "︿": "〈", "﹀": "〉", "﹁": "「", "﹂": "」", "﹃": "『", "﹄": "』",
    "︐": "，", "︑": "、", "︒": "。", "︓": "：", "︔": "；", "︕": "！", "︖": "？", "︙": "…",
    # 部分直排書的字型把標點對應到罕用字的字碼
    "㜭": "，", "㜮": "、", "㜯": "。",
})


def clean(s):
    s = s.translate(_VERT).replace("\xa0", " ").replace("　", " ")
    s = re.sub(r"[\x00-\x1f�]", "", s)
    return re.sub(r" +", " ", s).strip()


def _furniture_key(t):
    return re.sub(r"[\d\s\W]+", "", t)


def extract_pdf(path):
    """回傳 (狀態, 頁數, 段落清單, 每段所在頁碼)。狀態：ok／locked（出版社不允許擷取）／image（沒有文字層）"""
    import pymupdf
    doc = pymupdf.open(path)
    try:
        if doc.needs_pass:
            return "locked", 0, [], []
        n = doc.page_count
        if not (doc.permissions & pymupdf.PDF_PERM_COPY):
            return "locked", n, [], []
        pages = []
        edge = collections.Counter()
        for page in doc:
            h, w = page.rect.height, page.rect.width
            lines = []
            d = page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)
            for b in d.get("blocks", []):
                for ln in b.get("lines", []):
                    text = clean("".join(sp["text"] for sp in ln["spans"]))
                    if not text:
                        continue
                    x0, y0, x1, y1 = ln["bbox"]
                    size = max(sp["size"] for sp in ln["spans"])
                    vert = abs(ln["dir"][1]) > 0.5
                    cur = {"t": text, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "size": size, "v": vert}
                    # 直排版的 PDF 常把每個字存成獨立的一「行」，先把同一行（或同一直行）的字接回去
                    prev = lines[-1] if lines else None
                    frag = ln.get("wmode") == 1 or len(text) <= 2
                    if frag and prev and prev.get("w") and abs(prev["size"] - size) < 0.5 * min(prev["size"], size):
                        base = min(prev["size"], size)
                        tol = 0.35 * base
                        gx, gy = x0 - prev["x1"], y0 - prev["y1"]
                        row = abs(y0 - prev["y0"]) < tol and -tol < gx < 2.6 * base and prev.get("m") != "col"
                        col = abs(x0 - prev["x0"]) < tol and -tol < gy < 2.6 * base and prev.get("m") != "row"
                        if row or col:
                            gap = gx if row else gy
                            prev["t"] += (" " if gap > 0.8 * base else "") + text
                            prev["x1"], prev["y1"] = max(prev["x1"], x1), max(prev["y1"], y1)
                            prev["m"] = "row" if row else "col"
                            prev["v"] = not row
                            # 行的字級以字數最多的為準（破折號等符號常是另一個字級）
                            prev["sz"][size] = prev["sz"].get(size, 0) + len(text)
                            prev["size"] = max(prev["sz"], key=prev["sz"].get)
                            continue
                    cur["w"] = frag
                    cur["sz"] = {size: len(text)}
                    lines.append(cur)
            for ln in lines:
                # 頁首、頁尾：靠近頁面邊緣的短行
                near = ln["y1"] < h * 0.09 or ln["y0"] > h * 0.91 or (ln["v"] and (ln["x1"] < w * 0.11 or ln["x0"] > w * 0.89))
                ln["edge"] = near and len(ln["t"]) < 40
                if ln["edge"]:
                    edge[_furniture_key(ln["t"])] += 1
            pages.append(lines)
        furniture = {k for k, c in edge.items() if c >= max(3, n * 0.1)}
        paras, pgs = [], []
        for pno, lines in enumerate(pages, 1):
            body = []
            for ln in lines:
                t = ln["t"]
                if re.fullmatch(r"[\d\s\-–—.·•]{1,6}", t):       # 頁碼、註腳編號
                    continue
                if ln["edge"] and _furniture_key(t) in furniture:   # 每頁重複的頁首、頁尾
                    continue
                body.append(ln)
            if not body:
                continue
            vert = sum(1 for ln in body if ln["v"]) > len(body) / 2
            s, e = ("y0", "y1") if vert else ("x0", "x1")
            long_lines = [ln for ln in body if len(ln["t"]) >= 12] or body
            far = max(ln[e] for ln in long_lines)
            cur, prev = None, None
            for ln in body:
                size = ln["size"]
                new = prev is None
                if not new:
                    short = prev[e] < far - 1.5 * prev["size"]
                    indent = ln[s] - prev[s] > 0.8 * size
                    resize = abs(size - prev["size"]) > 1.5
                    new = short or indent or resize
                if new:
                    if cur:
                        paras.append(cur)
                        pgs.append(pno)
                    cur = ln["t"]
                else:
                    glue = " " if re.search(r"[A-Za-z0-9,.;:]$", cur) and re.match(r"[A-Za-z0-9]", ln["t"]) else ""
                    cur += glue + ln["t"]
                prev = ln
            if cur:
                paras.append(cur)
                pgs.append(pno)
        if sum(len(p) for p in paras) < n * 20:
            return "image", n, [], []
        return "ok", n, paras, pgs
    finally:
        doc.close()


# ---------- 抓取 ----------

PDF_LOCK = threading.Lock()

def fetch_item(item, cat, cache_dir, keep_pdf):
    info = parse_item(get_text(item["url"]), cat)
    rec = {"id": item["id"], "cat": cat, "url": item["url"], **info,
           "state": "", "np": 0, "p": [], "pg": []}
    if info["pdf"]:
        pdf_dir = cache_dir / "pdf"
        pdf_dir.mkdir(parents=True, exist_ok=True)
        path = pdf_dir / (item["id"] + ".pdf")
        path.write_bytes(get(info["pdf"]))
        # PyMuPDF 不能多執行緒同時使用（會讓整個程式直接結束），所以一次只擷取一份
        with PDF_LOCK:
            rec["state"], rec["np"], rec["p"], rec["pg"] = extract_pdf(path)
        # 不能擷取的 PDF 留著也沒有用
        if not keep_pdf or rec["state"] != "ok":
            path.unlink()
    rec["fetched"] = dt.datetime.now().isoformat(timespec="seconds")
    (cache_dir / f"{item['id']}.json").write_text(json.dumps(rec, ensure_ascii=False), "utf-8")
    return rec


def needs_fetch(path):
    """還沒抓過，或上次官網頁面上還沒有 PDF 的書刊（之後可能補上），下次執行時再檢查一次"""
    if not path.exists():
        return True
    try:
        rec = json.loads(path.read_text("utf-8"))
    except ValueError:
        return True
    return rec.get("cat") != "m" and not rec.get("pdf")


def crawl(args, cache_dir):
    todo = []
    for cat in args.only:
        items = list_items(cat)
        new = [it for it in items if args.refresh or needs_fetch(cache_dir / f"{it['id']}.json")]
        print(f"  {CATS[cat][2]}：{len(items)} {CATS[cat][3]}，需下載 {len(new)} {CATS[cat][3]}")
        todo += [(it, cat) for it in new]
        time.sleep(args.sleep)
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        return
    print(f"\n開始下載 {len(todo)} 筆（同時 {args.workers} 個連線；PDF 較大，請耐心等候）…")
    done = fails = 0
    t0 = time.time()

    def job(pair):
        time.sleep(args.sleep)
        return fetch_item(pair[0], pair[1], cache_dir, args.keep_pdf)

    with cf.ThreadPoolExecutor(args.workers) as pool:
        futs = {pool.submit(job, it): it for it in todo}
        for f in cf.as_completed(futs):
            it, cat = futs[f]
            try:
                rec = f.result()
                done += 1
                if rec["state"] == "locked":
                    print(f"  （{rec['title']}：PDF 不允許擷取文字，只收錄官網簡介）")
                elif rec["state"] == "image":
                    print(f"  （{rec['title']}：PDF 沒有文字層，只收錄官網簡介）")
            except Exception as e:  # noqa: BLE001
                fails += 1
                print(f"  失敗 {it['id']}：{e}")
            n = done + fails
            if n % 10 == 0 or n == len(todo):
                print(f"  進度 {n}/{len(todo)}（{(time.time() - t0) / 60:.1f} 分鐘）", flush=True)
    if fails:
        print(f"\n有 {fails} 筆下載失敗，再執行一次會重試。")


def reextract(cache_dir):
    n = 0
    for path in sorted((cache_dir / "pdf").glob("*.pdf")):
        meta = cache_dir / (path.stem + ".json")
        if not meta.exists():
            continue
        rec = json.loads(meta.read_text("utf-8"))
        rec["state"], rec["np"], rec["p"], rec["pg"] = extract_pdf(path)
        meta.write_text(json.dumps(rec, ensure_ascii=False), "utf-8")
        n += 1
    print(f"重新擷取 {n} 個 PDF。")


# ---------- 建立索引 ----------

def sort_key(rec):
    m = re.search(r"(\d+)$", rec["id"])
    return int(m.group(1)) if m else 0


def build(data_dir, cache_dir):
    by_cat = collections.defaultdict(list)
    for p in cache_dir.glob("*.json"):
        rec = json.loads(p.read_text("utf-8"))
        by_cat[rec["cat"]].append(rec)

    out_dir = data_dir / "books"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.js"):
        old.unlink()

    series = []
    for cat, (list_path, code, name, unit) in CATS.items():
        recs = sorted(by_cat.get(cat, []), key=sort_key, reverse=(cat == "e"))
        if not recs:
            continue
        eps, full, locked = [], 0, 0
        for r in recs:
            intro = [x for x in r.get("intro", []) if x]
            paras = intro + r.get("p", [])
            item = {"id": r["id"], "ep": r.get("ep", ""), "t": r["title"], "who": r.get("who", ""),
                    "date": r.get("date", ""), "url": r["url"], "p": paras,
                    "pg": [0] * len(intro) + r.get("pg", [])}
            if r.get("pdf"):
                item["pdf"] = r["pdf"]
            if r.get("np"):
                item["np"] = r["np"]
            if r.get("state") == "ok":
                full += 1
            elif r.get("state") in ("locked", "image"):
                item["lock"] = r["state"]
                locked += 1
            if r.get("links"):
                item["links"] = r["links"]
            eps.append(item)
        # 分成幾個檔案，網頁才能邊載入邊顯示進度
        files, chunk, size = [], [], 0

        def flush():
            nonlocal chunk, size
            if not chunk:
                return
            fn = f"{code}_{len(files) + 1:02d}.js"
            (out_dir / fn).write_text(
                "// 由 tools/build_books.py 自動產生\nwindow.ENL_ADD(" +
                json.dumps({"code": code, "episodes": chunk}, ensure_ascii=False, separators=(",", ":")) + ");\n", "utf-8")
            files.append(f"data/books/{fn}")
            chunk, size = [], 0

        chars = 0
        for it in eps:
            n = sum(len(x) for x in it["p"])
            chars += n
            if chunk and size + n > CHUNK_CHARS:
                flush()
            chunk.append(it)
            size += n
        flush()
        series.append({"code": code, "name": name, "cat": "books", "catName": "正智書香園地", "kind": "doc", "unit": unit,
                       "count": len(eps), "chars": chars, "full": full, "locked": locked,
                       "url": BASE + list_path, "files": files})
        print(f"  {name}：{len(eps)} {unit}，其中 {full} {unit}有 PDF 全文、{locked} {unit}的 PDF 不能擷取；共 {chars / 10000:.0f} 萬字")

    cat_js = {"site": BASE + f"/{LANG}/", "generated": dt.datetime.now().isoformat(timespec="minutes"), "series": series}
    (data_dir / "books_catalog.js").write_text(
        "// 由 tools/build_books.py 自動產生\nwindow.ENL_BOOKS = " +
        json.dumps(cat_js, ensure_ascii=False, separators=(",", ":")) + ";\n", "utf-8")
    size = sum(p.stat().st_size for p in out_dir.glob("*.js")) / 1024 / 1024
    print(f"\n書刊索引完成：{sum(s['count'] for s in series)} 筆（{size:.1f} MB）")


def main():
    p = argparse.ArgumentParser(description="抓取正智書香園地的贈閱書籍、電子報、影音資料並建立搜尋索引")
    p.add_argument("--only", nargs="+", choices=list(CATS), default=list(CATS), help="只抓這些類別：g 贈閱書籍、e 電子報、m 影音")
    p.add_argument("--limit", type=int, default=0, help="這次最多下載幾筆")
    p.add_argument("--workers", type=int, default=3, help="同時下載的連線數")
    p.add_argument("--sleep", type=float, default=0.3, help="每個請求前暫停秒數")
    p.add_argument("--refresh", action="store_true", help="全部重新下載")
    p.add_argument("--build-only", action="store_true", help="不連網，只重建索引")
    p.add_argument("--reextract", action="store_true", help="不連網，用留下來的 PDF 重新擷取文字")
    p.add_argument("--keep-pdf", action="store_true", help="擷取文字後保留 PDF")
    p.add_argument("--cache-dir", default=str(ROOT / "cache" / "books"), help=argparse.SUPPRESS)
    p.add_argument("--data-dir", default=str(ROOT / "data"), help=argparse.SUPPRESS)
    args = p.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    try:
        import pymupdf  # noqa: F401
    except ImportError:
        print("需要先安裝讀 PDF 用的套件 PyMuPDF，請執行：\n    python -m pip install pymupdf")
        return 1

    cache_dir, data_dir = Path(args.cache_dir), Path(args.data_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    if args.reextract:
        reextract(cache_dir)
    elif not args.build_only:
        try:
            crawl(args, cache_dir)
        except KeyboardInterrupt:
            print("\n已中斷，先用目前下載好的資料建立索引。")
    build(data_dir, cache_dir)
    print("更新完成。搜尋網頁已經開著的話，請按 F5 重新整理。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
