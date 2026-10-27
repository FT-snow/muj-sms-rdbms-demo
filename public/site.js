// site.js: student portal — pick a course, pick a section, register the
// student, confirm the enrollment. The checkout shows the real transaction
// trace from the API, so the "website" and the DBMS teaching view stay one
// system.
'use strict';

const site = {
  view: 'console',
  courses: [],
  courseId: null,
  course: null,
  section: null,        // selected section object from /api/courses/:id/sections
  students: [],
  studentId: null,
  coursesStudentId: null,
};

const $s = (id) => document.getElementById(id);

// Same error contract as app.js: non-ok API answers become thrown errors.
async function jfetch(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(body.message || 'request failed'), { code: body.code });
  return body;
}

const jpost = (path, data) => jfetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

// ---------- view switcher ----------

function setView(view) {
  site.view = view;
  const isSite = view === 'site';
  $s('site-view').hidden = !isSite;
  $s('layout').hidden = isSite;
  for (const b of $s('view-switch').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  }
}

// ---------- step 1: courses ----------

async function loadSiteCourses() {
  const body = await jfetch('/api/courses');
  site.courses = body.rows;
  const list = $s('course-list');
  list.textContent = '';
  for (const c of site.courses) {
    const li = document.createElement('li');
    li.dataset.courseId = String(c.course_id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flight-row' + (c.course_id === site.courseId ? ' sel' : '');
    btn.setAttribute('aria-label', `Course ${c.course_code}, ${c.title}, ${c.department_name}, from ${c.min_fee}, ${c.free_capacity} seats free`);
    const no = document.createElement('span');
    no.className = 'fno';
    no.textContent = c.course_code;
    const route = document.createElement('span');
    route.className = 'route';
    route.textContent = `${c.title} · ${c.department_name}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `starts ${c.starts_at.slice(0, 16)} · from ${c.min_fee} · ${c.free_capacity} free`;
    btn.appendChild(no);
    btn.appendChild(route);
    btn.appendChild(meta);
    btn.addEventListener('click', () => selectSiteCourse(c.course_id));
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (site.courseId == null && site.courses[0]) await selectSiteCourse(site.courses[0].course_id);
}

async function selectSiteCourse(courseId) {
  site.courseId = courseId;
  site.course = site.courses.find((c) => c.course_id === courseId) || null;
  site.section = null;
  for (const li of $s('course-list').querySelectorAll('li[data-course-id]')) {
    const btn = li.querySelector('.flight-row');
    btn.classList.toggle('sel', Number(li.dataset.courseId) === courseId);
  }
  await loadPortalSections();
  updateSummary();
}

// ---------- step 2: section picker ----------

// Section buttons with live occupancy; full sections and sections of a course
// the chosen student already takes are crossed out (never colour-only).
async function loadPortalSections() {
  if (site.courseId == null) return;
  const studentId = Number($s('site-student').value) || 0;
  const body = await jfetch(`/api/courses/${site.courseId}/sections?student_id=${studentId}`);
  const slots = {};
  for (const s of body.rows) {
    (slots[s.slot] = slots[s.slot] || []).push(s);
  }
  const box = $s('portal-sections');
  box.textContent = '';
  $s('section-legend').textContent =
    Object.entries(slots).map(([slot, arr]) => `${slot} fee ${arr[0].fee}`).join(' · ');
  for (const slot of Object.keys(slots)) {
    const div = document.createElement('div');
    div.className = 'cabin-row';
    const label = document.createElement('span');
    label.className = 'rowno';
    label.textContent = slot === 'MORNING' ? 'AM' : 'PM';
    div.appendChild(label);
    for (const s of slots[slot]) {
      const b = document.createElement('button');
      b.type = 'button';
      const full = s.enrolled_count >= s.capacity;
      const taken = s.my_course_enrollment_id != null;
      b.className = 'seat ' + (full || taken ? 'booked' : 'free');
      b.setAttribute('aria-label', full
        ? `Section ${s.section_no}, full, ${s.enrolled_count} of ${s.capacity}`
        : taken
          ? `Section ${s.section_no}, this student is enrolled in this course`
          : `Section ${s.section_no}, ${s.slot}, ${s.capacity - s.enrolled_count} of ${s.capacity} free, fee ${s.fee}`);
      const x = document.createElement('span');
      x.className = 'seatx';
      x.textContent = full || taken ? 'X ' : '';
      const labelEl = document.createElement('span');
      labelEl.className = 'slabel';
      labelEl.textContent = `${s.section_no} ${s.enrolled_count}/${s.capacity}`;
      b.appendChild(x);
      b.appendChild(labelEl);
      b.title = `Section ${s.section_no} · ${s.slot} · ${s.enrolled_count}/${s.capacity} · fee ${s.fee}`;
      if (site.section && s.section_id === site.section.section_id) b.classList.add('freesel');
      b.addEventListener('click', () => selectPortalSection(s));
      div.appendChild(b);
    }
    box.appendChild(div);
  }
}

function selectPortalSection(s) {
  if (s.enrolled_count >= s.capacity) {
    $s('pax-error').textContent = `section ${s.section_no} is full (${s.enrolled_count}/${s.capacity})`;
    return;
  }
  if (s.my_course_enrollment_id != null) {
    $s('pax-error').textContent = 'this student is already enrolled in this course — drop it from My courses instead';
    return;
  }
  $s('pax-error').textContent = '';
  site.section = s;
  loadPortalSections();  // re-render to move the selection outline
  updateSummary();
}

// ---------- step 3: student + hostel ----------

async function loadSiteStudents() {
  const body = await jfetch('/api/table/students');
  site.students = body.rows;
  for (const selId of ['site-student', 'site-courses-student']) {
    const sel = $s(selId);
    const current = sel.value;
    sel.textContent = '';
    for (const p of site.students) {
      const o = document.createElement('option');
      o.value = p.student_id;
      o.textContent = `${p.name}  ${p.email}`;
      sel.appendChild(o);
    }
    if (current) sel.value = current;
  }
  if (site.studentId == null && site.students[0]) site.studentId = site.students[0].student_id;
  if (site.coursesStudentId == null && site.students[0]) site.coursesStudentId = site.students[0].student_id;
  $s('site-student').value = String(site.studentId);
  $s('site-courses-student').value = String(site.coursesStudentId);
}

async function addStudent() {
  $s('ns-error').textContent = '';
  try {
    const body = await jpost('/api/students', {
      name: $s('ns-name').value,
      email: $s('ns-email').value,
      phone: $s('ns-phone').value,
    });
    await loadSiteStudents();
    site.studentId = body.row.student_id;
    $s('site-student').value = String(site.studentId);
    $s('ns-name').value = '';
    $s('ns-email').value = '';
    $s('ns-phone').value = '';
    $s('new-student').open = false;
    updateSummary();
  } catch (e) {
    $s('ns-error').textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
  }
}

// ---------- checkout ----------

function updateSummary() {
  const c = site.course, s = site.section;
  const days = Number($s('site-hostel').value) || 0;
  $s('sum-course').textContent = c ? `${c.course_code} ${c.title}` : '—';
  $s('sum-section').textContent = s ? `${s.section_no} (${s.slot})` : '—';
  $s('sum-fee').textContent = s ? s.fee : '—';
  $s('sum-hostel').textContent = days > 0 ? `${days} days = ${days * 150}.00` : 'none';
  const total = s ? Number(s.fee) + days * 150 : null;
  $s('sum-total').textContent = total != null ? total.toFixed(2) : '—';
  $s('site-enroll').disabled = !(c && s && site.studentId);
}

// Confirm enrollment: one API call that runs the ONE transaction on the
// server; its step list is rendered as the trace next to the button.
async function siteEnroll() {
  $s('site-error').textContent = '';
  $s('site-ticket').hidden = true;
  $s('site-enroll').disabled = true;
  const days = Number($s('site-hostel').value) || 0;
  try {
    const body = await jpost('/api/enroll', {
      course_id: site.courseId,
      section_id: site.section.section_id,
      student_id: site.studentId,
      hostel_days: days,
    });
    renderSiteTrace(body.trace);
    await showSlip(body.enrollment_id);
  } catch (e) {
    if (e.trace) renderSiteTrace(e.trace);
    $s('site-error').textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
  }
  site.section = null;
  await loadPortalSections();
  await loadMyCourses();
  updateSummary();
  $s('site-enroll').disabled = !(site.course && site.section && site.studentId);
}

async function showSlip(enrollmentId) {
  // Read back the committed rows: the slip is built from the database, not
  // from what the browser hoped happened.
  const body = await jfetch(`/api/enrollments?student_id=${site.studentId}`);
  const row = body.rows.find((r) => r.enrollment_id === enrollmentId);
  if (!row) return;
  $s('tkt-id').textContent = '#' + row.enrollment_id;
  $s('tkt-course').textContent = `${row.course_code} ${row.title}`;
  $s('tkt-section').textContent = row.section_no;
  const p = site.students.find((x) => x.student_id === site.studentId);
  $s('tkt-student').textContent = p ? p.name : ('student ' + site.studentId);
  const total = Number(row.amount) + Number(row.hostel_fee);
  const totalEl = $s('tkt-total');
  totalEl.textContent = total.toFixed(2) + '  ';
  const badge = document.createElement('span');
  badge.className = 'badge b-' + (row.fee_status === 'PAID' ? 'ok' : 'err');
  badge.textContent = row.fee_status;
  totalEl.appendChild(badge);
  $s('site-ticket').hidden = false;
}

// ---------- my courses ----------

async function loadMyCourses() {
  $s('courses-error').textContent = '';
  if (site.coursesStudentId == null) return;
  try {
    const body = await jfetch(`/api/enrollments?student_id=${site.coursesStudentId}`);
    const list = $s('site-courses');
    list.textContent = '';
    if (!body.rows.length) {
      const li = document.createElement('li');
      li.textContent = 'no enrollments yet';
      list.appendChild(li);
      return;
    }
    for (const r of body.rows) {
      const li = document.createElement('li');
      const line = document.createElement('span');
      line.className = 'trip-line';
      line.textContent = `#${r.enrollment_id}  ${r.course_code} ${r.section_no}  ${r.title}`;
      const badge = document.createElement('span');
      badge.className = 'badge b-' + (r.status === 'ENROLLED' ? 'ok' : 'err');
      badge.textContent = r.status;
      const amt = document.createElement('span');
      amt.className = 'trip-amt';
      amt.textContent = (Number(r.amount) + Number(r.hostel_fee)).toFixed(2);
      li.appendChild(line);
      li.appendChild(badge);
      li.appendChild(amt);
      if (r.status === 'ENROLLED') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'danger-text';
        btn.textContent = 'Drop';
        btn.setAttribute('aria-label', `Drop enrollment ${r.enrollment_id}`);
        btn.addEventListener('click', () => dropCourse(r.enrollment_id));
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  } catch (e) {
    $s('courses-error').textContent = e.message;
  }
}

async function dropCourse(enrollmentId) {
  $s('courses-error').textContent = '';
  try {
    const body = await jpost(`/api/drop/${enrollmentId}`);
    renderSiteTrace(body.trace);
  } catch (e) {
    if (e.trace) renderSiteTrace(e.trace);
    $s('courses-error').textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
  }
  await loadMyCourses();
  if (site.courseId != null) await loadPortalSections();
}

// ---------- portal-side transaction trace ----------

function renderSiteTrace(trace) {
  const list = $s('site-trace-list');
  list.textContent = '';
  for (const s of trace.slice().reverse()) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = s.ts;
    const st = document.createElement('span');
    st.className = 'status-' + (s.status || 'OK').toLowerCase();
    st.textContent = s.status || 'OK';
    li.appendChild(t);
    li.appendChild(st);
    li.appendChild(document.createTextNode(` ${s.actor ? s.actor + ' ' : ''}${s.step}`));
    list.appendChild(li);
  }
}

// ---------- wiring ----------

function initSite() {
  for (const b of $s('view-switch').querySelectorAll('button')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  $s('site-student').addEventListener('change', (e) => {
    site.studentId = Number(e.target.value);
    site.section = null;
    loadPortalSections();
    updateSummary();
  });
  $s('site-courses-student').addEventListener('change', (e) => { site.coursesStudentId = Number(e.target.value); loadMyCourses(); });
  $s('site-hostel').addEventListener('input', updateSummary);
  $s('btn-add-student').addEventListener('click', addStudent);
  $s('site-enroll').addEventListener('click', siteEnroll);
  setView('console');
  loadSiteCourses();
  loadSiteStudents();
  loadMyCourses();
}

initSite();
