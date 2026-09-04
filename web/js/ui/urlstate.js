/**
 * Shareable translator URL state (?from=&to=&q=&html=1&auto=1&align=1).
 */

export const Q_MAX = 2000;

/**
 * @typedef {{
 *   from?: string,
 *   to?: string,
 *   q?: string,
 *   html?: boolean,
 *   auto?: boolean,
 *   align?: boolean,
 * }} UrlState
 */

/**
 * @param {string | URLSearchParams} [search]
 * @param {Set<string> | string[]} [allowedLangs]
 * @returns {UrlState}
 */
export function parseUrlState(search, allowedLangs) {
  const params =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search instanceof URLSearchParams
        ? search
        : new URLSearchParams();

  const allow = allowedLangs
    ? allowedLangs instanceof Set
      ? allowedLangs
      : new Set(allowedLangs)
    : null;

  /** @type {UrlState} */
  const out = {};
  const from = (params.get('from') || '').trim().toLowerCase();
  const to = (params.get('to') || '').trim().toLowerCase();
  if (from && (!allow || allow.has(from))) {
    out.from = from;
  }
  if (to && (!allow || allow.has(to))) {
    out.to = to;
  }
  if (params.has('q')) {
    out.q = truncateQ(params.get('q') || '');
  }
  if (params.has('html')) {
    out.html = truthy(params.get('html'));
  }
  if (params.has('auto')) {
    out.auto = truthy(params.get('auto'));
  }
  if (params.has('align')) {
    out.align = truthy(params.get('align'));
  }
  return out;
}

/**
 * @param {UrlState} state
 * @param {{includeQ?: boolean}} [opts]
 * @returns {string}
 */
export function buildUrlSearch(state, opts = {}) {
  const params = new URLSearchParams();
  if (state.from) {
    params.set('from', state.from);
  }
  if (state.to) {
    params.set('to', state.to);
  }
  if (opts.includeQ !== false && state.q) {
    params.set('q', truncateQ(state.q));
  }
  if (state.html) {
    params.set('html', '1');
  }
  if (state.auto) {
    params.set('auto', '1');
  }
  if (state.align) {
    params.set('align', '1');
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * @param {UrlState} state
 * @param {{includeQ?: boolean, replace?: boolean}} [opts]
 */
export function syncUrlState(state, opts = {}) {
  if (typeof history === 'undefined' || typeof location === 'undefined') {
    return;
  }
  const search = buildUrlSearch(state, { includeQ: opts.includeQ });
  const next = `${location.pathname}${search}${location.hash || ''}`;
  const cur = `${location.pathname}${location.search}${location.hash || ''}`;
  if (next === cur) {
    return;
  }
  if (opts.replace === false) {
    history.pushState(null, '', next);
  } else {
    history.replaceState(null, '', next);
  }
}

/**
 * @param {string} q
 * @returns {string}
 */
export function truncateQ(q) {
  const s = String(q ?? '');
  if (s.length <= Q_MAX) {
    return s;
  }
  return s.slice(0, Q_MAX);
}

/**
 * @param {string | null} v
 * @returns {boolean}
 */
function truthy(v) {
  if (v == null || v === '') {
    return false;
  }
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
