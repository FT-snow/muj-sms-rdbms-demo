-- 3NF step: no transitive dependencies -- a non-key column must not depend on
-- another non-key column. student_email depends on the student (not on the
-- enrollment), and course title/department depend on the course, so each gets
-- its own relation. This is the shape the real muj_sms tables already have.
-- Run with: mysql -u root -p muj_sms < sql/3nf.sql
USE muj_sms;

-- One row per student: email lives with the person, not with every enrollment.
CREATE OR REPLACE VIEW students_3nf AS
SELECT DISTINCT student_name, student_email
FROM unnormalized_enrollments;

-- One row per course: title and department live with the course.
CREATE OR REPLACE VIEW courses_3nf AS
SELECT DISTINCT course_code, course_title, department_name
FROM unnormalized_enrollments;

-- Enrollments reduced to the enrollment's own facts plus references; the real
-- enrollments / sections / students / courses tables are this, fully
-- materialized with keys and constraints.
CREATE OR REPLACE VIEW enrollments_3nf AS
SELECT enrollment_no, course_code, section_no, fee_status, student_name
FROM unnormalized_enrollments;

-- Compare:
--   SELECT * FROM students_3nf ORDER BY student_name;
--   SELECT * FROM courses_3nf ORDER BY course_code;
--   SELECT * FROM enrollments_3nf ORDER BY enrollment_no;
