(function (root) {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function httpsUrl(raw) {
    var u;
    try { u = new URL(String(raw)); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    var host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return null;
    if (host.indexOf(':') !== -1) return null;
    return u.href;
  }

  function whenPT(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) + ' PT';
  }

  function rows(list) {
    if (!list || !list.length) return '<p class="research-empty">None published.</p>';
    return list.map(function (r) {
      return '<div class="row"><span class="label">' + esc(r.symbol) + '</span><span class="meta">' +
        esc(r.asset_type || 'Symbol') + '</span></div>';
    }).join('');
  }

  function sources(list) {
    return (list || []).map(function (s) {
      var href = httpsUrl(s && s.url);
      var label = esc((s && (s.label || s.url)) || 'Source');
      var t = whenPT(s && s.published_at);
      var tail = t ? ' · ' + esc(t) : '';
      if (!href) return '<li>' + label + tail + ' <span class="meta">(link withheld)</span></li>';
      return '<li><a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' + tail + '</li>';
    }).join('');
  }

  function finding(f) {
    var risk = f.risk === 'high'
      ? '<span class="pill high">High risk</span>'
      : '<span class="pill active">Baseline</span>';
    var html = '<article class="finding"><h5>' + esc(f.title || 'Untitled') + ' ' + risk + '</h5>';
    html += '<p>' + esc(f.summary || '') + '</p>';
    if (f.horizon) html += '<p class="meta">Horizon: ' + esc(f.horizon) + (f.as_of ? ' · ' + esc(whenPT(f.as_of)) : '') + '</p>';
    if (f.thesis) html += '<p><strong>Thesis.</strong> ' + esc(f.thesis) + '</p>';
    if (f.contrary) html += '<p><strong>Contrary evidence.</strong> ' + esc(f.contrary) + '</p>';
    if (f.catalyst) html += '<p><strong>Catalyst.</strong> ' + esc(f.catalyst) + '</p>';
    if (f.downside) html += '<p><strong>Downside.</strong> ' + esc(f.downside) + '</p>';
    if (f.invalidation) html += '<p><strong>Invalidation.</strong> ' + esc(f.invalidation) + '</p>';
    if (f.impacted && f.impacted.length) html += '<p class="meta">Linked symbols: ' + f.impacted.map(esc).join(', ') + '</p>';
    html += '<ul class="sources">' + sources(f.sources) + '</ul></article>';
    return html;
  }

  function section(title, body) {
    return '<section class="research-sec"><h4>' + title + '</h4>' + body + '</section>';
  }

  function renderCard(state) {
    var s = state || {};
    if (s.authFailed) {
      return '<div class="row"><span class="label">Research could not be read. The session was rejected.</span></div>';
    }
    if (s.readFailed) {
      return '<div class="row"><span class="label">Research could not be read.</span></div>';
    }
    if (s.configured === false) {
      return '<div class="row"><span class="label">Research storage is not set up yet.</span></div>' +
        '<div class="row"><span class="meta">No prices and no brokerage link.</span></div>';
    }
    var holdings = s.holdings || [];
    if (!holdings.length) {
      return '<div class="row"><span class="label">No holdings published.</span></div>' +
        '<div class="row"><span class="meta">Open research for an empty, honest view.</span></div>';
    }
    var body = holdings.slice(0, 5).map(function (h) {
      return '<div class="row"><span class="label">' + esc(h.symbol) + '</span><span class="meta">Holding</span></div>';
    }).join('');
    var fresh = s.lastGood ? ('Updated ' + esc(whenPT(s.lastGood))) : 'No successful publication';
    if (s.attemptFailed) fresh += ' · last attempt failed';
    return body + '<div class="row"><span class="meta">' + fresh + '</span></div>';
  }

  function renderView(state) {
    var s = state || {};
    var intro = s.authFailed
      ? '<p>Research could not be read. The session was rejected. This is not an empty feed.</p>'
      : s.readFailed
      ? '<p>Research could not be read.</p>'
      : s.configured === false
      ? '<p>Research storage is not set up yet. This page is not a quote, a balance, or an order.</p>'
      : '<p>Published notes only. Holdings here are an owner-supplied snapshot, not a live brokerage feed. No prices are shown.</p>';
    if (s.attemptFailed && s.lastGood) {
      intro += '<p class="meta">The latest attempt failed. Notes below are from ' + esc(whenPT(s.lastGood)) + '.</p>';
    }
    var findings = s.findings || [];
    function cat(key, label) {
      var rowsF = findings.filter(function (f) { return f.category === key; });
      return section(label, rowsF.length ? rowsF.map(finding).join('') : '<p class="research-empty">No notes in this section.</p>');
    }
    return intro +
      section('Holdings', rows(s.holdings)) +
      section('Watchlist', rows(s.watch)) +
      section('Candidates', rows(s.candidates)) +
      cat('company_news', 'Company news') +
      cat('global_markets', 'Global markets and trade') +
      cat('world_events', 'World events') +
      cat('analysis', 'Analysis') +
      '<section class="research-sec paper"><h4>Paper analysis <span class="pill stale">Not configured</span></h4>' +
      '<p>No virtual cash, simulated fills, benchmark, or results. Nothing here is a trade. A simulation stays off until a starting balance, execution rules, and a verified price history are chosen.</p></section>';
  }

  function zone(title, body) {
    return '<section class="mkt-zone"><h5>' + title + '</h5>' + body + '</section>';
  }

  function noteCard(title, text) {
    return '<div class="feed-empty"><p class="feed-title">' + title + '</p><p>' + text + '</p></div>';
  }

  function findingBrief(f) {
    return '<article class="finding"><h5>' + esc(f.title || 'Untitled') + '</h5><p>' + esc(f.summary || '') + '</p></article>';
  }

  function renderWorkspace(state) {
    var s = state || {};
    var holdingsBody;
    var newsBody;
    var adviceBody;
    if (s.authFailed) {
      var denied = '<p class="feed-empty">Research could not be read. The session was rejected.</p>';
      holdingsBody = newsBody = adviceBody = denied;
    } else if (s.readFailed) {
      var failed = '<p class="feed-empty">Research could not be read.</p>';
      holdingsBody = newsBody = adviceBody = failed;
    } else if (s.configured === false) {
      holdingsBody = '<p class="feed-empty">No holdings published. Research storage is not set up yet.</p>';
      newsBody = noteCard('Feed not connected', 'Research storage is not set up yet. No quotes are shown.');
      adviceBody = '<p class="feed-empty">No research notes yet.</p>';
    } else {
      var holdings = s.holdings || [];
      holdingsBody = holdings.length
        ? holdings.map(function (h) {
          return '<div class="row"><span class="label">' + esc(h.symbol) + '</span><span class="meta">Holding</span></div>';
        }).join('')
        : '<p class="feed-empty">No holdings published. This is not a live brokerage balance.</p>';
      var findings = s.findings || [];
      var news = findings.filter(function (f) {
        return f.category === 'company_news' || f.category === 'global_markets' || f.category === 'world_events';
      });
      var advice = findings.filter(function (f) { return f.category === 'analysis'; });
      if (!s.lastGood && !news.length) {
        newsBody = noteCard('Feed not connected', 'No publication is on file. No quotes are shown.');
      } else if (!news.length) {
        newsBody = '<p class="feed-empty">No news notes in the latest publication.</p>';
      } else {
        newsBody = news.map(findingBrief).join('');
      }
      adviceBody = advice.length
        ? advice.map(findingBrief).join('')
        : '<p class="feed-empty">No research notes yet. Open research for the full view.</p>';
    }
    return zone('Holdings', holdingsBody) + zone('News', newsBody) + zone('Advice / research', adviceBody);
  }

  root.HQResearch = { esc: esc, httpsUrl: httpsUrl, renderCard: renderCard, renderView: renderView, renderWorkspace: renderWorkspace, whenPT: whenPT };
})(typeof globalThis !== 'undefined' ? globalThis : this);
