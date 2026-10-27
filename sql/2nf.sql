-- 2NF step: every non-key fact must depend on the WHOLE key. enrollment_no is
-- a single-column key, so this table is technically already 2NF -- but course
-- facts (title, department) are repeated on every enrollment row, which is
-- what 2NF-style splitting is about: a fact lives once, with the entity it
-- belongs to.
-- Run with: mysql -u root -p muj_sms < sql/2nf.sql
USE muj_sms;

-- Course facts now exist once per course instead of once per enrollment.
CREATE OR REPLACE VIEW courses_2nf AS
SELECT DISTINCT course_code, course_title, department_name
FROM unnormalized_enrollments;

-- Enrollment rows keep only facts about the enrollment itself.
CREATE OR REPLACE VIEW enrollments_2nf AS
SELECT enrollment_no, student_name, student_email, course_code, section_no, fee, fee_status
FROM unnormalized_enrollments;

-- Compare:
--   SELECT * FROM courses_2nf ORDER BY course_code;
--   SELECT * FROM enrollments_2nf ORDER BY enrollment_no;
