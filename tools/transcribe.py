#!/usr/bin/env python3
"""
用語音辨識替「官網只有影片、沒有文字稿」的節目（法義辨正）產生文字稿。

官網這些節目有 mp3，所以做法是：下載 mp3 → 用 faster-whisper 辨識 → 存成 data/asr/<節目代號>.json
（每一句附開始時間）。之後執行 tools/build_index.py --build-only，就會把這些文字納入搜尋。

需要另外安裝的環境（不在一般的 Python 裡，放在 D:\\whisper-asr）：
    D:\\whisper-asr\\venv\\Scripts\\python.exe tools\\transcribe.py            # 辨識全部還沒做的節目
    D:\\whisper-asr\\venv\\Scripts\\python.exe tools\\transcribe.py --series b01
    D:\\whisper-asr\\venv\\Scripts\\python.exe tools\\transcribe.py --only 2196-b01_001 --max-seconds 120   # 試跑

可以隨時按 Ctrl+C 中斷，下次會從還沒做完的那一集繼續（做完的不會重做）。
辨識出來的文字一定會有錯字（尤其是佛學名詞、同音字），網頁上會標示「語音辨識」。
"""
import argparse
import datetime as dt
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path(r"D:\whisper-asr")          # 模型放這裡（路徑不含中文，避免辨識程式讀不到）
UA = "Mozilla/5.0 (personal subtitle search index; +https://video.enlighten.org.tw)"

# 給模型的提示：讓它輸出繁體中文、加標點，並先看過常見的佛學名詞
PROMPT = ("以下是正覺教團弘法節目的繁體中文逐字稿，內容是佛法的法義辨正。"
          "各位菩薩，阿彌陀佛！常見名詞：如來藏、阿賴耶識、第八識、真如、佛性、明心、見性、開悟、初地、"
          "七住位、般若、涅槃、禪宗、宗門、教門、六祖壇經、公案、祖師、意識、離念靈知、五蘊、十八界、"
          "聲聞、緣覺、菩薩、阿羅漢、平實導師、同修會、欲界、色界、無色界、欲界愛、身行、口行、意行、"
          "五戒、十善、業種、果報、餓鬼道、畜生道、八難、解脫道、佛菩提道。")

# 模型常吐出半形標點，統一成全形
_HALF = str.maketrans({",": "，", "?": "？", "!": "！", ":": "：", ";": "；"})


def log(msg):
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def download(url, dest):
    """下載 mp3（先寫到 .part，完成後才改名，中斷不會留下壞檔）"""
    if dest.exists() and dest.stat().st_size > 0:
        return
    tmp = dest.with_suffix(".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(dest)


def add_cuda_dlls():
    """讓程式找得到用 pip 裝的 NVIDIA 函式庫（nvidia-cublas-cu12、nvidia-cudnn-cu12）。
    回傳有沒有找到；沒找到就不能用顯示卡。"""
    import os
    import site
    found = False
    for sp in site.getsitepackages():
        for sub in ("cublas", "cudnn", "cuda_nvrtc"):
            d = Path(sp) / "nvidia" / sub / "bin"
            if d.exists():
                os.add_dll_directory(str(d))
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
                found = found or sub == "cublas"
    return found


def decode_audio(path, max_seconds=0, skip_seconds=0):
    """解碼成 16kHz 單聲道；試跑時可以只取中間一段（skip_seconds 之後的 max_seconds 秒）。"""
    if skip_seconds and max_seconds:
        return _decode(path, skip_seconds + max_seconds)[int(skip_seconds * 16000):]
    return _decode(path, max_seconds)


def _decode(path, max_seconds=0):
    """把 mp3 解碼成 16kHz 單聲道（自己解碼，不靠 faster-whisper 內建的，因為它和新版 PyAV 不相容；
    用檔案物件開啟，路徑裡有中文也沒問題）。"""
    import av
    import numpy as np
    chunks, n = [], 0
    with open(path, "rb") as f, av.open(f, mode="r") as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                a = out.to_ndarray().reshape(-1)
                chunks.append(a)
                n += len(a)
            if max_seconds and n >= max_seconds * 16000:
                break
        else:
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
    audio = np.concatenate(chunks).astype(np.float32) / 32768.0
    return audio[: int(max_seconds * 16000)] if max_seconds else audio


def pending(cache_dir, out_dir, series, only):
    todo = []
    for p in sorted(cache_dir.glob("*.json")):
        if p.name.startswith("_"):
            continue
        rec = json.loads(p.read_text("utf-8"))
        if only and rec["slug"] not in only:
            continue
        if series and rec["series"] not in series:
            continue
        if rec.get("paras") or not rec.get("mp3"):      # 官網已有文字稿，或沒有 mp3 可用
            continue
        if (out_dir / f"{rec['slug']}.json").exists() and not only:
            continue
        todo.append(rec)
    return todo


def main():
    p = argparse.ArgumentParser(description="用語音辨識替沒有文字稿的節目產生文字稿")
    p.add_argument("--series", nargs="+", help="只做這些系列，例如 b01 b02")
    p.add_argument("--only", nargs="+", help="只做這些節目（節目代號），會重做")
    p.add_argument("--model", default="large-v3-turbo", help="辨識模型（預設 large-v3-turbo）")
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument("--compute-type", default="", help="預設 CPU 用 int8、顯示卡用 int8_float32")
    p.add_argument("--threads", type=int, default=0, help="CPU 用幾個執行緒（預設自動）")
    p.add_argument("--beam", type=int, default=5)
    p.add_argument("--max-seconds", type=float, default=0, help="每集只辨識開頭幾秒（試跑用，不會存成正式結果）")
    p.add_argument("--skip-seconds", type=float, default=0, help="試跑時從第幾秒開始（要和 --max-seconds 一起用）")
    p.add_argument("--keep-audio", action="store_true", help="辨識完保留 mp3（預設刪除以節省空間）")
    args = p.parse_args()

    cache_dir, out_dir, audio_dir = ROOT / "cache", ROOT / "data" / "asr", ROOT / "cache" / "audio"
    if not cache_dir.exists():
        print("找不到 cache/，請先執行一次 更新資料.bat（或 python tools/build_index.py）。")
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    todo = pending(cache_dir, out_dir, args.series, args.only)
    if not todo:
        print("沒有需要辨識的節目（都做完了，或官網已經有文字稿）。")
        return 0
    total_sec = sum(r.get("dur", 0) for r in todo)
    log(f"要辨識 {len(todo)} 集，共約 {total_sec / 3600:.1f} 小時的聲音。")

    from faster_whisper import WhisperModel

    has_dlls = add_cuda_dlls()
    device = args.device
    if device == "auto":
        import ctranslate2
        device = "cuda" if has_dlls and ctranslate2.get_cuda_device_count() else "cpu"

    def load(dev):
        ctype = args.compute_type or ("int8" if dev == "cpu" else "int8_float32")
        log(f"載入模型 {args.model}（{'顯示卡' if dev == 'cuda' else 'CPU'}，{ctype}）；第一次會先下載模型…")
        return WhisperModel(args.model, device=dev, compute_type=ctype, cpu_threads=args.threads,
                            download_root=str(HOME / "models"))

    try:
        model = load(device)
    except Exception as e:  # noqa: BLE001
        if device != "cuda":
            raise
        log(f"顯示卡不能用（{e}），改用 CPU。")
        device = "cpu"
        model = load(device)

    # 模型偶爾還是會吐出簡體字，存檔前一律轉成繁體（沒裝 opencc 就不轉）
    try:
        from opencc import OpenCC
        to_trad = OpenCC("s2t").convert
    except Exception:  # noqa: BLE001
        log("沒有安裝 opencc-python-reimplemented，辨識結果裡的簡體字不會自動轉成繁體。")
        to_trad = lambda s: s  # noqa: E731

    def run(audio):
        it, info = model.transcribe(
            # 提示詞用 hotwords 給：initial_prompt 只對開頭 30 秒有效，後面會慢慢變成簡體字、
            # 佛學名詞也認不出來；hotwords 則是每一段都會帶著。
            audio, language="zh", beam_size=args.beam, hotwords=PROMPT,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 700},
            condition_on_previous_text=False,       # 避免一段辨識錯了，後面跟著一直重複
        )
        out, last = [], time.time()
        for s in it:
            text = to_trad(s.text.strip()).translate(_HALF)
            if text:
                out.append({"s": round(s.start, 2), "e": round(s.end, 2), "t": text})
            if time.time() - last > 120:   # 每兩分鐘回報一次進度
                last = time.time()
                log(f"    …辨識到 {s.end / 60:.0f} 分 / {info.duration / 60:.0f} 分")
        return out, info

    done_sec, t_all = 0.0, time.time()
    for n, rec in enumerate(todo, 1):
        slug = rec["slug"]
        mp3 = audio_dir / f"{slug}.mp3"
        try:
            download(rec["mp3"], mp3)
        except Exception as e:  # noqa: BLE001
            log(f"{slug} 下載失敗：{e}（略過，下次再試）")
            continue
        log(f"({n}/{len(todo)}) {rec['series']} {rec.get('ep', '')} {rec['title']}（{rec.get('dur', 0) / 60:.0f} 分鐘）")
        t0 = time.time()
        segs = []
        try:
            audio = decode_audio(mp3, args.max_seconds, args.skip_seconds)
        except Exception as e:  # noqa: BLE001
            log(f"{slug} 的 mp3 讀不出來：{e}（略過；已刪除下載的檔案，下次會重新下載）")
            mp3.unlink(missing_ok=True)
            continue
        try:
            segs, info = run(audio)
        except RuntimeError as e:
            if device != "cuda":
                raise
            # 顯示卡記憶體不夠或驅動有問題：這一集改用 CPU 重做，之後也都用 CPU
            log(f"    顯示卡辨識失敗（{e}），改用 CPU 重做這一集。")
            device = "cpu"
            model = load(device)
            t0 = time.time()
            segs, info = run(audio)
        del audio
        el = time.time() - t0
        audio_sec = args.max_seconds or info.duration
        speed = audio_sec / el if el else 0
        result = {"slug": slug, "model": args.model, "dur": round(info.duration, 1),
                  "made": dt.datetime.now().isoformat(timespec="seconds"), "segments": segs}
        if args.max_seconds:
            # 試跑：印出來看看，不存成正式結果
            test = HOME / f"test_{slug}.json"
            test.write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf-8")
            log(f"試跑完成：{audio_sec:.0f} 秒的聲音花了 {el:.0f} 秒（{speed:.1f} 倍速），結果在 {test}")
            continue
        tmp = out_dir / f"{slug}.json.part"
        tmp.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), "utf-8")
        tmp.replace(out_dir / f"{slug}.json")
        if not args.keep_audio:
            mp3.unlink(missing_ok=True)
        done_sec += info.duration
        left = total_sec - done_sec
        rate = done_sec / (time.time() - t_all)
        log(f"    完成，{len(segs)} 句，花了 {el / 60:.1f} 分鐘（{speed:.1f} 倍速）；"
            f"剩下約 {left / 3600:.1f} 小時的聲音，預估還要 {left / rate / 3600:.1f} 小時")
    log("全部完成。接著執行 python tools/build_index.py --build-only 把文字納入搜尋。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中斷。做完的節目已經存好，下次執行會從還沒做的繼續。")
        sys.exit(130)
