// Tiny DOM helpers.

/**
 * h('div.card#id', {onclick, style, ...attrs}, ...children)
 * Children may be strings, nodes, arrays, null/false (skipped).
 */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root, ...nodes) {
  root.replaceChildren();
  append(root, nodes);
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div#toast');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

export function fmtDuration(sec) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const close = (v) => {
      back.remove();
      resolve(v);
    };
    const back = h(
      'div.modal-back',
      { onclick: (e) => e.target === back && close(false) },
      h(
        'div.modal',
        h('p', message),
        h(
          'div.row.end',
          h('button.btn.ghost', { onclick: () => close(false) }, 'Cancel'),
          h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => close(true) }, okLabel),
        ),
      ),
    );
    document.body.appendChild(back);
  });
}

export const gradeClass = (g) => 'grade-' + (g || 'none').toLowerCase();
