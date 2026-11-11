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

  root.HQDesk = {
    emptyStore: emptyStore,
    pacificYear: pacificYear,
    listingLane: listingLane,
    escrowLane: escrowLane,
    formatCents: formatCents,
    buildDesk: buildDesk,
    mergeTasks: mergeTasks
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
