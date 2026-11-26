// Admin: edit people, questions and settings. Auth = the projector password (same localStorage key).
import type { DataQuestion, GameData } from '../shared/types.ts';
import { $, showScreen, themeButtons, czPlural, confirmDialog } from './net.ts';

/** What the form holds: may be invalid (empty numbers), the server has the last word. */
interface Draft {
  people: string[];
  questions: DataQuestion[];
  settings: {
    defaultTime: number | null;
    resultsTop: number | null;
    shuffleQuestions: boolean;
    autoEndWhenAllVoted: boolean;
  };
}

class AuthError extends Error {}

themeButtons([$('#themeBtn')]);

const KEY_STORE = 'kdo-host-key';
let key = read();
let saved = ''; // JSON of last saved data, to know if there are unsaved changes

function read(): string | null {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}
function remember(k: string | null): void {
  try {
    if (k) localStorage.setItem(KEY_STORE, k);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* ignore */
  }
}

async function api(method: 'GET'): Promise<GameData>;
async function api(method: 'PUT', body: Draft): Promise<GameData>;
async function api(method: 'GET' | 'PUT', body?: Draft): Promise<GameData> {
  const res = await fetch('/api/data', {
    method,
    headers: { 'x-host-key': key ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('Špatné heslo.');
  const json = (await res.json().catch(() => ({}))) as Partial<GameData> & { error?: string };
  if (!res.ok) throw new Error(json.error || 'Uložení selhalo.');
  return json as GameData;
}

const loginError = $('#loginError');
const editor = $<HTMLFormElement>('#editor');
const questionsList = $('#questions');
const peopleInput = $<HTMLTextAreaElement>('#people');
const saveBtn = $<HTMLButtonElement>('#save');
const statusEl = $('#status');
const field = (id: string) => $<HTMLInputElement>(`#${id}`);

async function load(): Promise<void> {
  if (!key) return showScreen('login');
  showScreen('loading');
  try {
    fill(await api('GET'));
    showScreen('editor');
  } catch (e) {
    if (e instanceof AuthError) {
      remember(null);
      key = null;
      loginError.textContent = e.message;
    } else loginError.textContent = 'Server neodpovídá.';
    showScreen('login');
  }
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $<HTMLInputElement>('#key').value;
  loginError.textContent = '';
  remember(key);
  void load();
});

// ---------- editor ----------

function addRow(q: DataQuestion = { text: '' }): HTMLLIElement {
  const template = $<HTMLTemplateElement>('#qrow');
  const li = $<HTMLLIElement>('li', template.content).cloneNode(true) as HTMLLIElement;
  $<HTMLInputElement>('.qtext-in', li).value = q.text;
  $<HTMLInputElement>('.qtime', li).value = q.time == null ? '' : String(q.time);
  questionsList.append(li);
  return li;
}

function fill(d: GameData): void {
  peopleInput.value = d.people.join('\n');
  questionsList.replaceChildren();
  d.questions.forEach((q) => addRow(q));
  field('defaultTime').value = String(d.settings.defaultTime);
  field('resultsTop').value = String(d.settings.resultsTop);
  field('shuffleQuestions').checked = d.settings.shuffleQuestions;
  field('autoEndWhenAllVoted').checked = d.settings.autoEndWhenAllVoted;
  saved = JSON.stringify(collect());
  refresh();
}

const int = (v: string): number | null => (v === '' ? null : Number(v));

function collect(): Draft {
  const questions: DataQuestion[] = [];
  for (const li of questionsList.children) {
    const text = $<HTMLInputElement>('.qtext-in', li).value.trim();
    const time = int($<HTMLInputElement>('.qtime', li).value);
    if (text) questions.push(time === null ? { text } : { text, time });
  }
  return {
    people: peopleInput.value.split('\n').map((s) => s.trim()).filter(Boolean),
    questions,
    settings: {
      defaultTime: int(field('defaultTime').value),
      resultsTop: int(field('resultsTop').value),
      shuffleQuestions: field('shuffleQuestions').checked,
      autoEndWhenAllVoted: field('autoEndWhenAllVoted').checked,
    },
  };
}

const dirty = (): boolean => JSON.stringify(collect()) !== saved;

function refresh(): void {
  const d = collect();
  const n = d.people.length;
  $('#peopleCount').textContent = `${n} ${czPlural(n, 'hráč', 'hráči', 'hráčů')}`;
  $('#qCount').textContent = String(d.questions.length);
  [...questionsList.children].forEach((li, i) => {
    $('.qn', li).textContent = `${i + 1}.`;
    $<HTMLInputElement>('.qtime', li).placeholder = String(d.settings.defaultTime ?? 20);
  });
  const isDirty = dirty();
  saveBtn.disabled = !isDirty;
  if (isDirty) setStatus('Neuložené změny');
  else if (statusEl.dataset.kind !== 'ok') setStatus('');
}

function setStatus(text: string, kind = ''): void {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

editor.addEventListener('input', refresh);
editor.addEventListener('change', refresh);

$('#addQ').addEventListener('click', () => {
  $<HTMLInputElement>('.qtext-in', addRow()).focus();
  refresh();
});

questionsList.addEventListener('click', async (e) => {
  const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : null;
  const li = btn?.closest('li');
  if (!btn || !li) return;
  const act = btn.dataset.act;
  if (act === 'up' && li.previousElementSibling) li.previousElementSibling.before(li);
  if (act === 'down' && li.nextElementSibling) li.nextElementSibling.after(li);
  if (act === 'del') {
    const text = $<HTMLInputElement>('.qtext-in', li).value.trim();
    if (text && !(await confirmDialog(`Smazat otázku „${text}“?`, 'Smazat'))) return;
    li.remove();
  }
  btn.focus();
  refresh();
});

editor.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!dirty()) return;
  saveBtn.disabled = true;
  setStatus('Ukládám…');
  try {
    fill(await api('PUT', collect()));
    setStatus(`Uloženo · ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
  } catch (err) {
    if (err instanceof AuthError) return load();
    // server message is "Chyba v datech:\n - a\n - b"
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(msg.replace(/^Chyba v datech:\s*/, '').replace(/\n - /g, ' · ').replace(/^- /, ''), 'error');
    saveBtn.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    editor.requestSubmit();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (!editor.hidden && dirty()) e.preventDefault();
});

void load();
