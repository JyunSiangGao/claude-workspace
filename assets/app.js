(function () {
  'use strict';

  var RAW = window.ENLIGHTEN_INDEX || { videos: [] };
  var GLOSSARY = window.GLOSSARY || [];
  var PAGE = 20;          // 每次顯示幾部影片
  var SHOW_HITS = 5;      // 每部影片預設顯示幾個時間點
  var CONTEXT = 40;       // 片段前後顯示幾個字
  var CLUSTER_GAP = 30;   // 相距幾個字內的命中合併成同一列
  var CLUSTER_MAX = 100;  // 合併後一列最長幾個字
  var RELATED_WIN = 150;  // 找相關名詞時看前後幾個字

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
  var watchUrl = function (id, t) { return 'https://www.youtube.com/watch?v=' + id + (t ? '&t=' + Math.floor(t) + 's' : ''); };

  // ---------- 準備資料 ----------
  var videos = RAW.videos.map(function (v) {
    var text = '', segPos = [], segTime = [];
    (v.seg || []).forEach(function (s) {
      var n = norm(s[1]);
      if (!n) return;
      segPos.push(text.length);
      segTime.push(s[0]);
      text += n;
    });
    v.seg = null; // 釋放記憶體
    return {
      id: v.id, title: v.t || '', date: v.d || '', kind: v.kind, desc: v.desc || '',
      dur: v.dur || (segTime.length ? segTime[segTime.length - 1] + 5 : 0),
      text: text, segPos: segPos, segTime: segTime,
      titleN: norm(v.t), descN: norm(v.desc)
    };
  });

  var glossIndex = {};
  GLOSSARY.forEach(function (g) {
    g.variants = [g.term].concat(g.aliases || []).map(norm).filter(Boolean);
    g.variants.forEach(function (k) { if (!glossIndex[k]) glossIndex[k] = g; });
  });

  function timeAt(v, pos) {
    var lo = 0, hi = v.segPos.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (v.segPos[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return v.segTime[lo] || 0;
  }
  function countIn(text, needle) {
    var n = 0, i = text.indexOf(needle);
    while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
    return n;
  }

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
      // 長的詞先比對，避免「彌陀」重複計算「阿彌陀佛」
      variants.sort(function (a, b) { return b.length - a.length; });
      return { term: t, entry: entry, variants: variants };
    });
  }

  function search(groups, mode) {
    var results = [];
    var totals = groups.map(function () { return { hits: 0, videos: 0, byVariant: {} }; });

    videos.forEach(function (v) {
      var hits = [], counts = [], inTitle = [], ok = [], byV = [];
      groups.forEach(function (g, gi) {
        var taken = [];
        var n = 0, bv = {};
        byV.push(bv);
        g.variants.forEach(function (needle) {
          var i = v.text.indexOf(needle);
          while (i !== -1) {
            var end = i + needle.length;
            var overlap = taken.some(function (r) { return i < r[1] && end > r[0]; });
            if (!overlap) {
              taken.push([i, end]);
              hits.push({ pos: i, end: end, g: gi });
              n++;
              bv[needle] = (bv[needle] || 0) + 1;
            }
            i = v.text.indexOf(needle, end);
          }
        });
        counts.push(n);
        var t = g.variants.some(function (x) { return v.titleN.indexOf(x) >= 0; });
        var d = g.variants.some(function (x) { return v.descN.indexOf(x) >= 0; });
        inTitle.push(t);
        ok.push(n > 0 || t || d);
      });
      var matched = mode === 'or' ? ok.some(Boolean) : ok.every(Boolean);
      if (!matched) return;
      hits.sort(function (a, b) { return a.pos - b.pos; });
      var total = 0;
      counts.forEach(function (n, gi) {
        total += n;
        totals[gi].hits += n;
        if (n) totals[gi].videos++;
        Object.keys(byV[gi]).forEach(function (k) { totals[gi].byVariant[k] = (totals[gi].byVariant[k] || 0) + byV[gi][k]; });
      });
      results.push({ v: v, hits: hits, counts: counts, total: total, inTitle: inTitle, clusters: null });
    });
    return { results: results, totals: totals };
  }

  function clusterHits(r) {
    if (r.clusters) return r.clusters;
    var out = [], cur = null;
    r.hits.forEach(function (h) {
      var t = timeAt(r.v, h.pos);
      if (cur && h.pos - cur.end <= CLUSTER_GAP && h.end - cur.start <= CLUSTER_MAX && t - cur.time <= 30) {
        cur.hits.push(h);
        cur.end = Math.max(cur.end, h.end);
      } else {
        cur = { start: h.pos, end: h.end, hits: [h], time: t };
        out.push(cur);
      }
    });
    return (r.clusters = out);
  }

  function snippetHtml(v, c) {
    var from = Math.max(0, c.start - CONTEXT), to = Math.min(v.text.length, c.end + CONTEXT);
    var html = from > 0 ? '…' : '', p = from;
    c.hits.forEach(function (h) {
      if (h.pos < p) return;
      html += esc(v.text.slice(p, h.pos)) + '<mark class="m' + h.g + '">' + esc(v.text.slice(h.pos, h.end)) + '</mark>';
      p = h.end;
    });
    html += esc(v.text.slice(p, to)) + (to < v.text.length ? '…' : '');
    return html;
  }

  function relatedTerms(results, groups) {
    var skip = {};
    groups.forEach(function (g) { if (g.entry) skip[g.entry.term] = true; g.variants.forEach(function (x) { skip[x] = true; }); });
    var cand = GLOSSARY.filter(function (g) { return !skip[g.term] && !g.variants.some(function (x) { return skip[x]; }); });
    var score = {};
    var budget = 3000;
    results.forEach(function (r) {
      clusterHits(r).forEach(function (c) {
        if (budget-- <= 0) return;
        var win = r.v.text.slice(Math.max(0, c.start - RELATED_WIN), c.end + RELATED_WIN);
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
    syn: $('optSyn'), mode: $('optMode'), sort: $('optSort'), play: $('optPlay')
  };

  function sortResults() {
    var s = opt.sort.value;
    state.results.sort(function (a, b) {
      if (s === 'new') return b.v.date.localeCompare(a.v.date);
      if (s === 'old') return a.v.date.localeCompare(b.v.date);
      var ta = a.total + (a.inTitle.some(Boolean) ? 0.5 : 0), tb = b.total + (b.inTitle.some(Boolean) ? 0.5 : 0);
      return tb - ta || b.v.date.localeCompare(a.v.date);
    });
  }

  function runSearch(q) {
    q = (q || '').trim();
    state.query = q;
    $('q').value = q;
    try { history.replaceState(null, '', q ? '#q=' + encodeURIComponent(q) : location.pathname); } catch (e) { /* file:// */ }
    if (!q) { showHome(); return; }

    var groups = parseQuery(q, opt.syn.checked);
    var res = search(groups, opt.mode.value);
    state.groups = groups;
    state.results = res.results;
    sortResults();

    $('home').hidden = true;
    $('results').hidden = false;
    renderSummary(groups, res.totals, res.results);
    renderGlossary(groups);
    renderRelated(res.results, groups);
    $('list').innerHTML = '';
    state.shown = 0;
    renderMore();
  }

  function renderSummary(groups, totals, results) {
    var el = $('summary');
    if (!results.length) {
      el.innerHTML = '<div class="empty">找不到包含「' + esc(state.query) + '」的影片。<br><span class="hint">自動字幕常有同音錯字，可以試試其他寫法或較短的詞。</span></div>';
      return;
    }
    var allHits = totals.reduce(function (s, t) { return s + t.hits; }, 0);
    var html = '<div class="summary"><div class="big">共 <b>' + results.length + '</b> 部影片符合，字幕中出現 <b>' + allHits + '</b> 次</div><ul>';
    groups.forEach(function (g, gi) {
      var t = totals[gi];
      html += '<li><span class="badge m' + gi + '">' + esc(g.term) + '</span> 出現 <b>' + t.hits + '</b> 次，分布在 <b>' + t.videos + '</b> 部影片';
      var vs = Object.keys(t.byVariant);
      if (vs.length > 1 || (vs.length && vs[0] !== g.term)) {
        html += '<div class="variants">含同義詞：' + vs.sort(function (a, b) { return t.byVariant[b] - t.byVariant[a]; })
          .map(function (k) { return esc(k) + ' ' + t.byVariant[k] + ' 次'; }).join('、') + '</div>';
      }
      html += '</li>';
    });
    el.innerHTML = html + '</ul></div>';
  }

  function renderGlossary(groups) {
    $('glossary').innerHTML = groups.filter(function (g) { return g.entry; }).map(function (g) {
      var e = g.entry;
      var alias = (e.aliases || []).length ? '<span class="alias">又稱：' + esc(e.aliases.join('、')) + '</span>' : '';
      return '<div class="gloss"><h3>名詞說明：' + esc(e.term) + alias + '</h3><p>' + esc(e.desc) + '</p></div>';
    }).join('');
  }

  function renderRelated(results, groups) {
    var rel = relatedTerms(results, groups);
    $('related').innerHTML = rel.length ? '<h2>經常一起出現的名詞</h2><div class="chips">' + rel.map(function (r) {
      return '<button class="chip" data-q="' + esc(r.term) + '">' + esc(r.term) + '<small>' + r.n + '</small></button>';
    }).join('') + '</div><p class="hint">數字是在命中段落前後 ' + RELATED_WIN + ' 字內一起出現的次數。點一下可搜尋該名詞。</p>' : '';
    var tb = $('toolbar');
    tb.innerHTML = results.length ? '<span>影片列表</span><button id="csvBtn">下載結果 (CSV)</button>' : '';
  }

  function renderMore() {
    var list = $('list');
    var next = state.results.slice(state.shown, state.shown + PAGE);
    var frag = document.createDocumentFragment();
    next.forEach(function (r) { frag.appendChild(videoCard(r)); });
    list.appendChild(frag);
    state.shown += next.length;
    var left = state.results.length - state.shown;
    $('moreBtn').hidden = left <= 0;
    $('moreBtn').textContent = '顯示更多影片（還有 ' + left + ' 部）';
  }

  function videoCard(r) {
    var v = r.v;
    var el = document.createElement('article');
    el.className = 'video';
    var clusters = clusterHits(r);
    var thumb = RAW.demo ? '' : '<img loading="lazy" alt="" src="https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg">';
    var kind = v.kind === 'manual' ? '人工字幕' : v.kind === 'auto' ? '自動字幕' : '無字幕';
    var badges = state.groups.map(function (g, gi) {
      return r.counts[gi] ? '<span class="badge m' + gi + '">' + esc(g.term) + ' × ' + r.counts[gi] + '</span>' : '';
    }).join('');
    if (r.inTitle.some(Boolean)) badges += '<span class="badge">標題含關鍵字</span>';
    if (!r.total) badges += '<span class="badge">只在標題或影片說明中出現</span>';

    var dots = v.dur ? clusters.map(function (c, i) {
      var left = Math.min(100, c.time / v.dur * 100);
      return '<button data-i="' + i + '" style="left:' + left.toFixed(2) + '%" title="' + fmtTime(c.time) + '"></button>';
    }).join('') : '';

    el.innerHTML =
      '<a class="thumb" href="' + watchUrl(v.id) + '" target="_blank" rel="noopener">' + thumb + '</a>' +
      '<div><h3><a href="' + watchUrl(v.id) + '" target="_blank" rel="noopener">' + esc(v.title) + '</a></h3>' +
      '<div class="meta">' + [v.date, fmtDur(v.dur), kind, clusters.length ? clusters.length + ' 個段落' : ''].filter(Boolean).join(' · ') + '</div>' +
      '<div class="badges">' + badges + '</div>' +
      (dots ? '<div class="timeline" aria-label="命中位置在影片中的分布">' + dots + '</div>' : '') +
      '<ol class="hits"></ol></div>';

    var ol = el.querySelector('.hits');
    function fill(n) {
      ol.innerHTML = clusters.slice(0, n).map(function (c, i) {
        return '<li><button class="ts" data-i="' + i + '">' + fmtTime(c.time) + '</button><span class="snip">' + snippetHtml(v, c) +
          (c.hits.length > 1 ? '<span class="n">（' + c.hits.length + ' 次）</span>' : '') + '</span></li>';
      }).join('');
    }
    fill(SHOW_HITS);
    if (clusters.length > SHOW_HITS) {
      var t = document.createElement('button');
      t.className = 'toggle';
      t.textContent = '顯示全部 ' + clusters.length + ' 個段落';
      t.onclick = function () {
        var open = t.dataset.open === '1';
        fill(open ? SHOW_HITS : clusters.length);
        t.dataset.open = open ? '0' : '1';
        t.textContent = open ? '顯示全部 ' + clusters.length + ' 個段落' : '收合';
      };
      ol.after(t);
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-i]');
      if (b) play(v, clusters[+b.dataset.i].time);
    });
    return el;
  }

  function play(v, t) {
    var start = Math.max(0, Math.floor(t) - 2); // 往前 2 秒，避免剛好切掉開頭
    if (RAW.demo) { alert('示範資料沒有真實影片。實際使用時會從 ' + fmtTime(start) + ' 開始播放。'); return; }
    if (opt.play.value === 'tab') { window.open(watchUrl(v.id, start), '_blank', 'noopener'); return; }
    $('player').hidden = false;
    document.querySelector('.layout').classList.add('with-player');
    $('playerTitle').textContent = v.title + '（' + fmtTime(start) + '）';
    $('playerFrame').src = 'https://www.youtube-nocookie.com/embed/' + v.id + '?autoplay=1&rel=0&start=' + start;
    $('playerLink').href = watchUrl(v.id, start);
    if (window.matchMedia('(max-width: 960px)').matches) $('player').scrollIntoView({ behavior: 'smooth' });
  }

  function closePlayer() {
    $('player').hidden = true;
    $('playerFrame').src = 'about:blank';
    document.querySelector('.layout').classList.remove('with-player');
  }

  function downloadCsv() {
    var rows = [['影片標題', '日期', '時間', '連結', '內容片段', '次數']];
    state.results.forEach(function (r) {
      clusterHits(r).forEach(function (c) {
        var from = Math.max(0, c.start - CONTEXT), to = Math.min(r.v.text.length, c.end + CONTEXT);
        rows.push([r.v.title, r.v.date, fmtTime(c.time), watchUrl(r.v.id, c.time), r.v.text.slice(from, to), c.hits.length]);
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
    var withSubs = videos.filter(function (v) { return v.text; }).length;
    var hours = videos.reduce(function (s, v) { return s + v.dur; }, 0) / 3600;
    var chars = videos.reduce(function (s, v) { return s + v.text.length; }, 0);
    home.innerHTML =
      '<div class="stats">' +
      '<div class="stat"><b>' + videos.length + '</b><span>部影片</span></div>' +
      '<div class="stat"><b>' + withSubs + '</b><span>部有字幕可搜尋</span></div>' +
      '<div class="stat"><b>' + (hours >= 10 ? Math.round(hours) : hours.toFixed(1)) + '</b><span>小時影片</span></div>' +
      '<div class="stat"><b>' + (chars >= 10000 ? (chars / 10000).toFixed(1) + ' 萬' : chars) + '</b><span>字字幕</span></div>' +
      '</div>' +
      (videos.length - withSubs ? '<p class="hint">有 ' + (videos.length - withSubs) + ' 部影片沒有字幕，只能搜尋標題和影片說明。</p>' : '') +
      '<p class="hint">索引更新時間：' + esc(RAW.generated || '未知') + '</p>' +
      '<h2>常見名詞（依出現次數）</h2><div class="chips" id="hot"><span class="hint">計算中…</span></div>' +
      '<p class="hint">名詞說明與同義詞可在 data/glossary.js 中自行增修。</p>';
    setTimeout(function () {
      var counts = GLOSSARY.map(function (g) {
        var n = 0;
        videos.forEach(function (v) { g.variants.forEach(function (x) { n += countIn(v.text, x); }); });
        return { term: g.term, n: n };
      }).filter(function (x) { return x.n; }).sort(function (a, b) { return b.n - a.n; });
      $('hot').innerHTML = counts.length ? counts.map(function (c) {
        return '<button class="chip" data-q="' + esc(c.term) + '">' + esc(c.term) + '<small>' + c.n + '</small></button>';
      }).join('') : '<span class="hint">名詞表中的詞都還沒出現在字幕裡。</span>';
    }, 30);
  }

  // ---------- 事件 ----------
  var timer;
  $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); runSearch($('q').value); });
  $('q').addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { runSearch($('q').value); }, 350);
  });
  [opt.syn, opt.mode].forEach(function (el) { el.addEventListener('change', function () { runSearch($('q').value); }); });
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
    if (e.target.id === 'csvBtn') downloadCsv();
  });

  // ---------- 啟動 ----------
  if (RAW.channel) $('channelLink').href = RAW.channel;
  $('demoBanner').hidden = !RAW.demo;
  if (store('sort')) opt.sort.value = store('sort');
  // 直接開檔案（file://）時 YouTube 內嵌播放器常無法使用，預設改到 YouTube 開啟
  opt.play.value = store('play') || (location.protocol === 'file:' ? 'tab' : 'embed');
  var m = location.hash.match(/q=([^&]*)/);
  runSearch(m ? decodeURIComponent(m[1]) : '');
})();
