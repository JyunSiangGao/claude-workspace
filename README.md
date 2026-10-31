# 學佛影片字幕搜尋

搜尋 YouTube 頻道 [@enlightenvideo](https://www.youtube.com/@enlightenvideo) 所有影片的字幕。輸入名詞（例如「般若」「阿賴耶識」），就會列出：

- 哪些影片提到這個名詞，每部影片出現幾次
- 出現在第幾分幾秒，以及前後文；點時間就從那裡開始播放
- 每部影片的時間軸，看出名詞集中在影片的哪一段
- 名詞說明、同義詞（例如「四聖諦／四諦／苦集滅道」一起搜尋）
- 經常和它一起出現的其他名詞
- 結果可以下載成 CSV（Excel 可開）

所有搜尋都在瀏覽器裡進行，不需要伺服器。

## 第一次使用

需要 Python 3.9 以上。在這個資料夾打開終端機：

```bash
pip install -r tools/requirements.txt
```

先試抓 5 部影片，確認能正常運作：

```bash
python tools/build_index.py --limit 5
```

沒問題的話，抓整個頻道（影片多的話要一段時間，可以隨時按 Ctrl+C 中斷，下次會接著抓）：

```bash
python tools/build_index.py
```

完成後用瀏覽器打開 `index.html` 就能搜尋。

## 之後更新

頻道有新影片時，再執行一次就好，只會抓新的影片：

```bash
python tools/build_index.py
```

## 常見問題

**出現「Sign in to confirm you're not a bot」或 429 錯誤**：YouTube 暫時限制了下載。稍後再跑，或讓腳本使用你瀏覽器的登入狀態（先在該瀏覽器登入 YouTube）：

```bash
python tools/build_index.py --cookies-from-browser chrome
```

也可以把 `chrome` 換成 `firefox`、`edge`、`safari`。另外記得更新 yt-dlp（`pip install -U yt-dlp`），YouTube 常改版。

**有些影片顯示「無字幕」**：該影片沒有任何字幕（包含自動字幕），只能搜尋標題和影片說明。之後 YouTube 補上自動字幕時，可以用 `--retry` 重抓：

```bash
python tools/build_index.py --retry
```

**搜尋不到明明有講的詞**：字幕多半是 YouTube 自動辨識，常把佛學名詞辨識成同音字。可以試試較短的詞，或把常見錯字加進名詞表的同義詞。

**點時間後影片沒有在頁面內播放**：直接雙擊打開 `index.html` 時，YouTube 內嵌播放器常無法使用，所以預設會到 YouTube 開啟。放到網站上（例如 GitHub Pages）就能在頁面內播放。

## 增修名詞說明

編輯 `data/glossary.js`，每個名詞一筆：

```js
{ term: "阿賴耶識", aliases: ["第八識", "藏識"], desc: "唯識學所說的第八識……" },
```

- `term`：主要名詞
- `aliases`：同義詞、別名、常見錯字（勾選「含同義詞」時會一起搜尋）。請避免只有一個字的詞。
- `desc`：顯示在搜尋結果上方的說明

## 檔案說明

| 檔案 | 用途 |
| --- | --- |
| `index.html`、`assets/` | 搜尋網頁 |
| `data/index.js` | 搜尋索引（由腳本產生；目前是示範資料） |
| `data/subs/` | 每部影片下載下來的字幕（腳本的暫存，重建索引用） |
| `data/glossary.js` | 名詞說明與同義詞 |
| `tools/build_index.py` | 下載字幕、建立索引的腳本 |

`build_index.py` 其他選項可用 `python tools/build_index.py --help` 查看，例如 `--build-only`（不連網，只重建索引）、`--no-convert`（不要把簡體字幕轉成繁體）。
