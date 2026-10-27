-- 1NF fix: every cell holds exactly one atomic value. The comma-separated
-- marks list ("85,90") becomes one row per exam score. Run with:
--   mysql -u root -p muj_sms < sql/1nf.sql
USE muj_sms;

-- One row per (enrollment, score). demo_numbers supplies 1..8; the join
-- repeats each enrollment row once per score it lists, and SUBSTRING_INDEX
-- picks the n-th piece. Rows with an empty marks list produce a single row
-- with an empty mark value.
CREATE OR REPLACE VIEW enrollments_1nf AS
SELECT
  u.enrollment_no,
  u.student_name,
  u.student_email,
  u.course_code,
  u.course_title,
  u.department_name,
  u.section_no,
  u.fee,
  u.fee_status,
  n.n AS mark_no,
  TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(u.marks, ',', n.n), ',', -1)) AS mark
FROM unnormalized_enrollments u
JOIN demo_numbers n
  ON n.n <= IF(u.marks = '', 1, 1 + LENGTH(u.marks) - LENGTH(REPLACE(u.marks, ',', '')));

-- Compare: SELECT * FROM enrollments_1nf ORDER BY enrollment_no, mark_no;
