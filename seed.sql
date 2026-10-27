-- seed.sql: fills muj_sms with demo data. Idempotent: safe to re-run on any
-- state (it empties every table first, then inserts a fixed demo dataset).
--   mysql -u root -p < seed.sql
-- The last statement clears the audit noise from seeding so the demo log
-- starts empty.

USE muj_sms;

-- We empty parent and child tables together, so FK checks are switched off for
-- this session only and switched straight back on. TRUNCATE also resets the
-- AUTO_INCREMENT counters, which keeps demo ids small after a reset.
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE audit_log;
TRUNCATE TABLE hostel_stays;
TRUNCATE TABLE fees;
TRUNCATE TABLE enrollments;
TRUNCATE TABLE students;
TRUNCATE TABLE sections;
TRUNCATE TABLE courses;
TRUNCATE TABLE departments;
TRUNCATE TABLE unnormalized_enrollments;
TRUNCATE TABLE demo_numbers;
SET FOREIGN_KEY_CHECKS = 1;

-- 3 departments
INSERT INTO departments (code, name) VALUES ('CSE', 'Computer Science and Engineering');
INSERT INTO departments (code, name) VALUES ('ECE', 'Electronics and Communication Engineering');
INSERT INTO departments (code, name) VALUES ('ME',  'Mechanical Engineering');

-- 2 courses (fresh AUTO_INCREMENT guarantees course_id 1 and 2)
INSERT INTO courses (course_code, title, department_id, starts_at) VALUES ('CSE201', 'Data Structures and Algorithms', 1, '2026-11-02 08:00:00');
INSERT INTO courses (course_code, title, department_id, starts_at) VALUES ('ECE101', 'Digital Electronics', 2, '2026-11-02 10:00:00');

-- 6 sections per course: G1-G2 MORNING, G3-G6 EVENING, capacity 30 each.
-- Section ids follow insertion order: course 1 -> ids 1-6, course 2 -> 7-12.
INSERT INTO sections (course_id, section_no, slot, capacity, fee) VALUES
  (1,'G1','MORNING',30,45000.00),
  (1,'G2','MORNING',30,45000.00),
  (1,'G3','EVENING',30,42000.00),
  (1,'G4','EVENING',30,42000.00),
  (1,'G5','EVENING',30,42000.00),
  (1,'G6','EVENING',30,42000.00),
  (2,'G1','MORNING',30,38000.00),
  (2,'G2','MORNING',30,38000.00),
  (2,'G3','EVENING',30,35000.00),
  (2,'G4','EVENING',30,35000.00),
  (2,'G5','EVENING',30,35000.00),
  (2,'G6','EVENING',30,35000.00);

-- 6 students
INSERT INTO students (name, email, phone) VALUES
  ('Karan Chandel', 'karan.chandel@mail.com', '9810012345'),
  ('Aarav Sharma',  'aarav@mail.com',         '9810023456'),
  ('Diya Menon',    'diya@mail.com',          '9810034567'),
  ('Rohan Gupta',   'rohan@mail.com',         '9810045678'),
  ('Ananya Rao',    'ananya@mail.com',        '9810056789'),
  ('Vikram Singh',  'vikram@mail.com',        '9810067890');

-- 4 existing enrollments. Section and course ids come from subqueries, not
-- magic numbers, so the seed survives if sections are ever inserted in a
-- different order.
-- Enrollment 1: Karan, CSE201 section G1, fee paid, 15-day hostel stay (fee = 15 x 150).
INSERT INTO enrollments (course_id, section_id, student_id, status)
VALUES ((SELECT course_id FROM sections WHERE section_id = 1), 1,
        (SELECT student_id FROM students WHERE email = 'karan.chandel@mail.com'), 'ENROLLED');
INSERT INTO fees (enrollment_id, amount, status)
VALUES (1, (SELECT fee FROM sections WHERE section_id = 1), 'PAID');
INSERT INTO hostel_stays (enrollment_id, days, fee) VALUES (1, 15, 2250.00);

-- Enrollment 2: Aarav, CSE201 section G2, fee paid, no hostel stay.
INSERT INTO enrollments (course_id, section_id, student_id, status)
VALUES ((SELECT course_id FROM sections WHERE section_id = 2), 2,
        (SELECT student_id FROM students WHERE email = 'aarav@mail.com'), 'ENROLLED');
INSERT INTO fees (enrollment_id, amount, status)
VALUES (2, (SELECT fee FROM sections WHERE section_id = 2), 'PAID');

-- Enrollment 3: Diya, CSE201 section G3, fee paid, 20-day hostel stay.
INSERT INTO enrollments (course_id, section_id, student_id, status)
VALUES ((SELECT course_id FROM sections WHERE section_id = 3), 3,
        (SELECT student_id FROM students WHERE email = 'diya@mail.com'), 'ENROLLED');
INSERT INTO fees (enrollment_id, amount, status)
VALUES (3, (SELECT fee FROM sections WHERE section_id = 3), 'PAID');
INSERT INTO hostel_stays (enrollment_id, days, fee) VALUES (3, 20, 3000.00);

-- Enrollment 4: Rohan, ECE101 section G1, fee paid, 12-day hostel stay.
INSERT INTO enrollments (course_id, section_id, student_id, status)
VALUES ((SELECT course_id FROM sections WHERE section_id = 7), 7,
        (SELECT student_id FROM students WHERE email = 'rohan@mail.com'), 'ENROLLED');
INSERT INTO fees (enrollment_id, amount, status)
VALUES (4, (SELECT fee FROM sections WHERE section_id = 7), 'PAID');
INSERT INTO hostel_stays (enrollment_id, days, fee) VALUES (4, 12, 1800.00);

-- 10 rows in the unnormalized table, chosen so each anomaly is one query:
--  - rows 1-3 repeat Karan three times -> update anomaly
--  - enrollment_no / student_name are NOT NULL -> insert anomaly
--  - rows 6-10 are the only place ECE101's course info exists -> delete anomaly
INSERT INTO unnormalized_enrollments
  (enrollment_no, student_name, student_email, course_code, course_title, department_name, section_no, fee, fee_status, marks) VALUES
  ('EN-1001', 'Karan Chandel', 'karan.chandel@mail.com', 'CSE201', 'Data Structures and Algorithms', 'Computer Science and Engineering', 'G1', 45000.00, 'PAID',     '85,90'),
  ('EN-1002', 'Karan Chandel', 'karan.chandel@mail.com', 'CSE201', 'Data Structures and Algorithms', 'Computer Science and Engineering', 'G2', 45000.00, 'PAID',     ''),
  ('EN-1003', 'Karan Chandel', 'karan.chandel@mail.com', 'CSE201', 'Data Structures and Algorithms', 'Computer Science and Engineering', 'G3', 42000.00, 'REFUNDED', '78,88'),
  ('EN-1004', 'Aarav Sharma',  'aarav@mail.com',         'CSE201', 'Data Structures and Algorithms', 'Computer Science and Engineering', 'G1', 45000.00, 'PAID',     '82,91'),
  ('EN-1005', 'Diya Menon',    'diya@mail.com',          'CSE201', 'Data Structures and Algorithms', 'Computer Science and Engineering', 'G4', 42000.00, 'FAILED',   ''),
  ('EN-1006', 'Rohan Gupta',   'rohan@mail.com',         'ECE101', 'Digital Electronics', 'Electronics and Communication Engineering', 'G1', 38000.00, 'PAID', '75,80'),
  ('EN-1007', 'Ananya Rao',    'ananya@mail.com',        'ECE101', 'Digital Electronics', 'Electronics and Communication Engineering', 'G2', 38000.00, 'PAID',     ''),
  ('EN-1008', 'Vikram Singh',  'vikram@mail.com',        'ECE101', 'Digital Electronics', 'Electronics and Communication Engineering', 'G3', 35000.00, 'PAID',     '68,74'),
  ('EN-1009', 'Priya Bose',    'priya@mail.com',         'ECE101', 'Digital Electronics', 'Electronics and Communication Engineering', 'G4', 35000.00, 'REFUNDED', ''),
  ('EN-1010', 'Aarav Sharma',  'aarav@mail.com',         'ECE101', 'Digital Electronics', 'Electronics and Communication Engineering', 'G5', 35000.00, 'PAID',     '');

-- Numbers 1..8 for the 1NF view (splits marks lists into one row per score).
INSERT INTO demo_numbers (n) VALUES (1),(2),(3),(4),(5),(6),(7),(8);

-- Seeding fired all the INSERT triggers; clear the noise so the audience sees
-- only the demo's own audit rows.
TRUNCATE TABLE audit_log;
