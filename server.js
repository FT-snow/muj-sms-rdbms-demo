// server.js: Express routes for the muj_sms demo — enrollment as one
// transaction, constraint and isolation demos, table views, raw SQL, logs.
// The MySQL pool and helpers live in db.js.
const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { pool, TABLE_SQL, dbError, ts, sleep } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// One enrollment as ONE transaction: lock the section row, insert enrollment,
// fee, and optional hostel stay, then commit. failAt throws mid-way to demo
// ROLLBACK. WHY the lock: two registrations fighting for the last seats of a
// section serialise at SELECT FOR UPDATE, so the trigger check and the insert
// see a stable world.
async function enrollStudent(conn, o, trace, actor = 'APP') {
  const step = (text, status) => trace.push({ ts: ts(), actor, step: text, status: status || 'OK' });
  await conn.beginTransaction();
  step('BEGIN');
  const [sec] = await conn.query(
    'SELECT section_id, course_id, section_no, fee FROM sections WHERE section_id = ? FOR UPDATE', [o.sectionId]);
  if (!sec.length) { const e = new Error('Section not found'); e.code = 'SECTION_NOT_FOUND'; throw e; }
  if (sec[0].course_id !== o.courseId) { const e = new Error('Section is not of this course'); e.code = 'SECTION_COURSE_MISMATCH'; throw e; }
  step(`SELECT section ${sec[0].section_no} FOR UPDATE -> row lock held`);
  const [en] = await conn.query(
    "INSERT INTO enrollments (course_id, section_id, student_id, status) VALUES (?, ?, ?, 'ENROLLED')",
    [o.courseId, o.sectionId, o.studentId]);
  step(`INSERT enrollments -> enrollment_id ${en.insertId}`);
  if (o.failAt === 'enrollment') { const e = new Error('Forced failure after enrollment insert'); e.code = 'FORCED_FAILURE'; throw e; }
  const [fee] = await conn.query(
    "INSERT INTO fees (enrollment_id, amount, status) VALUES (?, ?, 'PAID')",
    [en.insertId, sec[0].fee]);
  step(`INSERT fees -> fee_id ${fee.insertId}, amount ${sec[0].fee}`);
  if (o.failAt === 'fee') { const e = new Error('Forced failure after fee insert'); e.code = 'FORCED_FAILURE'; throw e; }
  if (o.hostelDays > 0) {
    // Fee rule kept deliberately simple: 150.00 per day, one row per stay.
    const [st] = await conn.query('INSERT INTO hostel_stays (enrollment_id, days, fee) VALUES (?, ?, ?)',
      [en.insertId, o.hostelDays, o.hostelDays * 150]);
    step(`INSERT hostel_stays -> stay_id ${st.insertId}, ${o.hostelDays} days, fee ${o.hostelDays * 150}`);
  }
  if (o.failAt === 'hostel') { const e = new Error('Forced failure after hostel insert'); e.code = 'FORCED_FAILURE'; throw e; }
  await conn.commit();
  step('COMMIT');
  return { enrollmentId: en.insertId };
}

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, db: 'connected' });
}));

app.get('/api/courses', wrap(async (req, res) => {
  // Subqueries give the portal what it needs: cheapest fee and how many seats
  // are still free across all sections (an enrollment is free capacity when
  // its status is ENROLLED).
  const [rows] = await pool.query(
    `SELECT c.course_id, c.course_code, c.title, d.code AS department_code, d.name AS department_name,
            c.starts_at,
            (SELECT MIN(s.fee) FROM sections s WHERE s.course_id = c.course_id) AS min_fee,
            (SELECT COALESCE(SUM(s.capacity), 0) FROM sections s WHERE s.course_id = c.course_id)
              - (SELECT COUNT(*) FROM enrollments e
                 JOIN sections s2 ON s2.section_id = e.section_id
                 WHERE s2.course_id = c.course_id AND e.status = 'ENROLLED') AS free_capacity
     FROM courses c
     JOIN departments d ON d.department_id = c.department_id
     ORDER BY c.course_id`);
  res.json({ ok: true, rows });
}));

app.get('/api/courses/:id/sections', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const studentId = Number(req.query.student_id) || 0;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'course id must be a positive integer' });
  // LEFT JOIN on the calling student's ENROLLED rows only: a section is "mine"
  // when this student is enrolled in it (or anywhere in this course, because
  // the rule is one enrollment per course).
  const [rows] = await pool.query(
    `SELECT s.section_id, s.section_no, s.slot, s.capacity, s.fee,
            (SELECT COUNT(*) FROM enrollments e
             WHERE e.section_id = s.section_id AND e.status = 'ENROLLED') AS enrolled_count,
            (SELECT e.enrollment_id FROM enrollments e
             WHERE e.section_id = s.section_id AND e.student_id = ? AND e.status = 'ENROLLED') AS my_enrollment_id,
            (SELECT e2.enrollment_id FROM enrollments e2
             WHERE e2.course_id = s.course_id AND e2.student_id = ? AND e2.status = 'ENROLLED') AS my_course_enrollment_id
     FROM sections s
     WHERE s.course_id = ?
     ORDER BY s.section_no, s.slot`, [studentId, studentId, id]);
  res.json({ ok: true, rows });
}));

app.post('/api/students', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const phone = String(b.phone || '').trim();
  if (!name || !email) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'name and email are required' });
  try {
    const [r] = await pool.query('INSERT INTO students (name, email, phone) VALUES (?, ?, ?)', [name, email, phone || null]);
    const [rows] = await pool.query('SELECT student_id, name, email, phone FROM students WHERE student_id = ?', [r.insertId]);
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    // the UNIQUE(email) constraint did the validation for us
    if (e.errno === 1062) return res.status(409).json({ ok: false, code: 1062, message: 'email already registered — pick that student from the list instead' });
    throw e;
  }
}));

app.get('/api/enrollments', wrap(async (req, res) => {
  // "My courses": one student's enrollments with course, section, fee and
  // hostel fees joined in, newest first.
  const sid = Number(req.query.student_id);
  if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'student_id must be a positive integer' });
  const [rows] = await pool.query(
    `SELECT en.enrollment_id, en.status, en.created_at, c.course_code, c.title,
            s.section_no, IFNULL(f.amount, 0) AS amount, IFNULL(f.status, '-') AS fee_status,
            (SELECT IFNULL(SUM(h.fee), 0) FROM hostel_stays h WHERE h.enrollment_id = en.enrollment_id) AS hostel_fee
     FROM enrollments en
     JOIN courses c ON c.course_id = en.course_id
     JOIN sections s ON s.section_id = en.section_id
     LEFT JOIN fees f ON f.enrollment_id = en.enrollment_id
     WHERE en.student_id = ?
     ORDER BY en.enrollment_id DESC`, [sid]);
  res.json({ ok: true, rows });
}));

app.get('/api/table/:name', wrap(async (req, res) => {
  const sql = TABLE_SQL[req.params.name];
  if (!sql) return res.status(404).json({ ok: false, code: 'UNKNOWN_TABLE', message: 'table not whitelisted: ' + req.params.name });
  const [rows, fields] = await pool.query(sql);
  res.json({ ok: true, columns: fields.map((f) => f.name), rows });
}));

app.post('/api/enroll', async (req, res) => {
  const b = req.body || {};
  const courseId = Number(b.course_id), sectionId = Number(b.section_id), studentId = Number(b.student_id);
  const hostelDays = b.hostel_days == null ? 0 : Number(b.hostel_days);
  const failAt = b.fail_at || null;
  if (!Number.isInteger(courseId) || !Number.isInteger(sectionId) || !Number.isInteger(studentId)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'course_id, section_id and student_id must be integers' });
  }
  if (failAt && !['enrollment', 'fee', 'hostel'].includes(failAt)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'fail_at must be enrollment, fee, hostel or null' });
  }
  // WHY getConnection: the transaction needs one dedicated connection for its
  // whole life; the pool just lends it, and finally always gives it back.
  const conn = await pool.getConnection();
  const trace = [];
  try {
    const r = await enrollStudent(conn, { courseId, sectionId, studentId, hostelDays, failAt }, trace);
    res.json({ ok: true, committed: true, enrollment_id: r.enrollmentId, trace });
  } catch (e) {
    // WHY rollback here: any failure after BEGIN must undo every insert, and the
    // trace must show the ROLLBACK so the audience sees atomicity happen.
    try { await conn.rollback(); trace.push({ ts: ts(), actor: 'APP', step: 'ROLLBACK', status: 'ERROR' }); } catch (_) { /* connection gone */ }
    const d = dbError(e);
    res.status(409).json({ ok: false, committed: false, code: d.code, sqlState: d.sqlState, message: d.message, trace });
  } finally {
    conn.release();
  }
});

app.post('/api/drop/:enrollmentId', async (req, res) => {
  const id = Number(req.params.enrollmentId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'enrollment id must be a positive integer' });
  const conn = await pool.getConnection();
  const trace = [];
  try {
    await conn.beginTransaction();
    trace.push({ ts: ts(), actor: 'APP', step: 'BEGIN', status: 'OK' });
    const [en] = await conn.query('SELECT enrollment_id, status FROM enrollments WHERE enrollment_id = ? FOR UPDATE', [id]);
    if (!en.length) { await conn.rollback(); return res.status(404).json({ ok: false, committed: false, code: 'NOT_FOUND', message: `enrollment ${id} does not exist`, trace }); }
    if (en[0].status === 'DROPPED') { await conn.rollback(); return res.status(409).json({ ok: false, committed: false, code: 'ALREADY_DROPPED', message: `enrollment ${id} is already DROPPED`, trace }); }
    await conn.query("UPDATE enrollments SET status = 'DROPPED' WHERE enrollment_id = ?", [id]);
    trace.push({ ts: ts(), actor: 'APP', step: `UPDATE enrollments -> enrollment_id ${id} now DROPPED`, status: 'OK' });
    await conn.query("UPDATE fees SET status = 'FAILED' WHERE enrollment_id = ?", [id]);
    trace.push({ ts: ts(), actor: 'APP', step: `UPDATE fees -> voided for enrollment ${id}`, status: 'OK' });
    await conn.commit();
    trace.push({ ts: ts(), actor: 'APP', step: 'COMMIT', status: 'OK' });
    res.json({ ok: true, committed: true, trace });
  } catch (e) {
    try { await conn.rollback(); trace.push({ ts: ts(), actor: 'APP', step: 'ROLLBACK', status: 'ERROR' }); } catch (_) { /* connection gone */ }
    const d = dbError(e);
    res.status(409).json({ ok: false, committed: false, code: d.code, sqlState: d.sqlState, message: d.message, trace });
  } finally {
    conn.release();
  }
});

app.post('/api/constraint-demo', wrap(async (req, res) => {
  const type = (req.body || {}).type;
  // Each demo runs one deliberately invalid statement so MySQL itself refuses
  // it; the raw code + message are the point of the demo.
  let sql, params = [];
  if (type === 'fk') {
    sql = "INSERT INTO courses (course_code, title, department_id, starts_at) VALUES ('CSE999', 'Ghost Course', 999, '2026-12-01 08:00:00')";
  } else if (type === 'unique') {
    sql = "INSERT INTO students (name, email, phone) VALUES ('Demo Duplicate', 'karan.chandel@mail.com', NULL)";
  } else if (type === 'check') {
    const [en] = await pool.query('SELECT enrollment_id FROM enrollments ORDER BY enrollment_id LIMIT 1');
    if (!en.length) return res.json({ ok: true, demo: type, code: 'NO_ENROLLMENTS', message: 'no enrollment exists to attach a bad hostel stay to' });
    sql = 'INSERT INTO hostel_stays (enrollment_id, days, fee) VALUES (?, 50, 7500.00)';
    params = [en[0].enrollment_id];
  } else if (type === 'trigger') {
    const [en] = await pool.query("SELECT course_id, section_id, student_id FROM enrollments WHERE status = 'ENROLLED' ORDER BY enrollment_id LIMIT 1");
    if (!en.length) return res.json({ ok: true, demo: type, code: 'NO_ENROLLMENTS', message: 'no ENROLLED enrollment exists to collide with' });
    sql = "INSERT INTO enrollments (course_id, section_id, student_id, status) VALUES (?, ?, ?, 'ENROLLED')";
    params = [en[0].course_id, en[0].section_id, en[0].student_id];
  } else {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'type must be fk, unique, check or trigger' });
  }
  try {
    await pool.query(sql, params);
    res.json({ ok: true, demo: type, code: 'NO_ERROR', message: 'statement unexpectedly succeeded' });
  } catch (e) {
    const d = dbError(e);
    res.json({ ok: true, demo: type, sql, code: d.code, sqlState: d.sqlState, message: d.message });
  }
}));

app.post('/api/isolation-demo', async (req, res) => {
  const b = req.body || {};
  const courseId = Number(b.course_id), sectionId = Number(b.section_id), studentId = Number(b.student_id || 1);
  const trace = [];
  if (!Number.isInteger(sectionId)) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'section_id must be an integer' });
  const [pre] = await pool.query("SELECT enrollment_id FROM enrollments WHERE course_id = ? AND student_id = ? AND status = 'ENROLLED'", [courseId, studentId]);
  if (pre.length) return res.status(409).json({ ok: false, code: 'ALREADY_ENROLLED', message: 'isolation demo needs a student NOT enrolled in this course — pick a free section' });
  const connA = await pool.getConnection();
  const connB = await pool.getConnection();
  try {
    // WHY 5s: if anything jams, B fails on lock wait timeout instead of hanging forever.
    await connA.query('SET SESSION innodb_lock_wait_timeout = 5');
    await connB.query('SET SESSION innodb_lock_wait_timeout = 5');
    // A: begin, lock the section row, insert the enrollment — but do NOT commit yet.
    await connA.beginTransaction();
    trace.push({ ts: ts(), actor: 'A', step: 'BEGIN', status: 'OK' });
    const [s] = await connA.query('SELECT section_no FROM sections WHERE section_id = ? FOR UPDATE', [sectionId]);
    trace.push({ ts: ts(), actor: 'A', step: `SELECT section ${s[0].section_no} FOR UPDATE -> lock held`, status: 'OK' });
    await connA.query("INSERT INTO enrollments (course_id, section_id, student_id, status) VALUES (?, ?, ?, 'ENROLLED')", [courseId, sectionId, studentId]);
    trace.push({ ts: ts(), actor: 'A', step: 'INSERT enrollments (uncommitted)', status: 'OK' });
    // B: the identical enrollment attempt. It blocks at its own FOR UPDATE because
    // A already holds the row lock.
    const bPromise = enrollStudent(connB, { courseId, sectionId, studentId, hostelDays: 0, failAt: null }, trace, 'B');
    await sleep(1500);
    const [trx] = await pool.query('SELECT trx_state FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ?', [connB.connection.threadId]);
    trace.push({ ts: ts(), actor: 'B', step: trx.length ? `status while A holds the lock: trx_state = ${trx[0].trx_state}` : 'attempting enrollment', status: 'WAIT' });
    await connA.commit();
    trace.push({ ts: ts(), actor: 'A', step: 'COMMIT -> enrollment is now visible', status: 'OK' });
    let bFailed = null;
    try { await bPromise; } catch (e) { bFailed = dbError(e); }
    // B resumes after A commits, its trigger check now sees A's enrollment -> SIGNAL 45000.
    if (bFailed) {
      trace.push({ ts: ts(), actor: 'B', step: `failed: [${bFailed.code}] ${bFailed.message}`, status: 'ERROR' });
      try { await connB.rollback(); trace.push({ ts: ts(), actor: 'B', step: 'ROLLBACK', status: 'ERROR' }); } catch (_) { /* gone */ }
    }
    res.json({ ok: true, committed: true, trace, b_failed: bFailed });
  } catch (e) {
    try { await connA.rollback(); } catch (_) { /* A never began */ }
    const d = dbError(e);
    res.status(500).json({ ok: false, committed: false, code: d.code, sqlState: d.sqlState, message: d.message, trace });
  } finally {
    connA.release();
    connB.release();
  }
});

app.post('/api/query', wrap(async (req, res) => {
  const sql = String((req.body || {}).sql || '').trim();
  const body = sql.replace(/;+\s*$/, '');
  const first = (body.match(/^[a-zA-Z]+/) || [''])[0].toUpperCase();
  // Single statement only, and only the four safe-ish verbs; everything else
  // (DROP, ALTER, TRUNCATE, SET, ...) is refused before it reaches MySQL.
  if (!body) return res.status(400).json({ ok: false, code: 'EMPTY', message: 'type a SQL statement' });
  if (body.includes(';')) return res.status(400).json({ ok: false, code: 'MULTI', message: 'only a single statement is allowed' });
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(first)) {
    return res.status(400).json({ ok: false, code: 'FORBIDDEN', message: 'only SELECT, INSERT, UPDATE, DELETE are allowed (got ' + (first || 'nothing') + ')' });
  }
  try {
    const [rows, fields] = await pool.query(body);
    if (Array.isArray(rows)) {
      res.json({ ok: true, columns: fields.map((f) => f.name), rows: rows.slice(0, 200) });
    } else {
      res.json({ ok: true, columns: [], rows: [], affectedRows: rows.affectedRows, insertId: rows.insertId });
    }
  } catch (e) {
    const d = dbError(e);
    res.status(400).json({ ok: false, code: d.code, sqlState: d.sqlState, message: d.message });
  }
}));

app.get('/api/logs/audit', wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const [rows] = await pool.query(
    `SELECT log_id, table_name, action, row_id, old_data, new_data, logged_at
     FROM audit_log WHERE log_id > ? ORDER BY log_id DESC LIMIT 100`, [since]);
  res.json({ ok: true, rows });
}));

app.get('/api/logs/general', wrap(async (req, res) => {
  const [g] = await pool.query('SELECT @@general_log AS enabled');
  if (!g[0].enabled) return res.json({ ok: true, enabled: false, rows: [] });
  // Filter to this app's MySQL user and drop our own log-reading queries,
  // otherwise the log would fill with its own SELECT every 2 seconds.
  // CAST: the argument column is stored as CSV bytes, so cast it to text.
  const [rows] = await pool.query(
    `SELECT event_time, user_host, command_type,
            CAST(argument AS CHAR CHARACTER SET utf8mb4) AS argument
     FROM mysql.general_log
     WHERE user_host LIKE ? AND argument NOT LIKE '%general_log%'
     ORDER BY event_time DESC, thread_id DESC LIMIT 30`, [process.env.DB_USER + '%']);
  res.json({ ok: true, enabled: true, rows });
}));

app.post('/api/reset', wrap(async (req, res) => {
  // Dedicated connection because seed.sql is many statements at once; the app
  // pool stays multipleStatements=false so /api/query can never do this.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    multipleStatements: true, dateStrings: true,
  });
  try {
    const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    await conn.query(seed);
    await conn.query('TRUNCATE TABLE mysql.general_log');  // so the log demo starts clean too
    res.json({ ok: true, message: 'Demo data reset' });
  } finally {
    await conn.end();
  }
}));

// Wrap(fn) gives the simple GET handlers uniform {ok:false, code, message} errors.
function wrap(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    const d = dbError(e);
    res.status(500).json({ ok: false, code: d.code, sqlState: d.sqlState, message: d.message });
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`muj_sms demo listening on http://localhost:${PORT}`));
