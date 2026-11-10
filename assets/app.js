(function () {
  'use strict';

  var CATALOG = window.ENL_CATALOG || null;
  var DEFS = window.DEFINITIONS || {};
  var SUMS = window.SUMMARIES || {};
  var GLOSSARY = window.GLOSSARY || [];
  var SITE = (CATALOG && CATALOG.site) || 'https://video.enlighten.org.tw/zh-tw/';
  var PAGE = 20;          // 每次顯示幾集
  var SHOW_HITS = 5;      // 每集預設顯示幾個段落
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
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }
  var ytUrl = function (yt, t) { return 'https://www.youtube.com/watch?v=' + yt + (t ? '&t=' + Math.floor(t) + 's' : ''); };
  var pageUrl = function (e) { return SITE + 'a/' + e.series + '/' + e.id; };

  // ---------- 載入資料 ----------
  var episodes = [];
  var epById = {};
  var seriesByCode = {};
  var loaded = false;

  window.ENL_ADD = function (data) {
    var s = seriesByCode[data.code] || { code: data.code, name: data.code };
    data.episodes.forEach(function (e) {
      var text = '', paraPos = [];
      (e.p || []).forEach(function (p) {
        var n = norm(p);
        if (!n) return;
        paraPos.push(text.length);
        text += n;
      });
      episodes.push({
        id: e.id, series: data.code, seriesName: s.name, ep: e.ep || '', title: e.t || '', who: e.who || '',
        yt: e.yt || '', dur: e.dur || 0, durEst: !!e.durEst, text: text, paraPos: paraPos, titleN: norm(e.t),
        sum: SUMS[e.id] || null,
        sumN: SUMS[e.id] ? norm(SUMS[e.id].s + (SUMS[e.id].p || []).join('') + (SUMS[e.id].k || []).join('')) : ''
      });
    });
  };

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
        label.textContent = '載入文字稿 ' + n + ' / ' + total + ' 個系列';
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
  function timeAt(e, pos) { return e.dur && e.text.length ? e.dur * pos / e.text.length : 0; }

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
      if (seriesFilter && e.series !== seriesFilter) return;
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
        cur = { start: h.pos, end: h.end, hits: [h], para: p, time: timeAt(r.e, h.pos) };
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
  var state = { groups: [], results: [], shown: 0, query: '' };
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

  function runSearch(q) {
    q = (q || '').trim();
    state.query = q;
    $('q').value = q;
    try { history.replaceState(null, '', q ? '#q=' + encodeURIComponent(q) : location.pathname); } catch (e) { /* file:// */ }
    if (!loaded) return;
    $('dict').hidden = true;
    $('browse').hidden = true;
    if (!q) { showHome(); return; }

    var groups = parseQuery(q, opt.syn.checked);
    var res = search(groups, opt.mode.value, opt.series.value, opt.who.value);
    state.groups = groups;
    state.results = res.results;
    sortResults();

    $('home').hidden = true;
    $('results').hidden = false;
    renderSummary(groups, res);
    renderGlossary(groups);
    renderRelated(res.results, groups);
    $('list').innerHTML = '';
    state.shown = 0;
    renderMore();
  }

  function renderSummary(groups, res) {
    var el = $('summary'), results = res.results;
    var scope = opt.series.value ? '「' + esc(seriesByCode[opt.series.value].name) + '」中' : '';
    if (opt.who.value) scope += esc(opt.who.value) + '主講的節目中';
    if (!results.length) {
      el.innerHTML = '<div class="empty">' + scope + '找不到包含「' + esc(state.query) + '」的節目。<br><span class="hint">可以試試較短的詞、其他寫法，或取消篩選條件。</span></div>';
      return;
    }
    var allHits = res.totals.reduce(function (s, t) { return s + t.hits; }, 0);
    var html = '<div class="summary"><div class="big">' + scope + '共 <b>' + results.length + '</b> 集符合，文字稿中出現 <b>' + allHits + '</b> 次</div><ul>';
    groups.forEach(function (g, gi) {
      var t = res.totals[gi];
      html += '<li><span class="badge m' + gi + '">' + esc(g.term) + '</span> 出現 <b>' + t.hits + '</b> 次，分布在 <b>' + t.eps + '</b> 集';
      var vs = Object.keys(t.byVariant);
      if (vs.length > 1 || (vs.length && vs[0] !== g.term)) {
        html += '<div class="variants">含相關詞：' + vs.sort(function (a, b) { return t.byVariant[b] - t.byVariant[a]; })
          .map(function (k) { return esc(k) + ' ' + t.byVariant[k] + ' 次'; }).join('、') + '</div>';
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
          return '<tr><td><button class="link" data-series="' + s.code + '">' + esc(s.name) + '</button></td>' +
            '<td class="bar"><span style="width:' + Math.max(2, s.hits / max * 100).toFixed(1) + '%"></span></td>' +
            '<td class="num">' + s.hits + ' 次</td><td class="num">' + s.eps + ' 集</td></tr>';
        }).join('') + '</table><p class="hint">點系列名稱可只看該系列。</p></details>';
    }
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
    var alias = (g.aliases || []).length ? '<span class="alias">相關詞：' + esc(g.aliases.join('、')) + '</span>' : '';
    var count = opts.count != null ? '<span class="alias">出現 ' + opts.count + ' 次</span>' : '';
    var html = '<div class="gloss"><h3>' + (opts.prefix || '') + esc(g.term) + alias + count + '</h3>';
    if (g.desc) html += '<p>' + esc(g.desc) + '</p>';
    if (d.s) html += '<p class="from"><span class="tag">節目中的說法</span>' + esc(d.s) + '</p>';
    if (d.q && d.q.length) {
      html += '<details' + (opts.open ? ' open' : '') + '><summary>節目原文摘錄（' + d.q.length + ' 段）</summary>' +
        d.q.map(quoteHtml).join('') + '</details>';
    }
    if (opts.searchBtn) html += '<button class="chip" data-q="' + esc(g.term) + '">搜尋「' + esc(g.term) + '」出現的所有節目</button>';
    return html + '</div>';
  }

  function renderGlossary(groups) {
    $('glossary').innerHTML = groups.filter(function (g) { return g.entry; }).map(function (g) {
      return entryHtml(g.entry, { prefix: '名詞說明：', open: true });
    }).join('');
  }

  // ---------- 名詞辭典 ----------
  function showDict() {
    $('home').hidden = true;
    $('results').hidden = true;
    $('browse').hidden = true;
    $('dict').hidden = false;
    try { history.replaceState(null, '', '#dict'); } catch (e) { /* file:// */ }
    if ($('dict').dataset.ready) return;
    $('dict').dataset.ready = '1';
    var counts = CATALOG.termCounts || {};
    var list = GLOSSARY.slice().sort(function (a, b) { return (counts[b.term] || 0) - (counts[a.term] || 0); });
    $('dict').innerHTML = '<h2>名詞辭典（' + list.length + ' 個名詞）</h2>' +
      '<p class="hint">「節目中的說法」是從節目文字稿中挑出解釋該名詞的段落後整理的摘要，下方附原文與出處。依出現次數排序。</p>' +
      '<input id="dictFilter" class="dict-filter" type="search" placeholder="篩選名詞，例如：涅槃、識">' +
      '<div id="dictList"></div>';
    function render(f) {
      f = norm(f);
      // 名詞本身符合的排前面，只有說明文字符合的排後面
      var byName = [], byText = [];
      list.forEach(function (g) {
        var d = DEFS[g.term] || {};
        if (!f || g.variants.some(function (v) { return v.indexOf(f) >= 0; })) byName.push(g);
        else if (norm(g.desc).indexOf(f) >= 0 || norm(d.s).indexOf(f) >= 0) byText.push(g);
      });
      $('dictList').innerHTML = byName.concat(byText).map(function (g) { return entryHtml(g, { count: counts[g.term] || 0, searchBtn: true }); }).join('') ||
        '<p class="hint">沒有符合的名詞。</p>';
    }
    render('');
    $('dictFilter').addEventListener('input', function () { render(this.value); });
  }

  function renderRelated(results, groups) {
    var rel = relatedTerms(results, groups);
    $('related').innerHTML = rel.length ? '<h2>經常一起出現的名詞</h2><div class="chips">' + rel.map(function (r) {
      return '<button class="chip" data-q="' + esc(r.term) + '">' + esc(r.term) + '<small>' + r.n + '</small></button>';
    }).join('') + '</div><p class="hint">數字是在命中段落前後 ' + RELATED_WIN + ' 字內一起出現的次數。點一下可搜尋該名詞。</p>' : '';
    $('toolbar').innerHTML = results.length ? '<span>節目列表</span><button id="csvBtn">下載結果 (CSV)</button>' : '';
  }

  function renderMore() {
    var next = state.results.slice(state.shown, state.shown + PAGE);
    var frag = document.createDocumentFragment();
    next.forEach(function (r) { frag.appendChild(card(r)); });
    $('list').appendChild(frag);
    state.shown += next.length;
    var left = state.results.length - state.shown;
    $('moreBtn').hidden = left <= 0;
    $('moreBtn').textContent = '顯示更多（還有 ' + left + ' 集）';
  }

  function card(r) {
    var e = r.e;
    var el = document.createElement('article');
    el.className = 'video';
    var clusters = clusterHits(r);
    var thumb = e.yt ? '<img loading="lazy" alt="" onerror="this.remove()" src="https://i.ytimg.com/vi/' + e.yt + '/mqdefault.jpg">' : '';
    var badges = state.groups.map(function (g, gi) {
      return r.counts[gi] ? '<span class="badge m' + gi + '">' + esc(g.term) + ' × ' + r.counts[gi] + '</span>' : '';
    }).join('');
    if (r.inTitle.some(Boolean)) badges += '<span class="badge">標題含關鍵字</span>';
    if (r.inSum.some(Boolean)) badges += '<span class="badge">本集摘要提到</span>';
    if (!r.total) badges += '<span class="badge">' + (r.inTitle.some(Boolean) ? '只在標題中出現' : '只在摘要中出現') + '</span>';

    var len = e.text.length || 1;
    var dots = clusters.map(function (c, i) {
      return '<button data-i="' + i + '" style="left:' + Math.min(100, c.start / len * 100).toFixed(2) + '%" title="' +
        (e.dur ? '約 ' + fmtTime(c.time) : '') + '"></button>';
    }).join('');

    var href = e.yt ? ytUrl(e.yt) : pageUrl(e);
    el.innerHTML =
      '<a class="thumb" href="' + href + '" target="_blank" rel="noopener">' + thumb + '</a>' +
      '<div><div class="series">' + esc(e.seriesName) + ' · 第 ' + esc(e.ep) + ' 集</div>' +
      '<h3><a href="' + href + '" target="_blank" rel="noopener">' + esc(e.title) + '</a></h3>' +
      '<div class="meta">' + [esc(e.who), e.durEst ? '約 ' + fmtDur(e.dur) + '（長度為估計）' : fmtDur(e.dur), '<a href="' + pageUrl(e) + '" target="_blank" rel="noopener">文字稿</a>'].filter(Boolean).join(' · ') + '</div>' +
      '<div class="badges">' + badges + '</div>' +
      sumHtml(e, false) +
      (dots ? '<div class="timeline" aria-label="命中位置在節目中的分布">' + dots + '</div>' : '') +
      '<ol class="hits"></ol></div>';

    var ol = el.querySelector('.hits');
    function fill(n) {
      ol.innerHTML = clusters.slice(0, n).map(function (c, i) {
        var ts = e.dur ? '約 ' + fmtTime(c.time) : '第 ' + (c.para + 1) + ' 段';
        return '<li><button class="ts" data-i="' + i + '" title="從這附近開始播放">' + ts + '</button>' +
          '<div class="snip"><span class="txt">' + snippetHtml(r, c) + '</span>' +
          (c.hits.length > 1 ? '<span class="n">（' + c.hits.length + ' 次）</span>' : '') +
          ' <button class="para" data-p="' + i + '">看整段</button></div></li>';
      }).join('');
    }
    fill(SHOW_HITS);
    if (clusters.length > SHOW_HITS) {
      var t = document.createElement('button');
      t.className = 'toggle';
      t.textContent = '顯示全部 ' + clusters.length + ' 處';
      t.onclick = function () {
        var open = t.dataset.open === '1';
        fill(open ? SHOW_HITS : clusters.length);
        t.dataset.open = open ? '0' : '1';
        t.textContent = open ? '顯示全部 ' + clusters.length + ' 處' : '收合';
      };
      ol.after(t);
    }
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-i]');
      if (b) { play(e, clusters[+b.dataset.i].time); return; }
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
  function tagCloud(eps) {
    var c = {};
    eps.forEach(function (e) { if (e.sum) (e.sum.k || []).forEach(function (k) { c[k] = (c[k] || 0) + 1; }); });
    var top = Object.keys(c).filter(function (k) { return c[k] > 1; }).sort(function (a, b) { return c[b] - c[a]; }).slice(0, 40);
    return top.length ? '<div class="chips tagcloud"><span class="hint">常見主題：</span>' + top.map(function (k) {
      return '<button class="chip small" data-tag="' + esc(k) + '">' + esc(k) + '<small>' + c[k] + '</small></button>';
    }).join('') + '</div>' : '';
  }

  function showBrowse(code) {
    $('home').hidden = true; $('results').hidden = true; $('dict').hidden = true;
    var el = $('browse');
    el.hidden = false;
    var withSum = CATALOG.series.filter(function (s) { return episodes.some(function (e) { return e.series === s.code && e.sum; }); });
    code = code || el.dataset.code || (withSum[0] || CATALOG.series[0]).code;
    el.dataset.code = code;
    try { history.replaceState(null, '', '#browse=' + code); } catch (e) { /* file:// */ }
    var eps = episodes.filter(function (e) { return e.series === code; })
      .sort(function (a, b) { return a.ep.localeCompare(b.ep, undefined, { numeric: true }); });
    var hasSum = eps.some(function (e) { return e.sum; });
    el.innerHTML = '<h2>節目瀏覽</h2>' +
      '<div class="browse-bar"><select id="browseSeries">' + CATALOG.series.map(function (s) {
        var mark = withSum.indexOf(s) >= 0 ? '（有摘要）' : '';
        return '<option value="' + s.code + '"' + (s.code === code ? ' selected' : '') + '>' + esc(s.name) + mark + '</option>';
      }).join('') + '</select>' +
      '<input id="browseFilter" type="search" placeholder="' + (hasSum ? '用主題篩選，例如：授記、化城、如來藏' : '篩選標題') + '"></div>' +
      (hasSum ? '<p class="hint">摘要、重點與主題標籤是 AI 依文字稿整理的，僅供快速瀏覽；內容以原文為準。</p>' : '<p class="hint">這個系列還沒有摘要，只列出標題。</p>') +
      tagCloud(eps) +
      '<div id="browseList"></div>';
    function render(f) {
      f = norm(f);
      var list = eps.filter(function (e) { return !f || e.titleN.indexOf(f) >= 0 || e.sumN.indexOf(f) >= 0; });
      $('browseList').innerHTML = '<p class="hint">' + list.length + ' 集</p>' + list.map(function (e) {
        return '<article class="bitem"><div class="series">第 ' + esc(e.ep) + ' 集 · ' + esc(e.who) + (e.dur ? ' · ' + fmtDur(e.dur) : '') + '</div>' +
          '<h3>' + esc(e.title) + '</h3>' + sumHtml(e, !!f) +
          '<div class="meta">' + (e.yt ? '<button class="qplay" data-ep="' + esc(e.id) + '" data-t="' + PLAY_EARLY + '">播放 ▶</button> · ' : '') +
          '<a href="' + pageUrl(e) + '" target="_blank" rel="noopener">文字稿</a></div></article>';
      }).join('');
    }
    render('');
    $('browseFilter').addEventListener('input', function () { render(this.value); });
    el.querySelectorAll('.tagcloud button').forEach(function (b) {
      b.addEventListener('click', function () { $('browseFilter').value = b.dataset.tag; render(b.dataset.tag); });
    });
    $('browseSeries').addEventListener('change', function () { showBrowse(this.value); });
  }

  function play(e, t) {
    if (!e.yt) { window.open(pageUrl(e), '_blank', 'noopener'); return; }
    var start = Math.max(0, Math.floor(t) - PLAY_EARLY);
    if (opt.play.value === 'tab') { window.open(ytUrl(e.yt, start), '_blank', 'noopener'); return; }
    $('player').hidden = false;
    document.querySelector('.layout').classList.add('with-player');
    $('playerTitle').textContent = e.title + '（從 ' + fmtTime(start) + ' 開始）';
    $('playerFrame').src = 'https://www.youtube-nocookie.com/embed/' + e.yt + '?autoplay=1&rel=0&start=' + start;
    $('playerLink').href = ytUrl(e.yt, start);
    $('playerPage').href = pageUrl(e);
    if (window.matchMedia('(max-width: 960px)').matches) $('player').scrollIntoView({ behavior: 'smooth' });
  }

  function closePlayer() {
    $('player').hidden = true;
    $('playerFrame').src = 'about:blank';
    document.querySelector('.layout').classList.remove('with-player');
  }

  function downloadCsv() {
    var rows = [['系列', '集數', '標題', '主講', '約略時間', 'YouTube 連結', '文字稿連結', '內容片段', '次數']];
    state.results.forEach(function (r) {
      var e = r.e;
      clusterHits(r).forEach(function (c) {
        var pr = paraRange(e, c.para);
        var from = Math.max(pr[0], c.start - CONTEXT), to = Math.min(pr[1], c.end + CONTEXT);
        rows.push([e.seriesName, e.ep, e.title, e.who, e.dur ? fmtTime(c.time) : '',
          e.yt ? ytUrl(e.yt, Math.max(0, c.time - PLAY_EARLY)) : '', pageUrl(e), e.text.slice(from, to), c.hits.length]);
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
  function showHome() {
    $('results').hidden = true;
    var home = $('home');
    home.hidden = false;
    if (home.dataset.ready) return;
    home.dataset.ready = '1';
    var hours = episodes.reduce(function (s, e) { return s + e.dur; }, 0) / 3600;
    var chars = episodes.reduce(function (s, e) { return s + e.text.length; }, 0);
    var counts = CATALOG.termCounts || {};
    var hot = Object.keys(counts).filter(function (k) { return counts[k]; }).sort(function (a, b) { return counts[b] - counts[a]; });
    home.innerHTML =
      '<div class="stats">' +
      '<div class="stat"><b>' + CATALOG.series.length + '</b><span>個系列</span></div>' +
      '<div class="stat"><b>' + episodes.length + '</b><span>集節目</span></div>' +
      '<div class="stat"><b>' + Math.round(hours) + '</b><span>小時</span></div>' +
      '<div class="stat"><b>' + Math.round(chars / 10000) + ' 萬</b><span>字文字稿</span></div>' +
      '</div>' +
      '<p class="hint">資料來源：<a href="' + esc(SITE) + '" target="_blank" rel="noopener">正覺教團弘法視頻</a>，索引更新時間：' + esc(CATALOG.generated || '未知') +
      '。網站文字稿沒有時間標記，影片時間是依文字位置估算的，播放時會提早 ' + PLAY_EARLY + ' 秒開始。</p>' +
      (hot.length ? '<h2>常見名詞（依出現次數）</h2><div class="chips">' + hot.map(function (k) {
        return '<button class="chip" data-q="' + esc(k) + '">' + esc(k) + '<small>' + counts[k] + '</small></button>';
      }).join('') + '</div><p class="hint">數字含相關詞。名詞說明與相關詞可在 data/glossary.js 中自行增修。</p>' : '') +
      '<p><button class="chip" id="browseBtn2">節目瀏覽（依系列看每集摘要）</button> <button class="chip" id="dictBtn2">打開名詞辭典（' + GLOSSARY.length + ' 個名詞，含節目原文說明）</button></p>' +
      '<h2>系列</h2><table class="serieslist">' + CATALOG.series.map(function (s) {
        return '<tr><td>' + esc(s.code) + '</td><td><a href="' + SITE + 'a/' + s.code + '" target="_blank" rel="noopener">' + esc(s.name) + '</a></td><td class="num">' + s.count + ' 集</td></tr>';
      }).join('') + '</table>';
  }

  function fillFilters() {
    CATALOG.series.forEach(function (s) {
      seriesByCode[s.code] = s;
      var o = document.createElement('option');
      o.value = s.code; o.textContent = s.name;
      opt.series.appendChild(o);
    });
  }
  function fillWho() {
    var c = {};
    episodes.forEach(function (e) { if (e.who) c[e.who] = (c[e.who] || 0) + 1; });
    Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).forEach(function (w) {
      var o = document.createElement('option');
      o.value = w; o.textContent = w + '（' + c[w] + ' 集）';
      opt.who.appendChild(o);
    });
  }

  // ---------- 事件 ----------
  var timer;
  $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); runSearch($('q').value); });
  $('q').addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch($('q').value); }, 400);
  });
  [opt.syn, opt.mode, opt.series, opt.who].forEach(function (el) {
    el.addEventListener('change', function () { runSearch($('q').value); });
  });
  opt.sort.addEventListener('change', function () {
    store('sort', opt.sort.value);
    if (!state.query) return;
    sortResults(); $('list').innerHTML = ''; state.shown = 0; renderMore();
  });
  opt.play.addEventListener('change', function () { store('play', opt.play.value); });
  $('moreBtn').addEventListener('click', renderMore);
  $('playerClose').addEventListener('click', closePlayer);
  $('homeLink').addEventListener('click', function (e) { e.preventDefault(); runSearch(''); });
  document.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip[data-q]');
    if (chip) { runSearch(chip.dataset.q); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    var sb = e.target.closest('button[data-series]');
    if (sb) { opt.series.value = sb.dataset.series; runSearch(state.query); }
    if (e.target.id === 'csvBtn') downloadCsv();
    if (e.target.id === 'dictBtn' || e.target.id === 'dictBtn2') { e.preventDefault(); if (loaded) { showDict(); window.scrollTo(0, 0); } }
    if (e.target.id === 'browseBtn' || e.target.id === 'browseBtn2') { e.preventDefault(); if (loaded) { showBrowse(); window.scrollTo(0, 0); } }
    var qp = e.target.closest('.qplay');
    if (qp && epById[qp.dataset.ep]) play(epById[qp.dataset.ep], +qp.dataset.t);
  });

  // ---------- 啟動 ----------
  if (store('sort')) opt.sort.value = store('sort');
  // 直接開檔案（file://）時 YouTube 內嵌播放器常無法使用，預設改到 YouTube 開啟
  opt.play.value = store('play') || (location.protocol === 'file:' ? 'tab' : 'embed');
  var m = location.hash.match(/q=([^&]*)/);
  if (m) $('q').value = decodeURIComponent(m[1]);

  if (!CATALOG || !CATALOG.series || !CATALOG.series.length) {
    $('noIndex').hidden = false;
    return;
  }
  fillFilters();
  loadAll(function () {
    loaded = true;
    episodes.forEach(function (e) { epById[e.id] = e; });
    fillWho();
    var bm = location.hash.match(/^#browse=?(\w*)/);
    if (bm && !$('q').value) showBrowse(bm[1]);
    else if (/^#dict/.test(location.hash) && !$('q').value) showDict();
    else runSearch($('q').value);
  });
})();
