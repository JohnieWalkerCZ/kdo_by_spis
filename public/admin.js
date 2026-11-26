// Admin: edit people, questions and settings. Auth = the projector password (same localStorage key).
import { $, showScreen, themeButtons } from './net.js';

themeButtons([$('#themeBtn')]);

const KEY_STORE = 'kdo-host-key';
let key = read();
let saved = ''; // JSON of last saved data, to know if there are unsaved changes

function read() {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}
function remember(k) {
  try {
    k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE);
  } catch {
    /* ignore */
  }
}

async function api(method, body) {
  const res = await fetch('/api/data', {
    method,
    headers: { 'x-host-key': key ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw Object.assign(new Error('Špatné heslo.'), { auth: true });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Uložení selhalo.');
  return json;
}

async function load() {
  if (!key) return showScreen('login');
  showScreen('loading');
  try {
    fill(await api('GET'));
    showScreen('editor');
  } catch (e) {
    if (e.auth) {
      remember(null);
      key = null;
      $('#loginError').textContent = e.message;
    } else $('#loginError').textContent = 'Server neodpovídá.';
    showScreen('login');
  }
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $('#key').value;
  $('#loginError').textContent = '';
  remember(key);
  load();
});

// ---------- editor ----------

function addRow(q = { text: '' }) {
  const li = $('#qrow').content.firstElementChild.cloneNode(true);
  li.querySelector('.qtext-in').value = q.text;
  li.querySelector('.qtime').value = q.time ?? '';
  $('#questions').append(li);
  return li;
}

function fill(d) {
  $('#people').value = d.people.join('\n');
  $('#questions').replaceChildren();
  d.questions.forEach((q) => addRow(q));
  for (const k of ['defaultTime', 'resultsTop']) $(`#${k}`).value = d.settings[k];
  for (const k of ['shuffleQuestions', 'autoEndWhenAllVoted']) $(`#${k}`).checked = d.settings[k];
  saved = JSON.stringify(collect());
  refresh();
}

const int = (v) => (v === '' ? null : Number(v));

function collect() {
  return {
    people: $('#people').value.split('\n').map((s) => s.trim()).filter(Boolean),
    questions: [...$('#questions').children]
      .map((li) => ({ text: li.querySelector('.qtext-in').value.trim(), time: int(li.querySelector('.qtime').value) }))
      .filter((q) => q.text)
      .map((q) => (q.time == null ? { text: q.text } : q)),
    settings: {
      defaultTime: int($('#defaultTime').value),
      resultsTop: int($('#resultsTop').value),
      shuffleQuestions: $('#shuffleQuestions').checked,
      autoEndWhenAllVoted: $('#autoEndWhenAllVoted').checked,
    },
  };
}

const dirty = () => JSON.stringify(collect()) !== saved;

function refresh() {
  const d = collect();
  const n = d.people.length;
  $('#peopleCount').textContent = `${n} ${n === 1 ? 'hráč' : n >= 2 && n <= 4 ? 'hráči' : 'hráčů'}`;
  $('#qCount').textContent = d.questions.length;
  [...$('#questions').children].forEach((li, i) => {
    li.querySelector('.qn').textContent = `${i + 1}.`;
    li.querySelector('.qtime').placeholder = String(d.settings.defaultTime ?? 20);
  });
  const isDirty = dirty();
  $('#save').disabled = !isDirty;
  if (isDirty) setStatus('Neuložené změny');
  else if ($('#status').dataset.kind !== 'ok') setStatus('');
}

function setStatus(text, kind = '') {
  $('#status').textContent = text;
  $('#status').dataset.kind = kind;
}

$('#editor').addEventListener('input', refresh);
$('#editor').addEventListener('change', refresh);

$('#addQ').addEventListener('click', () => {
  addRow().querySelector('.qtext-in').focus();
  refresh();
});

$('#questions').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('li');
  const act = btn.dataset.act;
  if (act === 'up' && li.previousElementSibling) li.previousElementSibling.before(li);
  if (act === 'down' && li.nextElementSibling) li.nextElementSibling.after(li);
  if (act === 'del') {
    const text = li.querySelector('.qtext-in').value.trim();
    if (text && !confirm(`Smazat otázku „${text}“?`)) return;
    li.remove();
  }
  btn.focus();
  refresh();
});

$('#editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!dirty()) return;
  $('#save').disabled = true;
  setStatus('Ukládám…');
  try {
    const d = await api('PUT', collect());
    fill(d);
    setStatus(`Uloženo · ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
  } catch (err) {
    if (err.auth) return load();
    // server message is "Chyba v datech:\n - a\n - b"
    setStatus(err.message.replace(/^Chyba v datech:\s*/, '').replace(/\n - /g, ' · ').replace(/^- /, ''), 'error');
    $('#save').disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    $('#editor').requestSubmit();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (!$('#editor').hidden && dirty()) e.preventDefault();
});

load();
