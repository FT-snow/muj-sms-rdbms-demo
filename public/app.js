// app.js: browser logic for the DBMS console — section map, enrollment
// actions, polling of tables and logs, SQL box. Plain functions, no framework,
// talks to /api/*.
'use strict';

const state = {
  courses: [],
  courseId: null,
  sectionId: null,        // selected section (free, full, or taken by student)
  selectedEnrollmentId: null,
  students: [],
  tableTab: 'enrollments',
  logTab: 'audit',
  auditSince: 0,
  prevRows: new Map(),    // table row key -> JSON text, for the flash comparison
  lastTrace: [],          // steps of the most recent action, for future views
};

// Status values -> badge color kind. Columns named in BADGE_COLS render as
// badges instead of plain text so the table reads at a glance.
const BADGE_KIND = {
  CONFIRMED: 'ok', PAID: 'ok', INSERT: 'ok', OK: 'ok', ENROLLED: 'ok',
  CANCELLED: 'err', FAILED: 'err', DELETE: 'err', ERROR: 'err', DROPPED: 'err',
  UPDATE: 'info', WAIT: 'wait',
};
const BADGE_COLS = new Set(['status', 'action', 'fee_status']);

function badgeCell(text) {
  const s = document.createElement('span');
  s.className = 'badge b-' + (BADGE_KIND[text] || 'wait');
  s.textContent = text;
  return s;
}

const $ = (id) => document.getElementById(id);

// One fetch wrapper: every API error becomes a thrown {code, message}.
async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(body.message || 'request failed'), { code: body.code });
  return body;
}

const post = (path, data) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

function showError(id, e) {
  const el = $(id);
  el.textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
}

// ---------- courses, students, section map ----------

async function loadCourses() {
  const body = await api('/api/courses');
  state.courses = body.rows;
  const sel = $('course-select');
  sel.textContent = '';
  for (const c of state.courses) {
    const o = document.createElement('option');
    o.value = c.course_id;
    o.textContent = `${c.course_code}  ${c.title}  (${c.department_code})`;
    sel.appendChild(o);
  }
  state.courseId = state.courses[0] ? state.courses[0].course_id : null;
  await refreshSectionMap();
}

async function loadStudents() {
  const body = await api('/api/table/students');
  state.students = body.rows;
  const sel = $('student-select');
  sel.textContent = '';
  for (const p of state.students) {
    const o = document.createElement('option');
    o.value = p.student_id;
    o.textContent = `${p.name}  ${p.email}`;
    sel.appendChild(o);
  }
}

// Section map: full sections and sections of a course this student is already
// enrolled in show an X plus strikethrough (never colour-only) and carry an
// aria-label; clicking a taken section selects its enrollment for dropping.
async function refreshSectionMap() {
  if (state.courseId == null) return;
  const studentId = Number($('student-select').value) || 0;
  const body = await api(`/api/courses/${state.courseId}/sections?student_id=${studentId}`);
  const map = $('section-map');
  map.textContent = '';
  for (const s of body.rows) {
    const blocked = s.enrolled_count >= s.capacity || s.my_course_enrollment_id != null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seat ' + (blocked ? 'booked' : 'free');
    b.setAttribute('aria-label', blocked
      ? `Section ${s.section_no}, ${s.enrolled_count} of ${s.capacity} enrolled${s.my_course_enrollment_id ? ', taken by this student' : ', full'}`
      : `Section ${s.section_no}, ${s.slot}, ${s.enrolled_count} of ${s.capacity} enrolled, fee ${s.fee}`);
    b.title = `Section ${s.section_no} · ${s.slot} · ${s.enrolled_count}/${s.capacity} · fee ${s.fee}`;
    const x = document.createElement('span');
    x.className = 'seatx';
    x.textContent = blocked ? 'X ' : '';
    const label = document.createElement('span');
    label.className = 'slabel';
    label.textContent = s.section_no;
    b.appendChild(x);
    b.appendChild(label);
    if (s.section_id === state.sectionId) b.classList.add(blocked ? 'selected' : 'freesel');
    b.addEventListener('click', () => selectSection(s));
    map.appendChild(b);
  }
}

// One section selected at a time: free section = enrollable, taken section =
// droppable (my_course_enrollment_id is the enrollment to drop).
function selectSection(s) {
  state.sectionId = s.section_id;
  state.selectedEnrollmentId = s.my_course_enrollment_id || null;
  $('btn-drop').disabled = !state.selectedEnrollmentId;
  refreshSectionMap();
}

// ---------- enrollment actions ----------

async function runEnroll(forceFail) {
  $('book-error').textContent = '';
  try {
    const body = await post('/api/enroll', {
      course_id: state.courseId,
      section_id: state.sectionId,
      student_id: Number($('student-select').value),
      hostel_days: Number($('hostel-days').value) || 0,
      fail_at: forceFail ? $('fail-at').value : null,
    });
    renderTrace(body.trace);
    await refreshAfterAction();
  } catch (e) {
    if (e.trace) renderTrace(e.trace);
    showError('book-error', e);
    await refreshAfterAction();
  }
}

async function runDrop() {
  $('book-error').textContent = '';
  try {
    const body = await post(`/api/drop/${state.selectedEnrollmentId}`);
    renderTrace(body.trace);
    state.selectedEnrollmentId = null;
    state.sectionId = null;
    $('btn-drop').disabled = true;
    await refreshAfterAction();
  } catch (e) {
    if (e.trace) renderTrace(e.trace);
    showError('book-error', e);
    await refreshAfterAction();
  }
}

// After any action the tables, section map and audit log may all have moved.
async function refreshAfterAction() {
  await Promise.all([refreshSectionMap(), refreshTable()]);
  if (state.logTab === 'audit') await pollAudit();
}

// ---------- concept demos ----------

async function runConceptDemo(type) {
  $('concept-error').textContent = '';
  try {
    const body = await post('/api/constraint-demo', { type });
    const line = body.code === 'NO_ERROR' || body.code === 'NO_ENROLLMENTS'
      ? `${type}: ${body.message}`
      : `${type}: MySQL error [${body.code} / SQLSTATE ${body.sqlState}] ${body.message}`;
    renderTrace([{ ts: nowTs(), actor: 'DB', step: line, status: body.code === 'NO_ERROR' ? 'OK' : 'ERROR' }]);
    $('concept-error').textContent = line;
  } catch (e) { showError('concept-error', e); }
}

// A vs B on the same section: A wins, B waits on the row lock and then fails.
async function runIsolationDemo() {
  $('concept-error').textContent = '';
  if (state.sectionId == null || state.selectedEnrollmentId != null) {
    $('concept-error').textContent = 'select a FREE section in the section map first';
    return;
  }
  try {
    const body = await post('/api/isolation-demo', {
      course_id: state.courseId,
      section_id: state.sectionId,
      student_id: Number($('student-select').value),
    });
    renderTrace(body.trace);
    await refreshAfterAction();
  } catch (e) {
    if (e.trace) renderTrace(e.trace);
    showError('concept-error', e);
    await refreshAfterAction();
  }
}

// Normalization buttons load the anomaly queries into the SQL box; the user
// runs them and sees what the flat table does (or refuses to do).
const NORM_QUERIES = {
  update: "UPDATE unnormalized_enrollments SET student_email = 'karan.chandel@newmail.com' WHERE enrollment_no = 'EN-1001';",
  insert: "INSERT INTO unnormalized_enrollments (enrollment_no, course_code, course_title, department_name, section_no, fee, fee_status)\nVALUES ('EN-1011', 'CSE301', 'Operating Systems', 'Computer Science and Engineering', 'G1', 45000.00, 'PENDING');",
  delete: 'DELETE FROM unnormalized_enrollments WHERE course_code = \'ECE101\';',
};

function loadNormalizationQuery(kind) {
  $('sql-input').value = NORM_QUERIES[kind] + "\n\n-- then check: SELECT * FROM unnormalized_enrollments;";
  $('sql-input').focus();
}

// ---------- tables (center) ----------

const TABLE_TABS = [
  'enrollments', 'fees', 'hostel_stays', 'sections', 'students', 'courses',
  'departments', 'audit_log', 'unnormalized_enrollments', 'enrollments_1nf', 'enrollments_2nf', 'enrollments_3nf',
];

function renderTableTabs() {
  const nav = $('table-tabs');
  for (const t of TABLE_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.setAttribute('aria-pressed', String(t === state.tableTab));
    b.addEventListener('click', () => { state.tableTab = t; renderTableTabs(); refreshTable(); });
    nav.appendChild(b);
  }
}

// Render the active table; rows that appeared or changed since the last poll
// get the 150ms flash.
async function refreshTable() {
  $('table-error').textContent = '';
  try {
    const body = await api(`/api/table/${state.tableTab}`);
    const table = $('data-table');
    table.textContent = '';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const c of body.columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of body.rows) {
      const key = String(row[body.columns[0]]);
      const json = JSON.stringify(row);
      const tr = document.createElement('tr');
      if (!state.prevRows.has(key) || state.prevRows.get(key) !== json) tr.className = 'flash';
      state.prevRows.set(key, json);
      for (const c of body.columns) {
        const td = document.createElement('td');
        if (BADGE_COLS.has(c) && BADGE_KIND[row[c]]) {
          td.appendChild(badgeCell(row[c]));
        } else {
          td.textContent = row[c] == null ? 'NULL' : String(row[c]);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  } catch (e) {
    state.prevRows.clear();
    showError('table-error', e);
  }
}

// ---------- logs (right) ----------

function setLogTab(tab) {
  state.logTab = tab;
  for (const b of $('log-tabs').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.log === tab));
  }
  $('audit-list').hidden = tab !== 'audit';
  $('general-list').hidden = tab !== 'general';
  $('trace-list').hidden = tab !== 'trace';
}

function nowTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}

function logItem(text, status, tsText, flash) {
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = tsText;
  const s = document.createElement('span');
  s.className = 'status-' + status.toLowerCase();
  s.textContent = status;
  li.appendChild(t);
  li.appendChild(s);
  li.appendChild(document.createTextNode(' ' + text));
  if (flash) li.className = 'flash';
  return li;
}

// Audit log: poll only rows newer than the last one we saw (since=<id>).
async function pollAudit() {
  try {
    const body = await api(`/api/logs/audit?since=${state.auditSince}`);
    const list = $('audit-list');
    for (const r of body.rows) {
      const detail = r.new_data ? JSON.stringify(r.new_data) : JSON.stringify(r.old_data);
      const text = `${r.action} ${r.table_name} row ${r.row_id} ${detail}`;
      // every audit row is a change that actually happened, so status is OK
      list.prepend(logItem(text, 'OK', r.logged_at, true));
      state.auditSince = Math.max(state.auditSince, r.log_id);
    }
    while (list.children.length > 200) list.removeChild(list.lastChild);
  } catch (e) { /* the audit panel stays as-is on a failed poll */ }
}

// General log: newest 30 statements MySQL itself recorded for our user.
async function pollGeneral() {
  try {
    const body = await api('/api/logs/general');
    const list = $('general-list');
    list.textContent = '';
    if (!body.enabled) {
      list.appendChild(logItem('general log is OFF — enable with SET GLOBAL general_log = "ON"', 'OK', '--', false));
      return;
    }
    for (const r of body.rows) {
      list.appendChild(logItem(`${r.command_type} ${r.argument}`, 'OK', r.event_time, false));
    }
  } catch (e) {
    const list = $('general-list');
    list.textContent = '';
    list.appendChild(logItem(e.message, 'ERROR', '--', false));
  }
}

// Transaction trace: the ordered steps of the last action, newest at the top.
function renderTrace(trace) {
  state.lastTrace = trace.slice();
  const list = $('trace-list');
  list.textContent = '';
  const items = trace.slice().reverse();
  for (const s of items) {
    const text = `${s.actor ? s.actor + ' ' : ''}${s.step}`;
    list.appendChild(logItem(text, s.status || 'OK', s.ts, false));
  }
}

// ---------- SQL box ----------

async function runQuery() {
  $('sql-error').textContent = '';
  const sql = $('sql-input').value.trim();
  if (!sql) return;
  try {
    const body = await post('/api/query', { sql });
    const table = $('sql-table');
    table.textContent = '';
    if (body.columns && body.columns.length) {
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      for (const c of body.columns) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = c;
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of body.rows) {
        const tr = document.createElement('tr');
        for (const c of body.columns) {
          const td = document.createElement('td');
          td.textContent = row[c] == null ? 'NULL' : String(row[c]);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    } else {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.textContent = `OK, affected rows: ${body.affectedRows}`;
      tr.appendChild(td);
      table.appendChild(tr);
    }
    await refreshAfterAction();
  } catch (e) {
    $('sql-table').textContent = '';
    showError('sql-error', e);
  }
}

// ---------- top bar ----------

async function checkHealth() {
  const el = $('db-status');
  try {
    await api('/api/health');
    el.textContent = 'connected';
    el.className = 'ok';
  } catch (e) {
    el.textContent = 'not connected';
    el.className = 'bad';
  }
}

async function resetDemo() {
  $('book-error').textContent = '';
  try {
    await post('/api/reset', {});
    state.auditSince = 0;
    state.prevRows.clear();
    state.sectionId = null;
    state.selectedEnrollmentId = null;
    $('btn-drop').disabled = true;
    await loadCourses();
    await refreshAfterAction();
  } catch (e) { showError('book-error', e); }
}

// ---------- wiring ----------

function pollEverything() {
  refreshTable();
  if (state.logTab === 'audit') pollAudit();
  if (state.logTab === 'general') pollGeneral();
  checkHealth();
}

function init() {
  $('course-select').addEventListener('change', (e) => {
    state.courseId = Number(e.target.value);
    state.sectionId = null;
    state.selectedEnrollmentId = null;
    $('btn-drop').disabled = true;
    refreshSectionMap();
  });
  $('student-select').addEventListener('change', () => {
    // the "taken" marks depend on the student, so the map must re-render
    state.sectionId = null;
    state.selectedEnrollmentId = null;
    $('btn-drop').disabled = true;
    refreshSectionMap();
  });
  $('btn-enroll').addEventListener('click', () => runEnroll(false));
  $('btn-enroll-fail').addEventListener('click', () => runEnroll(true));
  $('btn-drop').addEventListener('click', runDrop);
  $('btn-isolation').addEventListener('click', runIsolationDemo);
  $('btn-run').addEventListener('click', runQuery);
  $('sql-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });
  $('btn-reset').addEventListener('click', resetDemo);
  for (const b of document.querySelectorAll('button[data-demo]')) {
    b.addEventListener('click', () => runConceptDemo(b.dataset.demo));
  }
  for (const b of document.querySelectorAll('button[data-norm]')) {
    b.addEventListener('click', () => loadNormalizationQuery(b.dataset.norm));
  }
  for (const b of $('log-tabs').querySelectorAll('button')) {
    b.addEventListener('click', () => setLogTab(b.dataset.log));
  }
  renderTableTabs();
  loadCourses();
  loadStudents();
  refreshTable();
  pollAudit();
  checkHealth();
  setInterval(pollEverything, 2000);
}

init();
