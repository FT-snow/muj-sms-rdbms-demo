// db.js: owns the MySQL connection pool and shared helpers (whitelist, error
// shaping, timestamps). server.js imports this instead of opening its own pool.
require('dotenv').config();
const mysql = require('mysql2/promise');

// One pool for the whole app: 5 reusable connections so requests do not
// re-handshake with MySQL every time. dateStrings keeps DATETIME readable.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
  dateStrings: true,
});

// Whitelist: table name -> the exact SQL used to read it. Anything not listed
// here is refused, so /api/table can never be pointed at an arbitrary table.
const TABLE_SQL = {
  departments: 'SELECT department_id, code, name FROM departments ORDER BY department_id',
  courses: 'SELECT course_id, course_code, title, department_id, starts_at FROM courses ORDER BY course_id',
  sections: 'SELECT section_id, course_id, section_no, slot, capacity, fee FROM sections ORDER BY section_id',
  students: 'SELECT student_id, name, email, phone FROM students ORDER BY student_id',
  enrollments: 'SELECT enrollment_id, course_id, section_id, student_id, status, created_at FROM enrollments ORDER BY enrollment_id DESC LIMIT 500',
  fees: 'SELECT fee_id, enrollment_id, amount, status, paid_at FROM fees ORDER BY fee_id DESC LIMIT 500',
  hostel_stays: 'SELECT stay_id, enrollment_id, days, fee FROM hostel_stays ORDER BY stay_id DESC LIMIT 500',
  audit_log: 'SELECT log_id, table_name, action, row_id, old_data, new_data, logged_at FROM audit_log ORDER BY log_id DESC LIMIT 500',
  unnormalized_enrollments: 'SELECT * FROM unnormalized_enrollments ORDER BY unnorm_id',
  enrollments_1nf: 'SELECT * FROM enrollments_1nf ORDER BY enrollment_no, mark_no',
  enrollments_2nf: 'SELECT * FROM enrollments_2nf ORDER BY enrollment_no',
  courses_2nf: 'SELECT * FROM courses_2nf ORDER BY course_code',
  enrollments_3nf: 'SELECT * FROM enrollments_3nf ORDER BY enrollment_no',
  students_3nf: 'SELECT * FROM students_3nf ORDER BY student_name',
  courses_3nf: 'SELECT * FROM courses_3nf ORDER BY course_code',
};

// MySQL error -> {code, message, sqlState} so every endpoint answers uniformly.
function dbError(e) {
  return { code: e.errno || e.code || 'ERROR', message: e.message, sqlState: e.sqlState || null };
}

// Wall-clock timestamp with milliseconds for the UI trace/log lines.
function ts() {
  return new Date().toISOString().slice(11, 23);
}

// sleep(ms) used only by the isolation demo to hold connection A open.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { pool, TABLE_SQL, dbError, ts, sleep };
