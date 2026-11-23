(function (root) {
  function emptyStore() {
    return { patches: {}, created: [] };
  }

  function pacificYear(date) {
    const when = date instanceof Date ? date : new Date();
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' }).format(when));
  }

  function listingLane(status) {
    const s = String(status || '').toLowerCase();
    if (/sold|closed/.test(s)) return 'sold';
    if (/upcoming|coming soon|pre-?list|pocket/.test(s)) return 'upcoming';
    return 'current';
  }

  function escrowLane(status) {
    return /pipeline/i.test(String(status || '')) ? 'pipeline' : 'escrow';
  }

  function centsFromDollars(value) {
    if (value == null || value === '') return null;
    const raw = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (!Number.isFinite(raw)) return null;
    const cents = Math.round(raw * 100);
    if (!Number.isSafeInteger(cents)) return null;
    return cents;
  }

  function intCents(value) {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }

  function validDate(value) {
    const s = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const parts = s.split('-').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]) return null;
    return s;
  }

  function formatCents(cents) {
    if (!Number.isInteger(cents)) return '';
    const neg = cents < 0;
    const abs = Math.abs(cents);
    const dollars = Math.trunc(abs / 100);
    const rem = abs % 100;
    return (neg ? '-$' : '$') + dollars.toLocaleString('en-US') + '.' + String(rem).padStart(2, '0');
  }

  function fileRecord(row, table) {
    const data = row && row.data && typeof row.data === 'object' ? row.data : {};
    const status = data.status == null ? '' : String(data.status);
    const lane = table === 'listings' ? listingLane(status) : escrowLane(status);
    const kind = table === 'listings' ? 'listing' : (lane === 'pipeline' ? 'pipeline' : 'escrow');
    return {
      key: 'file:' + String(row && row.id != null ? row.id : Math.random()),
      title: data.address || data.subject || data.name || 'Untitled',
      status: status || 'Unlabeled',
      lane: lane,
      kind: kind,
      price_cents: centsFromDollars(data.price),
      net_est_cents: centsFromDollars(data.net_est),
      note: data.note || '',
      terms: data.terms || '',
      mls: data.mls || '',
      closed_on: null,
      source: 'On file'
    };
  }

  function dealRecord(row) {
    const lane = ['current', 'upcoming', 'sold', 'pipeline', 'escrow'].indexOf(row && row.lane) >= 0 ? row.lane : null;
    const kind = ['listing', 'pipeline', 'escrow'].indexOf(row && row.kind) >= 0 ? row.kind : null;
    if (!lane || !kind) return null;
    if (kind === 'listing' && lane !== 'current' && lane !== 'upcoming' && lane !== 'sold') return null;
    if (kind === 'pipeline' && lane !== 'pipeline') return null;
    if (kind === 'escrow' && lane !== 'escrow') return null;
    return {
      key: 'pub:' + String((row && (row.external_key || row.id)) || ''),
      title: (row && row.title) || 'Untitled',
      status: (row && row.status_label) || 'Unlabeled',
      lane: lane,
      kind: kind,
      price_cents: intCents(row.price_cents),
      net_est_cents: intCents(row.net_est_cents),
      note: (row && row.note) || '',
      terms: '',
      mls: '',
      closed_on: validDate(row && row.closed_on),
      source: 'Published'
    };
  }

  function isActiveDeal(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.archived === true) return false;
    if (row.archived_at) return false;
    return true;
  }

  function chooseBook(listings, escrows, deals, state) {
    const rows = Array.isArray(deals) ? deals : [];
    const active = rows.filter(isActiveDeal);
    if (state === 'ready' && rows.length) {
      return { listings: [], escrows: [], deals: active, source: 'deal_records' };
    }
    return {
      listings: Array.isArray(listings) ? listings : [],
      escrows: Array.isArray(escrows) ? escrows : [],
      deals: [],
      source: 'legacy'
    };
  }

  function planText(hqRow, fileText) {
    const body = hqRow && hqRow.body != null ? String(hqRow.body) : '';
    if (body.trim()) return body;
    return fileText == null ? '' : String(fileText);
  }

  function sumCents(records) {
    let total = 0;
    let n = 0;
    records.forEach(function (row) {
      if (!Number.isInteger(row.net_est_cents)) return;
      total += row.net_est_cents;
      n += 1;
    });
    return { cents: n ? total : 0, hasAmount: n > 0, count: n };
  }

  function buildDesk(input) {
    const src = input || {};
    const year = pacificYear(src.now instanceof Date ? src.now : new Date());
    const records = []
      .concat((src.listings || []).map(function (row) { return fileRecord(row, 'listings'); }))
      .concat((src.escrows || []).map(function (row) { return fileRecord(row, 'escrows'); }))
      .concat((src.deals || []).map(dealRecord).filter(Boolean));
    const pipeline = records.filter(function (row) { return row.lane === 'pipeline' || row.kind === 'pipeline'; });
    const projected = sumCents(pipeline);
    const sold = records.filter(function (row) { return row.kind === 'listing' && row.lane === 'sold'; });
    const dated = sold.filter(function (row) { return row.closed_on && Number(row.closed_on.slice(0, 4)) === year; });
    const otherYear = sold.filter(function (row) { return row.closed_on && Number(row.closed_on.slice(0, 4)) !== year; });
    const undated = sold.filter(function (row) { return !row.closed_on; });
    const closed = sumCents(dated);
    let projectedLabel = 'No pipeline records on file.';
    if (pipeline.length && !projected.hasAmount) projectedLabel = 'Pipeline records have no stored net estimate.';
    if (projected.hasAmount) projectedLabel = 'Sum of stored net estimates on pipeline records.';
    let closedLabel = 'No closed amount dated ' + year + '.';
    if (dated.length && !closed.hasAmount) closedLabel = 'Closed records for ' + year + ' have no stored net estimate.';
    if (closed.hasAmount) closedLabel = 'Sum of stored net estimates on records closed in ' + year + '.';
    if (undated.length) {
      closedLabel += ' ' + undated.length + ' sold record' + (undated.length === 1 ? '' : 's') + ' have no close date and are not included.';
    }
    if (otherYear.length) {
      closedLabel += ' Records closed in other years stay in the sold list and are not in this total.';
    }
    return {
      year: year,
      records: records,
      pipeline: pipeline,
      pipelineCount: pipeline.length,
      projected: { cents: projected.cents, hasAmount: projected.hasAmount, label: projectedLabel },
      closed: { cents: closed.cents, hasAmount: closed.hasAmount, undated: undated.length, label: closedLabel },
      tabs: {
        listings: records.filter(function (row) { return row.kind === 'listing' && row.lane === 'current'; }),
        pipeline: pipeline,
        escrows: records.filter(function (row) { return row.kind === 'escrow' && row.lane === 'escrow'; })
      },
      lanes: {
        sold: sold,
        current: records.filter(function (row) { return row.kind === 'listing' && row.lane === 'current'; }),
        upcoming: records.filter(function (row) { return row.kind === 'listing' && row.lane === 'upcoming'; })
      }
    };
  }

  function completedOf(data) {
    return data.completed === true || /^(complete|completed|done)$/i.test(String(data.status || ''));
  }

  function taskFromData(id, data, remote) {
    const src = data && typeof data === 'object' ? data : {};
    return {
      id: String(id),
      remote: !!remote,
      subject: String(src.subject || src.name || '').trim() || 'Untitled',
      note: src.note == null ? '' : String(src.note),
      priority: src.priority == null ? '' : String(src.priority),
      completed: completedOf(src),
      completed_at: src.completed_at || null
    };
  }

  function sameTask(a, b) {
    return a.subject === b.subject && a.note === b.note && a.priority === b.priority
      && !!a.completed === !!b.completed && (a.completed_at || null) === (b.completed_at || null);
  }

  function mergeTasks(remoteRows, store) {
    const src = store || emptyStore();
    const next = { patches: Object.assign({}, src.patches || {}), created: (src.created || []).slice() };
    const items = [];
    const seen = new Set();
    (remoteRows || []).forEach(function (row) {
      if (!row || row.id == null) return;
      const id = String(row.id);
      seen.add(id);
      const base = taskFromData(id, row.data, true);
      const patch = next.patches[id];
      if (!patch) { items.push(base); return; }
      const item = {
        id: id,
        remote: true,
        subject: patch.subject != null ? String(patch.subject) : base.subject,
        note: patch.note != null ? String(patch.note) : base.note,
        priority: patch.priority != null ? String(patch.priority) : base.priority,
        completed: patch.completed != null ? !!patch.completed : base.completed,
        completed_at: patch.completed_at !== undefined ? patch.completed_at : base.completed_at
      };
      if (sameTask(base, item)) delete next.patches[id];
      items.push(item);
    });
    next.created = next.created.filter(function (row) { return row && row.id && !seen.has(String(row.id)); });
    next.created.forEach(function (row) {
      items.push({
        id: String(row.id),
        remote: false,
        subject: String(row.subject || '').trim() || 'Untitled',
        note: row.note == null ? '' : String(row.note),
        priority: row.priority == null ? '' : String(row.priority),
        completed: !!row.completed,
        completed_at: row.completed_at || null
      });
    });
    return { items: items, store: next };
  }

  function absorbHqTasks(remoteRows, store, hqRows) {
    const remoteIds = new Set((remoteRows || []).filter(function (row) { return row && row.id != null; }).map(function (row) { return String(row.id); }));
    const exported = new Set();
    const extras = [];
    (hqRows || []).forEach(function (row) {
      if (!row || row.id == null) return;
      if (row.external_key && remoteIds.has(String(row.external_key))) return;
      if (row.external_key) exported.add(String(row.external_key));
      extras.push({
        id: String(row.id),
        data: {
          subject: row.subject,
          note: row.note,
          priority: row.priority,
          completed: row.completed,
          completed_at: row.completed_at
        }
      });
    });
    const src = store || emptyStore();
    const next = {
      patches: Object.assign({}, src.patches || {}),
      created: (src.created || []).filter(function (row) {
        return row && row.id && !exported.has(String(row.id));
      })
    };
    return mergeTasks((remoteRows || []).concat(extras), next);
  }

  function presentTasks(legacyRows, hqRows, state, store) {
    const hq = (Array.isArray(hqRows) ? hqRows : []).filter(function (row) {
      return row && row.id != null;
    }).slice().sort(function (a, b) {
      const au = Date.parse(a.updated_at || '') || 0;
      const bu = Date.parse(b.updated_at || '') || 0;
      return bu - au;
    });
    const useHq = state === 'ready' && hq.length > 0;
    const src = store || emptyStore();
    const next = {
      patches: Object.assign({}, src.patches || {}),
      created: (src.created || []).slice()
    };
    let remote;
    if (useHq) {
      const exported = new Set();
      hq.forEach(function (row) {
        if (row.external_key) exported.add(String(row.external_key));
      });
      next.created = next.created.filter(function (row) {
        return row && row.id && !exported.has(String(row.id));
      });
      remote = hq.map(function (row) {
        return {
          id: row.id,
          data: {
            subject: row.subject,
            note: row.note == null ? '' : row.note,
            priority: row.priority == null ? '' : row.priority,
            completed: row.completed === true,
            completed_at: row.completed ? (row.completed_at || null) : null
          }
        };
      });
    } else {
      remote = Array.isArray(legacyRows) ? legacyRows : [];
    }
    const merged = mergeTasks(remote, next);
    return { source: useHq ? 'hq_tasks' : 'tasks', items: merged.items, store: merged.store };
  }

  function noteRowsForOutbox(localRows, hqRows, state) {
    const local = (Array.isArray(localRows) ? localRows : []).filter(function (row) {
      return row && String(row.text || '').trim();
    });
    const hq = (Array.isArray(hqRows) ? hqRows : []).filter(function (row) {
      return row && String(row.body || '').trim() && row.status !== 'archived';
    }).slice().sort(function (a, b) {
      const au = Date.parse(a.updated_at || '') || 0;
      const bu = Date.parse(b.updated_at || '') || 0;
      return bu - au;
    });
    if (state !== 'ready' || !hq.length) {
      return local.map(function (row) {
        return { text: String(row.text), meta: 'local', id: row.id, at: row.at || null };
      });
    }
    const keys = new Set();
    hq.forEach(function (row) {
      if (row.external_key) keys.add(String(row.external_key));
    });
    const kept = local.filter(function (row) { return !keys.has(String(row.id)); });
    return hq.map(function (row) {
      return { text: String(row.body), meta: 'hq', id: row.external_key || row.id, at: row.updated_at || null };
    }).concat(kept.map(function (row) {
      return { text: String(row.text), meta: 'local', id: row.id, at: row.at || null };
    }));
  }

  root.HQDesk = {
    emptyStore: emptyStore,
    pacificYear: pacificYear,
    listingLane: listingLane,
    escrowLane: escrowLane,
    formatCents: formatCents,
    buildDesk: buildDesk,
    chooseBook: chooseBook,
    planText: planText,
    mergeTasks: mergeTasks,
    absorbHqTasks: absorbHqTasks,
    presentTasks: presentTasks,
    noteRowsForOutbox: noteRowsForOutbox
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
