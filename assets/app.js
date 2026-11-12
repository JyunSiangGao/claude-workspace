(function () {
  'use strict';

  var CATALOG = window.ENL_CATALOG || null;
  // 書刊（正智書香園地的電子報、贈閱書籍、影音），由 tools/build_books.py 產生；沒有這份資料時只搜尋影片
  var BOOKS = window.ENL_BOOKS && window.ENL_BOOKS.series && window.ENL_BOOKS.series.length ? window.ENL_BOOKS : null;
  var ALL_SERIES = ((CATALOG && CATALOG.series) || []).concat(BOOKS ? BOOKS.series : []);
  // 沒有書刊資料時（例如公開分享的版本），把頁首與頁尾提到書刊的文字藏起來
  if (!BOOKS) Array.prototype.forEach.call(document.querySelectorAll('.books-only'), function (el) { el.hidden = true; });
  var DEFS = window.DEFINITIONS || {};
  var SUMS = window.SUMMARIES || {};
  var GLOSSARY = window.GLOSSARY || [];
  var SITE = (CATALOG && CATALOG.site) || 'https://video.enlighten.org.tw/zh-tw/';
  var PAGE = 20;          // 每次顯示幾集（詳細模式）
  var PAGE_COMPACT = 60;  // 每次顯示幾集（精簡模式）
  var SHOW_HITS = 3;      // 每集預設顯示幾個段落
  var HEAT_MIN = 24;      // 一集超過幾處時，時間軸改用濃淡色條
  var HEAT_BINS = 48;     // 色條分成幾格
  var SEEK_STEP = 15;     // 播放器的「−15 秒／＋15 秒」
  var CONTEXT = 45;       // 片段前後顯示幾個字
  var CLUSTER_GAP = 30;   // 相距幾個字內的命中合併成同一列
  var CLUSTER_MAX = 110;  // 合併後一列最長幾個字
  var RELATED_WIN = 150;  // 找相關名詞時看前後幾個字
  var PLAY_EARLY = 15;    // 時間是估算的，播放時提早幾秒開始

  var $ = function (id) { return document.getElementById(id); };
  var norm = function (s) { return (s || '').toLowerCase().replace(/\s+/g, ''); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function fmtDur(sec) {
    if (!sec) return '';
    var h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60);
    return h ? h + ' 小時 ' + m + ' 分' : m + ' 分鐘';
  }
  function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? m[1] + ' 年 ' + (+m[2]) + ' 月 ' + (+m[3]) + ' 日' : (s || '未知');
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }
  var ytUrl = function (yt, t) { return 'https://www.youtube.com/watch?v=' + yt + (t ? '&t=' + Math.floor(t) + 's' : ''); };
  // 官網網址帶有分類：a「三乘菩提」、b「法義辨正」
  var catOf = function (code) { return (seriesByCode[code] || {}).cat || 'a'; };
  var pageUrl = function (e) { return e.url || (SITE + catOf(e.series) + '/' + e.series + '/' + e.id); };
  var pageLabel = function (e) { return e.text && !e.doc && !e.asr ? '文字稿' : '官網頁面'; };   // 有些節目官網只有影片
  // 書刊：命中的位置用 PDF 頁碼表示；頁碼 0 代表官網頁面上的簡介
  var docUrl = function (e, page) { return page && e.pdf ? e.pdf + '#page=' + page : pageUrl(e); };
  var pageText = function (page) { return page ? '第 ' + page + ' 頁' : '官網簡介'; };
  var epLabel = function (e) { return e.doc ? (e.ep ? '第 ' + e.ep + ' ' + e.unit : '') : '第 ' + e.ep + ' 集'; };
  function seriesLabel(v) {
    return v === '@video' ? '影片節目' : v === '@doc' ? '書刊' : (seriesByCode[v] || {}).name || v;
  }

  // ---------- 載入資料 ----------
  var episodes = [];
  var epById = {};
  var seriesByCode = {};
  var loaded = false;

  window.ENL_ADD = function (data) {
    var s = seriesByCode[data.code] || { code: data.code, name: data.code };
    var doc = s.kind === 'doc';
    data.episodes.forEach(function (e) {
      var text = '', paraPos = [], pg = doc ? [] : null, lead = '';
      var pt = e.pt ? [] : null;   // 語音辨識的節目：每段開始的實際秒數
      (e.p || []).forEach(function (p, i) {
        var n = norm(p);
        if (!n) return;
        paraPos.push(text.length);
        if (pt) pt.push(e.pt[i] || 0);
        text += n;
        if (doc) {
          var page = (e.pg && e.pg[i]) || 0;
          pg.push(page);
          // 官網簡介中第一段像句子的文字，節目瀏覽時顯示
          if (!lead && !page && p.length >= 30) lead = p.length > 150 ? p.slice(0, 150) + '…' : p;
        }
      });
      var item = {
        id: e.id, series: data.code, seriesName: s.name, ep: e.ep || '', title: e.t || '', who: e.who || '',
        yt: e.yt || '', dur: e.dur || 0, durEst: !!e.durEst, text: text, paraPos: paraPos, titleN: norm(e.t),
        sum: SUMS[e.id] || null,
        sumN: SUMS[e.id] ? norm(SUMS[e.id].s + (SUMS[e.id].p || []).join('') + (SUMS[e.id].k || []).join('')) : ''
      };
      if (doc) {
        item.doc = true; item.unit = s.unit || '筆'; item.pg = pg; item.lead = lead;
        item.url = e.url || ''; item.pdf = e.pdf || ''; item.np = e.np || 0; item.lock = e.lock || '';
        item.date = e.date || ''; item.links = e.links || null;
      }
      if (pt) { item.pt = pt; item.asr = !!e.asr; }
      episodes.push(item);
      epById[item.id] = item;
    });
  };

  // 書刊資料比較大，影片的文字稿載完、可以開始搜尋之後才在背景載入
  function loadBooks(done) {
    var files = [];
    BOOKS.series.forEach(function (s) { (s.files || []).forEach(function (f) { files.push(f); }); });
    var total = files.length, n = 0, note = $('booksNote');
    if (!total) { done(); return; }
    note.hidden = false;
    function next() {
      var f = files.shift();
      if (!f) return;
      var tag = document.createElement('script');
      tag.src = f;
      tag.onload = tag.onerror = function () {
        n++;
        note.textContent = '已經可以搜尋影片節目；書刊資料載入中（' + n + ' / ' + total + '）…';
        if (n === total) { note.hidden = true; done(); } else next();
      };
      document.head.appendChild(tag);
    }
    note.textContent = '已經可以搜尋影片節目；書刊資料載入中…';
    next(); next();
  }

  function loadAll(done) {
    var list = CATALOG.series.slice();
    var total = list.length, n = 0, failed = [];
    var bar = $('loadBar'), label = $('loadLabel');
    $('loading').hidden = false;
    // 同時載入 3 個檔案
    function next() {
      var s = list.shift();
      if (!s) return;
      var tag = document.createElement('script');
      tag.src = s.file;
      tag.onload = tag.onerror = function (ev) {
        if (ev.type === 'error') failed.push(s.name);
        n++;
        bar.style.width = (n / total * 100) + '%';
        label.textContent = '正在載入文字稿 ' + n + ' / ' + total + ' 個系列…';
        if (n === total) {
          $('loading').hidden = true;
          if (failed.length) alert('有 ' + failed.length + ' 個系列載入失敗：' + failed.join('、'));
          done();
        } else next();
      };
      document.head.appendChild(tag);
    }
    next(); next(); next();
  }

  var glossIndex = {};
  GLOSSARY.forEach(function (g) {
    g.variants = [g.term].concat(g.aliases || []).map(norm).filter(Boolean);
    g.variants.forEach(function (k) { if (!glossIndex[k]) glossIndex[k] = g; });
  });

  function paraAt(e, pos) {
    var a = e.paraPos, lo = 0, hi = a.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (a[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  // 估算時間：文字在全文中的位置比例 × 節目長度
  function timeAt(e, pos) {
    if (e.pt && e.pt.length) {
      // 語音辨識的節目每段都有實際時間：從該段的開始時間，依這個字在段落中的位置往後推
      var i = paraAt(e, pos), a = e.paraPos[i], b = i + 1 < e.paraPos.length ? e.paraPos[i + 1] : e.text.length;
      var t0 = e.pt[i], t1 = i + 1 < e.pt.length ? e.pt[i + 1] : Math.max(t0, e.dur || t0);
      t1 = Math.min(t1, t0 + (b - a) * 0.45);   // 段落之間的停頓不算在內
      return t0 + (t1 - t0) * (b > a ? (pos - a) / (b - a) : 0);
    }
    return e.dur && e.text.length ? e.dur * pos / e.text.length : 0;
  }
  // 播放時提早幾秒開始：估算的時間提早多一點，實際時間只要一點點
  var leadOf = function (e) { return e.pt ? 4 : PLAY_EARLY; };

  // ---------- 搜尋 ----------
  function parseQuery(q, useSyn) {
    var seen = {};
    return q.split(/[\s,，、;；]+/).map(norm).filter(function (t) {
      if (!t || seen[t]) return false;
      return (seen[t] = true);
    }).slice(0, 4).map(function (t) {
      var entry = glossIndex[t] || null;
      var variants = [t];
      if (useSyn && entry) entry.variants.forEach(function (x) { if (variants.indexOf(x) < 0) variants.push(x); });
      variants.sort(function (a, b) { return b.length - a.length; }); // 長詞先比對，避免重複計算
      return { term: t, entry: entry, variants: variants };
    }).filter(function (g, i, all) {
      // 勾選相關詞時，同一個名詞的不同寫法只算一次（例如「阿賴耶識 第八識」）
      return !(useSyn && g.entry && all.slice(0, i).some(function (x) { return x.entry === g.entry; }));
    });
  }

  function search(groups, mode, seriesFilter, whoFilter) {
    var results = [];
    var totals = groups.map(function () { return { hits: 0, eps: 0, byVariant: {} }; });
    var bySeries = {};

    episodes.forEach(function (e) {
      if (seriesFilter === '@video' ? e.doc : seriesFilter === '@doc' ? !e.doc : (seriesFilter && e.series !== seriesFilter)) return;
      if (whoFilter && e.who !== whoFilter) return;
      var hits = [], counts = [], inTitle = [], inSum = [], ok = [], byV = [];
      groups.forEach(function (g, gi) {
        var taken = [], n = 0, bv = {};
        byV.push(bv);
        g.variants.forEach(function (needle) {
          var i = e.text.indexOf(needle);
          while (i !== -1) {
            var end = i + needle.length;
            if (!taken.some(function (r) { return i < r[1] && end > r[0]; })) {
              taken.push([i, end]);
              hits.push({ pos: i, end: end, g: gi });
              n++;
              bv[needle] = (bv[needle] || 0) + 1;
            }
            i = e.text.indexOf(needle, end);
          }
        });
        counts.push(n);
        var t = g.variants.some(function (x) { return e.titleN.indexOf(x) >= 0; });
        var sm = !!e.sumN && g.variants.some(function (x) { return e.sumN.indexOf(x) >= 0; });
        inTitle.push(t);
        inSum.push(sm);
        ok.push(n > 0 || t || sm);
      });
      if (!(mode === 'or' ? ok.some(Boolean) : ok.every(Boolean))) return;
      hits.sort(function (a, b) { return a.pos - b.pos; });
      var total = 0;
      counts.forEach(function (n, gi) {
        total += n;
        totals[gi].hits += n;
        if (n) totals[gi].eps++;
        Object.keys(byV[gi]).forEach(function (k) { totals[gi].byVariant[k] = (totals[gi].byVariant[k] || 0) + byV[gi][k]; });
      });
      var bs = bySeries[e.series] || (bySeries[e.series] = { code: e.series, name: e.seriesName, hits: 0, eps: 0 });
      bs.hits += total; bs.eps++;
      results.push({ e: e, hits: hits, counts: counts, total: total, inTitle: inTitle, inSum: inSum, clusters: null });
    });
    return { results: results, totals: totals, bySeries: bySeries };
  }

  function clusterHits(r) {
    if (r.clusters) return r.clusters;
    var out = [], cur = null;
    r.hits.forEach(function (h) {
      var p = paraAt(r.e, h.pos);
      if (cur && cur.para === p && h.pos - cur.end <= CLUSTER_GAP && h.end - cur.start <= CLUSTER_MAX) {
        cur.hits.push(h);
        cur.end = Math.max(cur.end, h.end);
      } else {
        cur = { start: h.pos, end: h.end, hits: [h], para: p, time: timeAt(r.e, h.pos), page: r.e.pg ? r.e.pg[p] || 0 : 0 };
        out.push(cur);
      }
    });
    return (r.clusters = out);
  }

  function markRange(r, from, to) {
    var e = r.e, html = '', p = from;
    r.hits.forEach(function (h) {
      if (h.pos < p || h.end > to) return;
      html += esc(e.text.slice(p, h.pos)) + '<mark class="m' + h.g + '">' + esc(e.text.slice(h.pos, h.end)) + '</mark>';
      p = h.end;
    });
    return html + esc(e.text.slice(p, to));
  }
  function paraRange(e, i) { return [e.paraPos[i], i + 1 < e.paraPos.length ? e.paraPos[i + 1] : e.text.length]; }
  function snippetHtml(r, c) {
    var pr = paraRange(r.e, c.para);
    var from = Math.max(pr[0], c.start - CONTEXT), to = Math.min(pr[1], c.end + CONTEXT);
    return (from > pr[0] ? '…' : '') + markRange(r, from, to) + (to < pr[1] ? '…' : '');
  }
  function paragraphHtml(r, c) {
    var pr = paraRange(r.e, c.para);
    return markRange(r, pr[0], pr[1]);
  }

  function relatedTerms(results, groups) {
    var skip = {};
    groups.forEach(function (g) { if (g.entry) skip[g.entry.term] = true; g.variants.forEach(function (x) { skip[x] = true; }); });
    var cand = GLOSSARY.filter(function (g) { return !skip[g.term] && !g.variants.some(function (x) { return skip[x]; }); });
    var score = {}, budget = 4000;
    results.forEach(function (r) {
      clusterHits(r).forEach(function (c) {
        if (budget-- <= 0) return;
        var win = r.e.text.slice(Math.max(0, c.start - RELATED_WIN), c.end + RELATED_WIN);
        cand.forEach(function (g) {
          if (g.variants.some(function (x) { return win.indexOf(x) >= 0; })) score[g.term] = (score[g.term] || 0) + 1;
        });
      });
    });
    return Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }).slice(0, 12)
      .map(function (k) { return { term: k, n: score[k] }; });
  }

  // ---------- 畫面 ----------
  var state = { groups: [], results: [], shown: 0, query: '', view: store('view') === 'compact' ? 'compact' : 'detail' };
  var opt = {
    syn: $('optSyn'), mode: $('optMode'), sort: $('optSort'), play: $('optPlay'),
    series: $('optSeries'), who: $('optWho')
  };

  function sortResults() {
    var s = opt.sort.value;
    var order = function (a, b) { return a.e.series.localeCompare(b.e.series) || a.e.ep.localeCompare(b.e.ep, undefined, { numeric: true }); };
    state.results.sort(function (a, b) {
      if (s === 'series') return order(a, b);
      var bonus = function (r) { return (r.inTitle.some(Boolean) ? 0.5 : 0) + (r.inSum.some(Boolean) ? 0.3 : 0); };
      var ta = a.total + bonus(a), tb = b.total + bonus(b);
      return tb - ta || order(a, b);
    });
  }

  // ---------- 切換畫面、網址（讓瀏覽器的「上一頁」可以用） ----------
  var VIEWS = ['home', 'results', 'dict', 'browse'];
  var layoutEl = document.querySelector('.layout');
  var isNarrow = function () { return window.matchMedia('(max-width: 960px)').matches; };
  // 右欄：有播放器或搜尋結果的說明時才出現
  function syncSide() {
    var hasPlayer = !$('player').hidden, hasInfo = !$('rinfo').hidden;
    $('side').hidden = !(hasPlayer || hasInfo);
    layoutEl.classList.toggle('has-side', hasPlayer || hasInfo);
    layoutEl.classList.toggle('with-player', hasPlayer);
  }
  function showView(name) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== name; });
    $('browseBtn').classList.toggle('on', name === 'browse');
    $('dictBtn').classList.toggle('on', name === 'dict');
    $('rinfo').hidden = !(name === 'results' && (state.results.length || state.groups.some(function (g) { return g.entry; })));
    syncSide();
  }
  var pushNext = false;
  // 使用者主動切換畫面（按搜尋、點名詞、點選單）時，留下一筆瀏覽紀錄
  function nav(fn) { pushNext = true; try { fn(); } finally { pushNext = false; } }
  function setUrl(hash) {
    var cur = location.hash.replace(/^#/, '');
    if (cur === hash) return;
    var push = pushNext || (/^q=/.test(hash) && !/^q=/.test(cur));
    try { history[push ? 'pushState' : 'replaceState'](null, '', hash ? '#' + hash : location.pathname + location.search); } catch (e) { /* file:// */ }
  }
  function route() {
    var h = location.hash, m = h.match(/q=([^&]*)/), bm = h.match(/^#browse=?(\w*)/);
    if (m) {
      var q = m[1];
      try { q = decodeURIComponent(q); } catch (e) { /* 網址不完整時照原樣搜尋 */ }
      runSearch(q);
    } else if (bm) showBrowse(bm[1]);
    else if (/^#dict/.test(h)) showDict();
    else runSearch('');
  }

  function runSearch(q) {
    q = (q || '').trim();
    state.query = q;
    // 打字到一半時不要改動輸入框（否則詞與詞之間剛打的空格會被吃掉）
    if ($('q').value.trim() !== q) $('q').value = q;
    setUrl(q ? 'q=' + encodeURIComponent(q) : '');
    if (!loaded) return;
    if (!q) { showHome(); return; }

    var groups = parseQuery(q, opt.syn.checked);
    var res = search(groups, opt.mode.value, opt.series.value, opt.who.value);
    state.groups = groups;
    state.results = res.results;
    sortResults();

    showView('results');
    renderSummary(groups, res);
    renderGlossary(groups);
    renderRelated(res.results, groups);
    $('list').innerHTML = '';
    state.shown = 0;
    renderMore();
  }

  function renderSummary(groups, res) {
    var el = $('summary'), results = res.results;
    var mixed = results.some(function (r) { return r.e.doc; });   // 結果裡有書刊時，單位改用「筆」
    var U = mixed ? '筆' : '集';
    var scope = opt.series.value ? '「' + esc(seriesLabel(opt.series.value)) + '」中' : '';
    if (opt.who.value) scope += esc(opt.who.value) + (BOOKS ? '的節目或著作中' : '主講的節目中');
    var clear = (opt.series.value || opt.who.value) ? '<button class="textbtn" id="clearFilters">取消篩選，改找全部' + (BOOKS ? '節目與書刊' : '節目') + '</button>' : '';
    if (!results.length) {
      var tips = '可以試試較短的詞或其他寫法';
      if (groups.length > 1 && opt.mode.value === 'and') tips += '；輸入多個詞時，目前要每個詞都在同一集出現才算（可在「搜尋選項」改成出現其中一個就算）';
      el.innerHTML = '';
      $('empty').innerHTML = '<div class="empty">' + scope + '找不到包含「' + esc(state.query) + '」的' + (BOOKS ? '節目或書刊' : '節目') + '。<br><span class="hint">' + tips + '。</span>' +
        (clear ? '<div class="actions">' + clear + '</div>' : '') + '</div>';
      return;
    }
    $('empty').innerHTML = '';
    var allHits = res.totals.reduce(function (s, t) { return s + t.hits; }, 0);
    var html = '<div class="summary"><div class="big">' + scope + '共 <b>' + fmtN(results.length) + '</b> ' + U + '符合，' + (mixed ? '內容' : '文字稿') + '中出現 <b>' + fmtN(allHits) + '</b> 次</div><ul>';
    groups.forEach(function (g, gi) {
      var t = res.totals[gi];
      html += '<li><span class="badge m' + gi + '">' + esc(g.term) + '</span> 出現 <b>' + fmtN(t.hits) + '</b> 次，分布在 <b>' + fmtN(t.eps) + '</b> ' + U;
      var vs = Object.keys(t.byVariant);
      if (vs.length > 1 || (vs.length && vs[0] !== g.term)) {
        html += '<div class="variants">含別名：' + vs.sort(function (a, b) { return t.byVariant[b] - t.byVariant[a]; })
          .map(function (k) { return esc(k) + ' ' + fmtN(t.byVariant[k]) + ' 次'; }).join('、') + '</div>';
      }
      html += '</li>';
    });
    html += '</ul>';

    var ser = Object.keys(res.bySeries).map(function (k) { return res.bySeries[k]; })
      .sort(function (a, b) { return b.hits - a.hits; });
    if (ser.length > 1) {
      var max = ser[0].hits || 1;
      html += '<details class="dist"' + (ser.length <= 8 ? ' open' : '') + '><summary>各系列出現次數（' + ser.length + ' 個系列）</summary><table>' +
        ser.map(function (s) {
          return '<tr><td><button class="link" data-series="' + s.code + '">' + esc(s.name) + '</button>' +
            '<span class="barline" style="width:' + Math.max(2, s.hits / max * 100).toFixed(1) + '%"></span></td>' +
            '<td class="num">' + fmtN(s.hits) + ' 次</td><td class="num">' + fmtN(s.eps) + ' ' + ((seriesByCode[s.code] || {}).unit || '集') + '</td></tr>';
        }).join('') + '</table><p class="hint">點系列名稱可只看該系列。</p></details>';
    }
    html += '<div class="actions"><button class="textbtn only-narrow" id="jumpList">↓ 直接看符合的節目</button>' + clear + '</div>';
    el.innerHTML = html + '</div>';
  }

  function quoteHtml(q) {
    var e = epById[q.id];
    var src = esc(q.se) + ' 第 ' + esc(q.ep) + ' 集《' + esc(q.ti) + '》' + (q.w ? ' · ' + esc(q.w) : '');
    var links = e ? ' · <button class="qplay" data-ep="' + esc(q.id) + '" data-t="' + q.t + '">約 ' + fmtTime(q.t) + ' ▶</button> · <a href="' + pageUrl(e) + '" target="_blank" rel="noopener">文字稿</a>' : '';
    return '<blockquote><p>' + esc(q.x) + '</p><div class="src">' + src + links + '</div></blockquote>';
  }

  // 名詞說明卡片：自己寫的簡短說明 + 節目中的說法與原文摘錄
  function entryHtml(g, opts) {
    opts = opts || {};
    var d = DEFS[g.term] || {};
    var alias = (g.aliases || []).length ? '<span class="alias">別名：' + esc(g.aliases.join('、')) + '</span>' : '';
    var count = opts.count != null ? '<span class="alias">出現 ' + fmtN(opts.count) + ' 次</span>' : '';
    // clamp：手機上先只顯示幾行，按「展開說明」才看全部（樣式見 .gloss.clamp）
    var html = '<div class="gloss' + (opts.clamp ? ' clamp' : '') + '"><h3>' + (opts.prefix || '') + esc(g.term) + alias + count + '</h3><div class="gbody">';
    if (g.desc) html += '<p>' + esc(g.desc) + '</p>';
    if (d.s) html += '<p class="from"><span class="tag">節目中的說法</span>' + esc(d.s) + '</p>';
    if (d.q && d.q.length) {
      html += '<details' + (opts.open ? ' open' : '') + '><summary>節目原文摘錄（' + d.q.length + ' 段）</summary>' +
        d.q.map(quoteHtml).join('') + '</details>';
    }
    html += '</div>';
    if (opts.clamp && (g.desc || d.s)) html += '<button type="button" class="textbtn gmore">展開說明</button>';
    return html + '</div>';
  }

  function renderGlossary(groups) {
    // 寬螢幕時說明在右欄，只搜一個詞就直接展開原文摘錄；手機上一律先收合，節目列表才不會被擠到很下面
    var open = groups.length === 1 && !isNarrow();
    $('glossary').innerHTML = groups.filter(function (g) { return g.entry; }).map(function (g) {
      return entryHtml(g.entry, { prefix: '名詞說明：', open: open, clamp: true });
    }).join('');
  }

  // ---------- 名詞辭典 ----------
  var DICT_TOP = 60;   // 索引先顯示幾個名詞，其餘按「顯示全部」才展開
  function showDict() {
    showView('dict');
    state.query = '';
    $('q').value = '';
    setUrl('dict');
    if ($('dict').dataset.ready) return;
    $('dict').dataset.ready = '1';
    var counts = CATALOG.termCounts || {};
    var list = GLOSSARY.slice().sort(function (a, b) { return (counts[b.term] || 0) - (counts[a.term] || 0); });
    var idChip = function (g, i) { return '<button class="chip small" data-dict="' + i + '">' + esc(g.term) + '</button>'; };
    $('dict').innerHTML = '<h2>名詞辭典（' + list.length + ' 個名詞）</h2>' +
      '<p class="hint">依出現次數排序，點名詞展開說明。「節目中的說法」是從節目文字稿中挑出解釋該名詞的段落後整理的摘要，並附原文與出處。</p>' +
      '<input id="dictFilter" class="dict-filter" type="search" placeholder="輸入字詞找名詞，例如：涅槃、識" aria-label="篩選名詞">' +
      '<div class="chips dindex" id="dictIndex">' + list.slice(0, DICT_TOP).map(idChip).join('') +
      (list.length > DICT_TOP ? '<span class="contents" id="dictRest" hidden>' + list.slice(DICT_TOP).map(function (g, i) { return idChip(g, i + DICT_TOP); }).join('') + '</span>' +
        '<button class="chip small toggle-chip" id="dictToggle" data-n="' + list.length + '">顯示全部 ' + list.length + ' 個 ▾</button>' : '') +
      '</div><div id="dictList"></div>';
    // 每個名詞一列：名詞、簡短說明（一行）、次數；點了才展開完整說明與原文摘錄
    function dictEntry(g, i, open) {
      var d = DEFS[g.term] || {};
      var body = '';
      if ((g.aliases || []).length) body += '<p class="hint">別名：' + esc(g.aliases.join('、')) + '</p>';
      if (g.desc) body += '<p>' + esc(g.desc) + '</p>';
      if (d.s) body += '<p class="from"><span class="tag">節目中的說法</span>' + esc(d.s) + '</p>';
      if (d.q && d.q.length) body += '<div class="qlabel">節目原文摘錄（' + d.q.length + ' 段）</div>' + d.q.map(quoteHtml).join('');
      body += '<button class="chip" data-q="' + esc(g.term) + '">搜尋「' + esc(g.term) + '」出現的所有節目</button>';
      return '<details class="dentry" id="de' + i + '"' + (open ? ' open' : '') + '><summary><span class="dterm">' + esc(g.term) + '</span>' +
        '<span class="ddesc">' + esc(g.desc || d.s || '') + '</span><span class="dcount">' + fmtN(counts[g.term] || 0) + ' 次</span></summary>' +
        '<div class="dbody gloss">' + body + '</div></details>';
    }
    function render(f) {
      f = norm(f);
      // 名詞本身符合的排前面，只有說明文字符合的排後面
      var byName = [], byText = [];
      list.forEach(function (g, i) {
        var d = DEFS[g.term] || {};
        if (!f || g.variants.some(function (v) { return v.indexOf(f) >= 0; })) byName.push(i);
        else if (norm(g.desc).indexOf(f) >= 0 || norm(d.s).indexOf(f) >= 0) byText.push(i);
      });
      var all = byName.concat(byText);
      $('dictIndex').hidden = !!f;   // 篩選時列表已經很短，不需要索引
      // 篩選後只剩幾個時直接展開
      $('dictList').innerHTML = all.map(function (i) { return dictEntry(list[i], i, !!f && all.length <= 3); }).join('') ||
        '<p class="hint">沒有符合的名詞。</p>';
    }
    render('');
    $('dictFilter').addEventListener('input', function () { render(this.value); });
    $('dictIndex').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-dict]');
      if (b) {
        var d = $('de' + b.dataset.dict);
        if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        return;
      }
      if (ev.target.id === 'dictToggle') {
        var rest = $('dictRest');
        rest.hidden = !rest.hidden;
        ev.target.textContent = rest.hidden ? '顯示全部 ' + ev.target.dataset.n + ' 個 ▾' : '只顯示常見的 ▴';
      }
    });
  }

  function renderRelated(results, groups) {
    var rel = relatedTerms(results, groups);
    $('related').innerHTML = rel.length ? '<div class="relbox"><h2>經常一起出現的名詞</h2><div class="chips">' + rel.map(function (r) {
      return '<button class="chip" data-q="' + esc(r.term) + '">' + esc(r.term) + '<small>' + fmtN(r.n) + '</small></button>';
    }).join('') + '</div><p class="hint">點一下可改搜該名詞。數字是它在附近（前後 ' + RELATED_WIN + ' 字內）一起出現的次數。</p></div>' : '';
    renderToolbar();
  }

  // 列表上方：集數、詳細／精簡切換、下載
  function renderToolbar() {
    var n = state.results.length, compact = state.view === 'compact';
    var mixed = state.results.some(function (r) { return r.e.doc; });
    // 有書刊資料時，多一組「全部／影片／書刊」的快速切換（等同搜尋選項裡的「只看這個系列」）
    var sv = opt.series.value;
    var scope = BOOKS ? '<span class="seg" role="group" aria-label="搜尋範圍">' +
      [['', '全部'], ['@video', '影片'], ['@doc', '書刊']].map(function (x) {
        return '<button type="button" data-scope="' + x[0] + '" class="' + (sv === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
      }).join('') + '</span>' : '';
    $('toolbar').innerHTML = n ? '<h2>' + (mixed ? '符合的節目與書刊（' + fmtN(n) + ' 筆）' : '符合的節目（' + fmtN(n) + ' 集）') + '</h2><div class="tools">' + scope +
      '<span class="seg" role="group" aria-label="列表顯示方式">' +
      '<button type="button" data-view="detail" class="' + (compact ? '' : 'on') + '" title="每集顯示前後文與時間軸">詳細</button>' +
      '<button type="button" data-view="compact" class="' + (compact ? 'on' : '') + '" title="每集一行，點了才展開">精簡</button></span>' +
      '<button id="csvBtn" title="下載成表格檔，可用 Excel 開啟">下載結果（Excel 可開）</button></div>' : '';
  }
  function resetList() {
    $('list').innerHTML = '';
    state.shown = 0;
    renderMore();
  }

  function renderMore() {
    var next = state.results.slice(state.shown, state.shown + (state.view === 'compact' ? PAGE_COMPACT : PAGE));
    var frag = document.createDocumentFragment();
    next.forEach(function (r) { frag.appendChild(card(r)); });
    $('list').appendChild(frag);
    state.shown += next.length;
    var left = state.results.length - state.shown;
    $('moreBtn').hidden = left <= 0;
    $('moreBtn').textContent = state.results.some(function (r) { return r.e.doc; }) ?
      '顯示更多（還有 ' + fmtN(left) + ' 筆）' : '顯示更多節目（還有 ' + fmtN(left) + ' 集）';
  }

  // 時間軸：處數不多時每處一個圓點；很多時圓點會疊成一片，改成濃淡色條（越深代表那一段越集中）
  function timelineHtml(e, clusters) {
    if (!clusters.length) return '';
    var len = e.text.length || 1;
    var where = function (c) { return e.doc ? pageText(c.page) : e.dur ? '約 ' + fmtTime(c.time) : ''; };
    if (clusters.length <= HEAT_MIN) {
      return '<div class="timeline-label">' + (e.doc ? '出現位置（左邊是開頭、右邊是結尾，點圓點開啟那一頁）' : '出現位置（左邊是節目開頭、右邊是結尾，點圓點可播放）') + '</div>' +
        '<div class="timeline" aria-label="名詞出現位置的分布">' + clusters.map(function (c, i) {
          return '<button data-i="' + i + '" style="left:' + Math.min(100, c.start / len * 100).toFixed(2) + '%" title="' + where(c) + '"></button>';
        }).join('') + '</div>';
    }
    var bins = [], max = 0, html = '';
    clusters.forEach(function (c, i) {
      var b = Math.min(HEAT_BINS - 1, Math.floor(c.start / len * HEAT_BINS));
      if (!bins[b]) bins[b] = { first: i, n: 0 };
      bins[b].n += c.hits.length;
      max = Math.max(max, bins[b].n);
    });
    for (var b = 0; b < HEAT_BINS; b++) {
      var x = bins[b];
      html += x ? '<button data-i="' + x.first + '" style="opacity:' + (0.25 + 0.75 * x.n / max).toFixed(2) + '" title="' +
        (where(clusters[x.first]) ? where(clusters[x.first]) + ' 起，' : '') + '這一段出現 ' + x.n + ' 次"></button>' : '<i></i>';
    }
    return '<div class="timeline-label">' + (e.doc ? '出現位置（左邊是開頭、右邊是結尾；顏色越深代表越集中，點一下開啟那一頁）' :
      '出現位置（左邊是節目開頭、右邊是結尾；顏色越深代表越集中，點一下從那一段開始播放）') + '</div>' +
      '<div class="timeline heat" aria-label="名詞出現位置的分布">' + html + '</div>';
  }

  function card(r) {
    var e = r.e;
    var el = document.createElement('article');
    el.className = 'video' + (state.view === 'compact' ? ' compact' : '');
    el.dataset.ep = e.id;
    var clusters = clusterHits(r);
    var thumb = e.doc ? '<span class="doclabel">' + esc(e.seriesName) + (e.ep ? '<b>' + esc(e.ep) + '</b>' : '') + '</span>' :
      e.yt ? '<img loading="lazy" alt="" onerror="this.remove()" src="https://i.ytimg.com/vi/' + e.yt + '/mqdefault.jpg">' : '';
    var badges = state.groups.map(function (g, gi) {
      return r.counts[gi] ? '<span class="badge m' + gi + '">' + esc(g.term) + ' × ' + r.counts[gi] + '</span>' : '';
    }).join('');
    if (r.inTitle.some(Boolean)) badges += '<span class="badge">標題含關鍵字</span>';
    if (r.inSum.some(Boolean)) badges += '<span class="badge">本集摘要提到</span>';
    if (!r.total) badges += '<span class="badge">' + (r.inTitle.some(Boolean) ? '只在標題中出現' : '只在摘要中出現') + '</span>';
    if (e.asr) badges += '<span class="badge" title="官網沒有這一集的文字稿，這裡的文字是電腦語音辨識的結果，會有錯字；時間是實際時間">語音辨識文字</span>';
    if (e.lock) badges += '<span class="badge" title="' + (e.lock === 'locked' ? '出版社沒有開放擷取這份 PDF 的文字' : '這份 PDF 沒有文字層') + '，所以只能搜尋官網上的簡介與目錄">只能搜尋簡介</span>';

    var href = e.doc ? (e.pdf || pageUrl(e)) : e.yt ? ytUrl(e.yt) : pageUrl(e);
    var meta = e.doc ?
      [esc(e.who), esc(e.date), e.np ? e.np + ' 頁' : '', '<a href="' + esc(pageUrl(e)) + '" target="_blank" rel="noopener">官網頁面</a>',
        e.pdf ? '<a href="' + esc(e.pdf) + '" target="_blank" rel="noopener">開啟 PDF</a>' : ''] :
      [esc(e.who), e.durEst ? '約 ' + fmtDur(e.dur) + '（長度為估計）' : fmtDur(e.dur), '<a href="' + pageUrl(e) + '" target="_blank" rel="noopener">' + pageLabel(e) + '</a>'];
    el.innerHTML =
      '<a class="thumb' + (e.doc ? ' doc' : '') + '" href="' + esc(href) + '" target="_blank" rel="noopener" title="' + (e.doc ? (e.pdf ? '開啟 PDF' : '開啟官網頁面') : e.yt ? '從頭播放這一集' : '打開文字稿') + '">' + thumb + '</a>' +
      '<div><div class="vhead"><div class="series">' + esc(e.seriesName) + (epLabel(e) ? ' · ' + esc(epLabel(e)) : '') + '</div>' +
      '<h3><a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a></h3>' +
      '<div class="meta">' + meta.filter(Boolean).join(' · ') + '</div>' +
      '<div class="badges">' + badges + '</div>' +
      '<button type="button" class="fold" aria-expanded="false">展開 ▾</button></div>' +
      '<div class="detail">' + sumHtml(e, false) + timelineHtml(e, clusters) +
      '<ol class="hits"></ol></div></div>';

    var ol = el.querySelector('.hits'), fold = el.querySelector('.fold');
    var showAll = false, more = null;
    function fill() {
      ol.innerHTML = clusters.slice(0, showAll ? clusters.length : SHOW_HITS).map(function (c, i) {
        var ts = e.doc ? pageText(c.page) : e.dur ? '▶ ' + (e.pt ? '' : '約 ') + fmtTime(c.time) : '第 ' + (c.para + 1) + ' 段';
        var tip = e.doc ? (c.page && e.pdf ? '開啟 PDF 並跳到這一頁' : '開啟官網頁面') : e.yt ? '從這附近開始播放影片' : '這一集沒有影片，會打開文字稿';
        var on = nowPlaying && nowPlaying.clusters === clusters && nowPlaying.i === i;
        return '<li' + (on ? ' class="playing"' : '') + '><button class="ts" data-i="' + i + '" title="' + tip + '">' + ts + '</button>' +
          '<div class="snip"><span class="txt">' + snippetHtml(r, c) + '</span>' +
          (c.hits.length > 1 ? '<span class="n">（' + c.hits.length + ' 次）</span>' : '') +
          ' <button class="para" data-p="' + i + '">看整段</button></div></li>';
      }).join('');
      if (more) more.textContent = showAll ? '收合' : '顯示全部 ' + clusters.length + ' 處';
    }
    if (clusters.length > SHOW_HITS) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'toggle';
      more.onclick = function () { showAll = !showAll; fill(); };
      ol.after(more);
    }
    fill();
    // 精簡模式：展開／收合這一集
    function setOpen(o) {
      el.classList.toggle('open', o);
      fold.setAttribute('aria-expanded', o ? 'true' : 'false');
      fold.textContent = o ? '收合 ▴' : '展開 ▾';
    }
    // 給播放器用：讓第 i 處出現在畫面上（必要時展開這一集、顯示全部段落），回傳那一列
    el._clusters = clusters;
    el._reveal = function (i) {
      if (el.classList.contains('compact') && !el.classList.contains('open')) setOpen(true);
      if (i >= SHOW_HITS && !showAll) { showAll = true; fill(); }
      return ol.children[i] || null;
    };
    el.addEventListener('click', function (ev) {
      if (el.classList.contains('compact')) {
        if (!el.classList.contains('open')) { ev.preventDefault(); setOpen(true); return; }
        if (ev.target.closest('.fold')) { setOpen(false); return; }
      }
      // 點縮圖：依「點時間播放影片」的設定從頭播放（按住 Ctrl / Shift 點則照一般連結開啟）
      var th = ev.target.closest('a.thumb');
      if (th && e.yt && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) { ev.preventDefault(); play(e, 0, { r: r, clusters: clusters, i: -1 }); return; }
      var b = ev.target.closest('button[data-i]');
      if (b) {
        var bi = +b.dataset.i;
        if (e.doc) window.open(docUrl(e, clusters[bi].page), '_blank', 'noopener');
        else play(e, clusters[bi].time, { r: r, clusters: clusters, i: bi });
        return;
      }
      var p = ev.target.closest('button[data-p]');
      if (p) {
        var c = clusters[+p.dataset.p];
        var txt = p.parentNode.querySelector('.txt');
        var full = p.dataset.full === '1';
        txt.innerHTML = full ? snippetHtml(r, c) : paragraphHtml(r, c);
        p.dataset.full = full ? '0' : '1';
        p.textContent = full ? '看整段' : '收合';
      }
    });
    return el;
  }

  // 本集摘要（AI 依文字稿整理）
  function sumHtml(e, open) {
    var m = e.sum;
    if (!m) return '';
    return '<details class="epsum"' + (open ? ' open' : '') + '><summary>本集摘要' +
      (m.k && m.k.length ? '<span class="tags">' + m.k.map(function (k) { return '<span>' + esc(k) + '</span>'; }).join('') + '</span>' : '') +
      '</summary><p>' + esc(m.s) + '</p>' +
      (m.p && m.p.length ? '<ul>' + m.p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
      (m.k && m.k.length ? '<div class="chips">' + m.k.map(function (k) { return '<button class="chip small" data-q="' + esc(k) + '">' + esc(k) + '</button>'; }).join('') + '</div>' : '') +
      '</details>';
  }

  // ---------- 節目瀏覽 ----------
  function firstSentence(s) {
    var i = s.search(/[。！？]/);
    return i >= 0 && i < s.length - 1 ? s.slice(0, i + 1) : s;
  }
  function tagCloud(eps) {
    var c = {};
    eps.forEach(function (e) { if (e.sum) (e.sum.k || []).forEach(function (k) { c[k] = (c[k] || 0) + 1; }); });
    var top = Object.keys(c).filter(function (k) { return c[k] > 1; }).sort(function (a, b) { return c[b] - c[a]; }).slice(0, 40);
    return top.length ? '<div class="chips tagcloud"><span class="hint">常見主題：</span>' + top.map(function (k) {
      return '<button class="chip small" data-tag="' + esc(k) + '">' + esc(k) + '<small>' + c[k] + '</small></button>';
    }).join('') + '</div>' : '';
  }

  function showBrowse(code) {
    showView('browse');
    state.query = '';
    $('q').value = '';
    var el = $('browse');
    var withSum = CATALOG.series.filter(function (s) { return episodes.some(function (e) { return e.series === s.code && e.sum; }); });
    if (code && !seriesByCode[code]) code = '';
    code = code || el.dataset.code || (withSum[0] || CATALOG.series[0]).code;
    el.dataset.code = code;
    setUrl('browse=' + code);
    var cur = seriesByCode[code], isDoc = cur.kind === 'doc', U = cur.unit || '集';
    var eps = episodes.filter(function (e) { return e.series === code; })
      .sort(function (a, b) {
        // 書刊：新的排前面；節目：依集數
        return isDoc ? b.id.localeCompare(a.id, undefined, { numeric: true }) : a.ep.localeCompare(b.ep, undefined, { numeric: true });
      });
    var hasSum = eps.some(function (e) { return e.sum; });
    var hasText = eps.some(function (e) { return e.text; });   // 「法義辨正」的系列官網只有影片，沒有文字稿
    var hasAsr = eps.some(function (e) { return e.asr; });     // 其中用語音辨識補上文字的
    var docHint = !isDoc ? '' : !eps.length ? '<p class="hint">書刊資料還在載入，請稍候…</p>' :
      '<p class="hint">' + (cur.full ? '有 ' + cur.full + ' ' + U + '的 PDF 全文可以搜尋，搜尋結果會標出頁碼，點了就開啟 PDF 的那一頁。' : '') +
      (cur.locked ? '有 ' + cur.locked + ' ' + U + '的 PDF 出版社沒有開放擷取文字，只能搜尋官網上的簡介與目錄；仍可點「開啟 PDF」閱讀。' : '') +
      (!cur.full && !cur.locked ? '這裡收錄官網上的介紹與下載連結。' : '') + '</p>';
    el.innerHTML = '<h2>節目瀏覽</h2>' +
      '<div class="browse-bar"><select id="browseSeries" aria-label="選擇系列">' + ALL_SERIES.map(function (s) {
        var mark = s.kind === 'doc' || withSum.indexOf(s) >= 0 ? '' : s.asr ? '（語音辨識文字）' : s.chars ? '（尚無摘要）' : '（只有影片）';
        return '<option value="' + s.code + '"' + (s.code === code ? ' selected' : '') + '>' + esc(s.name) + '・' + s.count + ' ' + (s.unit || '集') + mark + '</option>';
      }).join('') + '</select>' +
      '<input id="browseFilter" type="search" aria-label="在這個系列裡找" placeholder="' + (hasSum ? '在這個系列裡找主題，例如：授記、化城、如來藏' : '在這個系列裡找標題') + '"></div>' +
      (isDoc ? docHint : hasSum ? '<p class="hint">摘要、重點與主題標籤是 AI 依文字稿整理的，僅供快速瀏覽；內容以原文為準。</p>' :
        hasAsr ? '<p class="hint">官網沒有提供這個系列的文字稿；這裡可以搜尋的文字是電腦語音辨識的結果，會有錯字（尤其是佛學名詞），播放時間則是實際時間。</p>' :
        hasText ? '<p class="hint">這個系列還沒有摘要，只列出標題。</p>' :
        '<p class="hint">這個系列官網只提供影片、沒有文字稿，所以只列出標題，不能搜尋內容；可以直接播放。</p>') +
      tagCloud(eps) +
      '<div id="browseList"></div>';
    function docItem(e) {
      var links = e.links && e.links.length ? '<details class="doclinks"><summary>下載／播放連結（' + e.links.length + ' 個）</summary><ul>' +
        e.links.map(function (l) { return '<li><a href="' + esc(l[1]) + '" target="_blank" rel="noopener">' + esc(l[0]) + '</a></li>'; }).join('') + '</ul></details>' : '';
      return '<article class="bitem"><div class="series">' + [epLabel(e), e.who, e.date, e.np ? e.np + ' 頁' : ''].filter(Boolean).map(esc).join(' · ') + '</div>' +
        '<h3>' + esc(e.title) + '</h3>' + (e.lead ? '<p class="lead">' + esc(e.lead) + '</p>' : '') + links +
        '<div class="meta">' + (e.pdf ? '<a href="' + esc(e.pdf) + '" target="_blank" rel="noopener">開啟 PDF</a> · ' : '') +
        '<a href="' + esc(pageUrl(e)) + '" target="_blank" rel="noopener">官網頁面</a>' +
        (e.lock ? ' · 只能搜尋簡介' : '') + '</div></article>';
    }
    function render(f) {
      f = norm(f);
      var list = eps.filter(function (e) { return !f || e.titleN.indexOf(f) >= 0 || e.sumN.indexOf(f) >= 0; });
      $('browseList').innerHTML = '<p class="hint">' + (f ? '符合的有 ' + list.length + ' ' + U + '（這個系列共 ' + eps.length + ' ' + U + '）' : '共 ' + list.length + ' ' + U) + '</p>' + list.map(function (e) {
        if (e.doc) return docItem(e);
        return '<article class="bitem"><div class="series">第 ' + esc(e.ep) + ' 集 · ' + esc(e.who) + (e.dur ? ' · ' + fmtDur(e.dur) : '') + '</div>' +
          '<h3>' + esc(e.title) + '</h3>' +
          // 摘要的第一句直接顯示，其餘（重點、主題）點「本集摘要」才展開
          (e.sum && e.sum.s ? '<p class="lead">' + esc(firstSentence(e.sum.s)) + '</p>' : '') + sumHtml(e, !!f) +
          '<div class="meta">' + (e.yt ? '<button class="qplay" data-ep="' + esc(e.id) + '" data-t="0">播放 ▶</button> · ' : '') +
          '<a href="' + pageUrl(e) + '" target="_blank" rel="noopener">' + pageLabel(e) + '</a></div></article>';
      }).join('');
    }
    render('');
    $('browseFilter').addEventListener('input', function () { render(this.value); });
    el.querySelectorAll('.tagcloud button').forEach(function (b) {
      b.addEventListener('click', function () { $('browseFilter').value = b.dataset.tag; render(b.dataset.tag); });
    });
    $('browseSeries').addEventListener('change', function () { showBrowse(this.value); });
  }

  // ---------- 播放器 ----------
  var YT_ORIGIN = 'https://www.youtube-nocookie.com';
  var nowPlaying = null;   // { e, start, r, clusters, i }：從搜尋結果播放時才有 r / clusters / i
  var ytTime = null;       // 播放器回報的目前秒數；收不到回報時是 null，這時改用重新載入的方式跳轉
  var ytTimer = null;

  function ytPost(obj) {
    try { $('playerFrame').contentWindow.postMessage(JSON.stringify(obj), YT_ORIGIN); } catch (e) { /* 播放器還沒載入 */ }
  }
  function ytCmd(func, args) { ytPost({ event: 'command', func: func, args: args || [] }); }
  function loadFrame() {
    var p = nowPlaying;
    ytTime = null;
    $('playerFrame').src = YT_ORIGIN + '/embed/' + p.e.yt + '?autoplay=1&rel=0&enablejsapi=1&start=' + p.start +
      (/^https?:$/.test(location.protocol) ? '&origin=' + encodeURIComponent(location.origin) : '');
    $('playerTitle').textContent = p.e.title + '（從 ' + fmtTime(p.start) + ' 開始）';
    $('playerLink').href = ytUrl(p.e.yt, p.start);
  }
  // 影片載入後請播放器定時回報目前秒數，「−15 秒／＋15 秒」才能從正在看的地方算起
  $('playerFrame').addEventListener('load', function () {
    clearInterval(ytTimer);
    if (!nowPlaying) return;
    var tries = 0;
    ytTimer = setInterval(function () {
      if (ytTime != null || ++tries > 12 || !nowPlaying) { clearInterval(ytTimer); return; }
      ytPost({ event: 'listening', id: 1, channel: 'widget' });
    }, 500);
  });
  window.addEventListener('message', function (ev) {
    if (ev.origin !== YT_ORIGIN || ev.source !== $('playerFrame').contentWindow) return;
    var d = ev.data;
    try { if (typeof d === 'string') d = JSON.parse(d); } catch (e) { return; }
    if (d && d.info && typeof d.info.currentTime === 'number') ytTime = d.info.currentTime;
  });

  function play(e, t, ctx) {
    if (!e.yt) { window.open(pageUrl(e), '_blank', 'noopener'); return; }
    var start = Math.max(0, Math.floor(t) - leadOf(e));
    if (opt.play.value === 'tab') { window.open(ytUrl(e.yt, start), '_blank', 'noopener'); return; }
    var same = nowPlaying && nowPlaying.e === e && ytTime != null;
    nowPlaying = { e: e, start: start, r: ctx ? ctx.r : null, clusters: ctx ? ctx.clusters : null, i: ctx ? ctx.i : -1 };
    $('player').hidden = false;
    syncSide();
    if (same) {
      // 同一集：直接跳到新的位置，不必重新載入影片
      ytCmd('seekTo', [start, true]);
      ytCmd('playVideo');
      ytTime = start;
      $('playerTitle').textContent = e.title + '（從 ' + fmtTime(start) + ' 開始）';
      $('playerLink').href = ytUrl(e.yt, start);
    } else loadFrame();
    $('playerPage').href = pageUrl(e);
    $('playerPage').textContent = e.text && !e.asr ? '看文字稿' : '看官網頁面';
    updatePlayerCtl();
    markPlaying(true);
    if (isNarrow()) $('player').scrollIntoView({ behavior: 'smooth' });
  }

  function closePlayer() {
    $('player').hidden = true;
    $('playerFrame').src = 'about:blank';
    nowPlaying = null;
    ytTime = null;
    markPlaying();
    syncSide();
  }

  // 時間是估算的：往前或往後調整
  function seek(delta) {
    var p = nowPlaying;
    if (!p) return;
    if (ytTime != null) {
      ytTime = Math.max(0, ytTime + delta);
      ytCmd('seekTo', [ytTime, true]);
    } else {
      p.start = Math.max(0, p.start + delta);
      loadFrame();
    }
  }
  // 跳到同一集的上一處／下一處
  function stepHit(d) {
    var p = nowPlaying;
    if (!p || !p.clusters) return;
    var i = p.i + d;
    if (i < 0 || i >= p.clusters.length) return;
    play(p.e, p.clusters[i].time, { r: p.r, clusters: p.clusters, i: i });
  }
  function updatePlayerCtl() {
    var p = nowPlaying, n = p && p.clusters ? p.clusters.length : 0;
    $('hitPrev').disabled = !n || p.i <= 0;
    $('hitNext').disabled = !n || p.i >= n - 1;
    $('hitPos').textContent = n ? (p.i >= 0 ? '第 ' + (p.i + 1) + ' / ' + n + ' 處' : '共 ' + n + ' 處') : '';
    // 手機上播放器在最上面、看不到列表，所以把這一處的前後文顯示在播放器下方
    $('hitText').innerHTML = n && p.i >= 0 && p.r ? snippetHtml(p.r, p.clusters[p.i]) : '';
  }
  // 在列表裡標示正在播放的那一段
  function markPlaying(scroll) {
    [].forEach.call(document.querySelectorAll('.hits li.playing'), function (li) { li.classList.remove('playing'); });
    var p = nowPlaying;
    if (!p || !p.clusters || p.i < 0) return;
    var cardEl = [].filter.call($('list').children, function (c) { return c._clusters === p.clusters; })[0];
    var li = cardEl && cardEl._reveal(p.i);
    if (!li) return;
    li.classList.add('playing');
    if (scroll && !isNarrow()) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function downloadCsv() {
    var hasDoc = state.results.some(function (r) { return r.e.doc; });
    var rows = [['系列', hasDoc ? '集數／期數' : '集數', '標題', hasDoc ? '主講／作者' : '主講', hasDoc ? '約略時間／頁碼' : '約略時間',
      'YouTube 連結', hasDoc ? '文字稿／PDF 連結' : '文字稿連結', '內容片段', '次數']];
    state.results.forEach(function (r) {
      var e = r.e;
      clusterHits(r).forEach(function (c) {
        var pr = paraRange(e, c.para);
        var from = Math.max(pr[0], c.start - CONTEXT), to = Math.min(pr[1], c.end + CONTEXT);
        rows.push([e.seriesName, e.ep, e.title, e.who, e.doc ? pageText(c.page) : e.dur ? fmtTime(c.time) : '',
          e.yt ? ytUrl(e.yt, Math.max(0, c.time - leadOf(e))) : '', e.doc ? docUrl(e, c.page) : pageUrl(e), e.text.slice(from, to), c.hits.length]);
      });
    });
    var csv = '﻿' + rows.map(function (row) {
      return row.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = '搜尋結果_' + state.query.replace(/\s+/g, '_') + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---------- 首頁 ----------
  var EXAMPLES = ['如來藏', '四聖諦', '阿賴耶識', '念佛', '四聖諦 八正道'];
  var HOT_TOP = 36;   // 首頁先顯示幾個常見名詞，其餘按「顯示全部」才展開

  function getRecent() {
    try {
      var a = JSON.parse(store('recent') || '[]');
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && x; }) : [];
    } catch (e) { return []; }
  }
  // 只記錄真的有找到節目的搜尋
  function addRecent(q) {
    q = (q || '').trim();
    if (!q || q !== state.query || !state.results.length) return;
    var list = getRecent().filter(function (x) { return x !== q; });
    list.unshift(q);
    store('recent', JSON.stringify(list.slice(0, 8)));
  }
  function renderRecent() {
    var el = $('recent');
    if (!el) return;
    var list = getRecent();
    el.hidden = !list.length;
    el.innerHTML = list.length ? '<span class="hint">最近搜尋：</span>' + list.map(function (k) {
      return '<button class="chip" data-q="' + esc(k) + '">' + esc(k) + '</button>';
    }).join('') + '<button class="textbtn" id="clearRecent">清除紀錄</button>' : '';
  }

  function showHome() {
    showView('home');
    var home = $('home');
    if (home.dataset.ready) { renderRecent(); return; }
    home.dataset.ready = '1';
    var videos = episodes.filter(function (e) { return !e.doc; });
    var hours = videos.reduce(function (s, e) { return s + e.dur; }, 0) / 3600;
    var chars = videos.reduce(function (s, e) { return s + e.text.length; }, 0);
    // 書刊的數字直接用索引裡的統計（首頁顯示時書刊資料可能還在載入）
    var bookCount = 0, bookChars = 0;
    if (BOOKS) BOOKS.series.forEach(function (s) { bookCount += s.count; bookChars += s.chars; });
    var counts = CATALOG.termCounts || {};
    var hot = Object.keys(counts).filter(function (k) { return counts[k]; }).sort(function (a, b) { return counts[b] - counts[a]; });
    var sumCount = {};   // 每個系列有幾集、其中幾集有摘要
    episodes.forEach(function (e) {
      var c = sumCount[e.series] || (sumCount[e.series] = { n: 0, sum: 0 });
      c.n++;
      if (e.sum) c.sum++;
    });
    // 系列依官網的分類分組（三乘菩提、法義辨正）
    var seriesGroups = [];
    ALL_SERIES.forEach(function (s) {
      var c = s.cat || 'a';
      var g = seriesGroups.filter(function (x) { return x.cat === c; })[0];
      if (!g) seriesGroups.push(g = { cat: c, name: s.catName || (BOOKS ? '弘法視頻' : ''), list: [] });
      g.list.push(s);
    });
    var seriesCard = function (s) {
      var st = sumCount[s.code] || { n: 0, sum: 0 };
      var isDoc = s.kind === 'doc';
      var note = isDoc ? (s.full ? (s.locked ? s.full + ' ' + s.unit + '可搜尋全文' : 'PDF 全文可搜尋') : s.locked ? '可搜尋簡介' : '介紹與連結') :
        !s.chars ? '只有影片' : s.asr ? '語音辨識文字' : !st.sum ? '尚無摘要' : st.sum < st.n ? '摘要 ' + st.sum + ' 集' : '每集有摘要';
      return '<div class="scard"><span class="code">' + (isDoc ? '書刊' : esc(s.code)) + '</span>' +
        '<button class="link" data-browse="' + esc(s.code) + '" title="' + (isDoc ? '看全部' + esc(s.name) : '看這個系列的每一集') + '">' + esc(s.name) + '</button>' +
        '<div class="smeta"><span>' + s.count + ' ' + (s.unit || '集') + ' · ' + note + '</span>' +
        '<a href="' + esc(s.url || (SITE + catOf(s.code) + '/' + s.code)) + '" target="_blank" rel="noopener">官網 ↗</a></div></div>';
    };
    var termChip = function (k) {
      return '<button class="chip" data-q="' + esc(k) + '">' + esc(k) + '<small>' + fmtN(counts[k]) + '</small></button>';
    };
    home.innerHTML =
      '<div class="intro"><h2>想找什麼名詞？</h2>' +
      '<p>在上面的搜尋框輸入名詞，就會列出講到它的節目和前後文；點「▶ 約幾分幾秒」就從那附近開始播放。' +
      (BOOKS ? '也會一起找正智書香園地的電子報與贈閱書籍，點「第幾頁」就開啟 PDF 的那一頁。' : '') + '</p>' +
      '<div class="chips"><span class="hint">試試看：</span>' + EXAMPLES.map(function (k) {
        return '<button class="chip" data-q="' + esc(k) + '">' + esc(k) + '</button>';
      }).join('') + '</div>' +
      '<div class="chips" id="recent" hidden></div></div>' +
      '<div class="entries">' +
      '<button class="entry" id="browseBtn2"><b>節目瀏覽 →</b><span>依系列看每一集的摘要、重點與主題</span></button>' +
      '<button class="entry" id="dictBtn2"><b>名詞辭典 →</b><span>' + GLOSSARY.length + ' 個名詞的說明，附節目中老師的原文</span></button>' +
      '</div>' +
      (hot.length ? '<h2>常見名詞</h2><div class="chips">' + hot.slice(0, HOT_TOP).map(termChip).join('') +
        (hot.length > HOT_TOP ? '<span class="contents" id="hotRest" hidden>' + hot.slice(HOT_TOP).map(termChip).join('') + '</span>' +
          '<button class="chip toggle-chip" id="hotToggle" data-n="' + hot.length + '">顯示全部 ' + hot.length + ' 個 ▾</button>' : '') +
        '</div><p class="hint">點名詞就會搜尋。數字是在所有文字稿中出現的次數（含別名）。</p>' : '') +
      '<h2>全部系列</h2>' + seriesGroups.map(function (g) {
        var noText = g.list.every(function (s) { return !s.chars; });
        var lockedN = g.list.reduce(function (n, s) { return n + (s.locked || 0); }, 0);
        return (seriesGroups.length > 1 ? '<h3 class="cathead">' + esc(g.name || g.cat) + '<small>' + (g.cat === 'books' ? '書刊' : g.list.length + ' 個系列') + '</small></h3>' : '') +
          (g.cat === 'books' ? '<p class="hint">有文字層且開放擷取的 PDF 可以搜尋全文，結果會標出頁碼。' +
            (lockedN ? '其中 ' + lockedN + ' 份 PDF 出版社沒有開放擷取文字，只能搜尋官網上的簡介與目錄。' : '') + '</p>' : '') +
          (g.list.some(function (s) { return s.asr; }) ? '<p class="hint">這個分類官網只提供影片、沒有文字稿；標示「語音辨識文字」的系列已用電腦語音辨識補上文字，可以搜尋內容，但會有錯字（尤其是佛學名詞）。</p>' : '') +
          (noText ? '<p class="hint">這個分類官網只提供影片、沒有文字稿，所以只能用標題找到，不能搜尋內容；點系列名稱可以看每一集並播放。</p>' : '') +
          '<div class="sgrid">' + g.list.map(seriesCard).join('') + '</div>';
      }).join('') +
      '<h2>關於這個網頁</h2><div class="stats">' +
      '<div class="stat"><b>' + CATALOG.series.length + '</b><span>個系列</span></div>' +
      '<div class="stat"><b>' + fmtN(videos.length) + '</b><span>集節目</span></div>' +
      '<div class="stat"><b>' + fmtN(Math.round(hours)) + '</b><span>小時</span></div>' +
      '<div class="stat"><b>' + fmtN(Math.round(chars / 10000)) + ' 萬</b><span>字文字稿</span></div>' +
      (BOOKS ? '<div class="stat"><b>' + fmtN(bookCount) + '</b><span>筆書刊</span></div>' +
        '<div class="stat"><b>' + fmtN(Math.round(bookChars / 10000)) + ' 萬</b><span>字書刊內容</span></div>' : '') +
      '</div>' +
      '<p class="hint">資料來源：<a href="' + esc(SITE) + '" target="_blank" rel="noopener">正覺教團弘法視頻</a>，資料更新到 ' + esc(fmtDate(CATALOG.generated)) +
      (BOOKS ? '；<a href="' + esc(BOOKS.site) + '" target="_blank" rel="noopener">正智書香園地</a>，資料更新到 ' + esc(fmtDate(BOOKS.generated)) : '') +
      '。網站的文字稿沒有時間標記，影片時間是依文字位置估算的，所以播放時會提早 ' + PLAY_EARLY + ' 秒開始。' +
      '名詞說明與別名可在 data/glossary.js 中自行增修。</p>';
    renderRecent();
  }

  function fillFilters() {
    var add = function (value, text) {
      var o = document.createElement('option');
      o.value = value; o.textContent = text;
      opt.series.appendChild(o);
    };
    if (BOOKS) {
      opt.series.options[0].textContent = '全部（影片與書刊）';
      add('@video', '只找影片節目');
      add('@doc', '只找書刊（電子報、贈閱書籍、影音）');
    }
    ALL_SERIES.forEach(function (s) {
      seriesByCode[s.code] = s;
      add(s.code, s.name);
    });
  }
  // 書刊在背景載入完之後會再呼叫一次，把作者也加進來
  function fillWho() {
    var c = {}, hasDoc = {}, keep = opt.who.value;
    episodes.forEach(function (e) {
      if (!e.who) return;
      c[e.who] = (c[e.who] || 0) + 1;
      if (e.doc) hasDoc[e.who] = true;
    });
    while (opt.who.options.length > 1) opt.who.remove(1);
    Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).forEach(function (w) {
      var o = document.createElement('option');
      o.value = w; o.textContent = w + '（' + c[w] + (hasDoc[w] ? ' 筆）' : ' 集）');
      opt.who.appendChild(o);
    });
    opt.who.value = keep;
  }

  // ---------- 事件 ----------
  var timer;
  $('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    clearTimeout(timer);
    nav(function () { runSearch($('q').value); });
    addRecent(state.query);
    $('q').blur();   // 手機上收起鍵盤，讓結果露出來
  });
  $('q').addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch($('q').value); }, 400);
  });
  $('q').addEventListener('change', function () { addRecent($('q').value); });
  [opt.syn, opt.mode, opt.series, opt.who].forEach(function (el) {
    el.addEventListener('change', function () {
      // 正在看節目瀏覽或名詞辭典時，改選項不要把畫面跳走
      if ($('q').value.trim()) runSearch($('q').value);
    });
  });
  opt.sort.addEventListener('change', function () {
    store('sort', opt.sort.value);
    if (!state.query) return;
    sortResults(); resetList();
  });
  $('seekBack').addEventListener('click', function () { seek(-SEEK_STEP); });
  $('seekFwd').addEventListener('click', function () { seek(SEEK_STEP); });
  $('hitPrev').addEventListener('click', function () { stepHit(-1); });
  $('hitNext').addEventListener('click', function () { stepHit(1); });
  opt.play.addEventListener('change', function () { store('play', opt.play.value); });
  $('moreBtn').addEventListener('click', renderMore);
  $('playerClose').addEventListener('click', closePlayer);
  $('homeLink').addEventListener('click', function (e) {
    e.preventDefault();
    nav(function () { runSearch(''); });
    window.scrollTo(0, 0);
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    var chip = t.closest('.chip[data-q]');
    if (chip) {
      nav(function () { runSearch(chip.dataset.q); });
      addRecent(chip.dataset.q);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var sb = t.closest('button[data-series]');
    if (sb) { opt.series.value = sb.dataset.series; optNote(); runSearch(state.query); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    var bb = t.closest('button[data-browse]');
    if (bb) { nav(function () { showBrowse(bb.dataset.browse); }); window.scrollTo(0, 0); return; }
    if (t.closest('#dictBtn, #dictBtn2')) { e.preventDefault(); if (loaded) { nav(showDict); window.scrollTo(0, 0); } return; }
    if (t.closest('#browseBtn, #browseBtn2')) { e.preventDefault(); if (loaded) { nav(function () { showBrowse(); }); window.scrollTo(0, 0); } return; }
    if (t.id === 'csvBtn') { downloadCsv(); return; }
    var sc = t.closest('.seg button[data-scope]');
    if (sc) { opt.series.value = sc.dataset.scope; optNote(); runSearch(state.query); return; }
    var vb = t.closest('.seg button[data-view]');
    if (vb) {
      if (vb.dataset.view !== state.view) {
        state.view = vb.dataset.view;
        store('view', state.view);
        renderToolbar();
        resetList();
      }
      return;
    }
    if (t.classList.contains('gmore')) {
      var full = t.parentNode.classList.toggle('full');
      t.textContent = full ? '收合說明' : '展開說明';
      return;
    }
    if (t.id === 'clearFilters') { opt.series.value = ''; opt.who.value = ''; optNote(); runSearch(state.query); return; }
    if (t.id === 'jumpList') { $('toolbar').scrollIntoView({ behavior: 'smooth' }); return; }
    if (t.id === 'clearRecent') { store('recent', '[]'); renderRecent(); return; }
    if (t.id === 'hotToggle') {
      var rest = $('hotRest');
      rest.hidden = !rest.hidden;
      t.textContent = rest.hidden ? '顯示全部 ' + t.dataset.n + ' 個 ▾' : '只顯示常見的 ▴';
      return;
    }
    var qp = t.closest('.qplay');
    if (qp && epById[qp.dataset.ep]) play(epById[qp.dataset.ep], +qp.dataset.t);
  });

  // 瀏覽器的上一頁／下一頁
  window.addEventListener('popstate', function () { if (loaded) route(); });

  // 字體大小
  var FONT = [15, 16, 18, 20, 22];
  var savedFont = store('font');
  var fontIdx = savedFont == null || isNaN(+savedFont) ? 1 : Math.min(FONT.length - 1, Math.max(0, +savedFont));
  function applyFont() {
    document.documentElement.style.fontSize = FONT[fontIdx] + 'px';
    $('fontDown').disabled = fontIdx === 0;
    $('fontUp').disabled = fontIdx === FONT.length - 1;
  }
  $('fontDown').addEventListener('click', function () { if (fontIdx > 0) { fontIdx--; store('font', String(fontIdx)); applyFont(); } });
  $('fontUp').addEventListener('click', function () { if (fontIdx < FONT.length - 1) { fontIdx++; store('font', String(fontIdx)); applyFont(); } });
  applyFont();

  // 深色／淺色：預設跟隨系統，按過按鈕後記住選擇（index.html 開頭會先套用，避免閃爍）
  var darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : darkMq.matches;
  }
  function applyTheme() {
    $('themeBtn').textContent = isDark() ? '淺色' : '深色';
    $('themeBtn').title = isDark() ? '改成淺色畫面' : '改成深色畫面';
  }
  $('themeBtn').addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store('theme', next);
    applyTheme();
  });
  if (darkMq.addEventListener) darkMq.addEventListener('change', applyTheme);
  applyTheme();

  // 搜尋選項：預設收合，記住上次的狀態；收合時在標題上提示目前有哪些篩選
  $('optBox').open = store('opts') === '1';
  $('optBox').addEventListener('toggle', function () { store('opts', $('optBox').open ? '1' : '0'); });
  function optNote() {
    var on = [];
    if (opt.series.value) on.push(seriesLabel(opt.series.value));
    if (opt.who.value) on.push(opt.who.value);
    $('optNote').textContent = on.length ? '　目前只看：' + on.join('、') : '';
  }
  [opt.series, opt.who].forEach(function (el) { el.addEventListener('change', optNote); });

  // 搜尋列固定在頂端時加上陰影；捲動一段距離後顯示「回到最上面」
  function onScroll() {
    $('searchbar').classList.toggle('stuck', window.scrollY > $('top').offsetHeight);
    $('toTop').hidden = window.scrollY < 700;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  $('toTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // 鍵盤：按 / 跳到搜尋框，按 Esc 關閉播放器
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); $('q').focus(); $('q').select(); }
    if (e.key === 'Escape' && !$('player').hidden && !typing) closePlayer();
  });

  // ---------- 啟動 ----------
  if (store('sort')) opt.sort.value = store('sort');
  // 直接開檔案（file://）時 YouTube 內嵌播放器常無法使用，預設改到 YouTube 開啟
  opt.play.value = store('play') || (location.protocol === 'file:' ? 'tab' : 'embed');
  var m = location.hash.match(/q=([^&]*)/);
  if (m) { try { $('q').value = decodeURIComponent(m[1]); } catch (e) { /* 網址不完整 */ } }

  if (!CATALOG || !CATALOG.series || !CATALOG.series.length) {
    $('noIndex').hidden = false;
    return;
  }
  fillFilters();
  loadAll(function () {
    loaded = true;
    fillWho();
    route();
    if (BOOKS) loadBooks(function () {
      fillWho();
      // 書刊載入完成：把正在看的搜尋結果或書刊列表更新一次
      if (!$('results').hidden && state.query) runSearch(state.query);
      else if (!$('browse').hidden && (seriesByCode[$('browse').dataset.code] || {}).kind === 'doc') showBrowse($('browse').dataset.code);
    });
  });
})();
