-- schema.sql: creates the muj_sms database, all 3NF tables, constraints and triggers.
-- Run once before seed.sql (it drops and recreates the whole database):
--   mysql -u root -p < schema.sql
-- NOTE: triggers below use DELIMITER because their bodies contain ';' --
-- plain `mysql < schema.sql` handles that; run this file only via the mysql CLI.

DROP DATABASE IF EXISTS muj_sms;
CREATE DATABASE muj_sms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE muj_sms;

-- Departments: no foreign keys; referenced by courses. UNIQUE code keeps the
-- three-letter abbreviations (CSE, ECE, ME) unambiguous.
CREATE TABLE departments (
  department_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code          CHAR(3)      NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL
) ENGINE = InnoDB;  -- InnoDB: transactions, row locks and foreign keys

-- Courses belong to one department. ON DELETE RESTRICT means a department
-- that still has courses cannot be deleted, so no enrollment can lose its course.
CREATE TABLE courses (
  course_id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_code   VARCHAR(8)   NOT NULL UNIQUE,  -- business key, human-readable
  title         VARCHAR(150) NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  starts_at     DATETIME     NOT NULL,
  CONSTRAINT fk_course_department FOREIGN KEY (department_id) REFERENCES departments (department_id) ON DELETE RESTRICT
) ENGINE = InnoDB;

-- Sections are the teaching instances of a course. UNIQUE(course_id, section_no):
-- the same section number exists in many courses but only once per course.
-- Capacity is bounded so nonsense values are rejected by the database.
CREATE TABLE sections (
  section_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_id  INT UNSIGNED NOT NULL,
  section_no VARCHAR(4)   NOT NULL,              -- 'G1' .. 'G6'
  slot       ENUM('MORNING','EVENING') NOT NULL,
  capacity   INT NOT NULL,
  fee        DECIMAL(10,2) NOT NULL,             -- DECIMAL, not FLOAT: exact money
  CONSTRAINT uq_course_section UNIQUE (course_id, section_no),
  CONSTRAINT chk_capacity_range CHECK (capacity BETWEEN 5 AND 60),
  CONSTRAINT fk_section_course FOREIGN KEY (course_id) REFERENCES courses (course_id) ON DELETE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE students (
  student_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  email      VARCHAR(200) NOT NULL UNIQUE,  -- one email = one student record
  phone      VARCHAR(20)  NULL              -- NULL means "not given"
) ENGINE = InnoDB;

-- One row per enrolled seat in a course. The BEFORE INSERT trigger below
-- allows at most one ENROLLED row per (student, course) and rejects full
-- sections; DROPPED rows stay in the table as history.
CREATE TABLE enrollments (
  enrollment_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_id     INT UNSIGNED NOT NULL,
  section_id    INT UNSIGNED NOT NULL,
  student_id    INT UNSIGNED NOT NULL,
  status        ENUM('ENROLLED','DROPPED') NOT NULL DEFAULT 'ENROLLED',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- ms precision for log ordering
  CONSTRAINT fk_enrollment_course  FOREIGN KEY (course_id)  REFERENCES courses (course_id)   ON DELETE RESTRICT,
  CONSTRAINT fk_enrollment_section FOREIGN KEY (section_id) REFERENCES sections (section_id) ON DELETE RESTRICT,
  CONSTRAINT fk_enrollment_student FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE RESTRICT
) ENGINE = InnoDB;

-- Exactly one fee record per enrollment (UNIQUE enrollment_id); the DB itself
-- rejects negative amounts so app code cannot be the only line of defense.
CREATE TABLE fees (
  fee_id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  enrollment_id INT UNSIGNED NOT NULL UNIQUE,
  amount        DECIMAL(10,2) NOT NULL,
  status        ENUM('PAID','FAILED') NOT NULL DEFAULT 'PAID',
  paid_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_fee_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments (enrollment_id) ON DELETE RESTRICT,
  CONSTRAINT chk_amount_nonneg CHECK (amount >= 0)
) ENGINE = InnoDB;

-- Zero or more hostel stays per enrollment; days are bounded so nonsense
-- values are rejected by the database, not by app code.
CREATE TABLE hostel_stays (
  stay_id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  enrollment_id INT UNSIGNED NOT NULL,
  days         INT NOT NULL,
  fee          DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_stay_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments (enrollment_id) ON DELETE RESTRICT,
  CONSTRAINT chk_days_range     CHECK (days BETWEEN 1 AND 40)
) ENGINE = InnoDB;

-- Trigger-written audit trail. Node code never inserts here; only the triggers
-- below do, so every row-level change is logged even if a client forgets to.
CREATE TABLE audit_log (
  log_id     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL,
  action     ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  row_id     BIGINT UNSIGNED NOT NULL,          -- PK value of the changed row
  old_data   JSON NULL,                         -- before-image; NULL for INSERT
  new_data   JSON NULL,                         -- after-image; NULL for DELETE
  logged_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE = InnoDB;

-- Deliberately UNNORMALIZED teaching table: everything repeated per row, and
-- marks as a comma-separated list (a repeating group, which violates 1NF).
CREATE TABLE unnormalized_enrollments (
  unnorm_id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  enrollment_no  VARCHAR(10)   NOT NULL,        -- NOT NULL on purpose: it makes the
  student_name   VARCHAR(120)  NOT NULL,        --   insert anomaly demo fail loudly
  student_email  VARCHAR(200)  NOT NULL,
  course_code    VARCHAR(8)    NOT NULL,
  course_title   VARCHAR(150)  NOT NULL,
  department_name VARCHAR(100) NOT NULL,
  section_no     VARCHAR(4)    NOT NULL,
  fee            DECIMAL(10,2) NOT NULL,
  fee_status     VARCHAR(20)   NOT NULL,
  marks          VARCHAR(100)  NOT NULL DEFAULT ''  -- '85,90' or ''
) ENGINE = InnoDB;

-- Small helper table (1..8) used by the 1NF view to split marks lists into rows.
CREATE TABLE demo_numbers (
  n INT UNSIGNED PRIMARY KEY
) ENGINE = InnoDB;

-- ============ TRIGGERS ============

-- Guards on enrollment: fires on every INSERT into enrollments before the row
-- is written. If the section is full, or the student already has an ENROLLED
-- row in the same course, SIGNAL aborts the whole statement (and, inside a
-- transaction, whatever came before it).
DELIMITER ;;
CREATE TRIGGER trg_enrollments_no_double BEFORE INSERT ON enrollments
FOR EACH ROW
BEGIN
  DECLARE capacity_count INT;
  DECLARE enrolled_count INT;
  IF NEW.status = 'ENROLLED' THEN
    SELECT capacity INTO capacity_count FROM sections WHERE section_id = NEW.section_id;
    SELECT COUNT(*) INTO enrolled_count FROM enrollments
      WHERE section_id = NEW.section_id AND status = 'ENROLLED';
    IF enrolled_count >= capacity_count THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Section is FULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.course_id = NEW.course_id AND e.student_id = NEW.student_id
        AND e.status = 'ENROLLED'
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Student already ENROLLED in this course';
    END IF;
  END IF;
END;;
DELIMITER ;

-- Same guard for UPDATE, so a dropped enrollment cannot be re-activated onto
-- a full section or onto a course the student already took in the meantime.
DELIMITER ;;
CREATE TRIGGER trg_enrollments_no_reenroll BEFORE UPDATE ON enrollments
FOR EACH ROW
BEGIN
  DECLARE capacity_count INT;
  DECLARE enrolled_count INT;
  IF NEW.status = 'ENROLLED' AND OLD.status <> 'ENROLLED' THEN
    SELECT capacity INTO capacity_count FROM sections WHERE section_id = NEW.section_id;
    SELECT COUNT(*) INTO enrolled_count FROM enrollments
      WHERE section_id = NEW.section_id AND status = 'ENROLLED'
        AND enrollment_id <> NEW.enrollment_id;
    IF enrolled_count >= capacity_count THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Section is FULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM enrollments e
      WHERE e.course_id = NEW.course_id AND e.student_id = NEW.student_id
        AND e.status = 'ENROLLED' AND e.enrollment_id <> NEW.enrollment_id
    ) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Student already ENROLLED in this course';
    END IF;
  END IF;
END;;
DELIMITER ;

-- Audit AFTER INSERT on enrollments: one row per inserted enrollment.
DELIMITER ;;
CREATE TRIGGER trg_enrollments_after_insert AFTER INSERT ON enrollments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('enrollments', 'INSERT', NEW.enrollment_id, NULL,
          JSON_OBJECT('course_id', NEW.course_id, 'section_id', NEW.section_id,
                      'student_id', NEW.student_id, 'status', NEW.status));;
DELIMITER ;

-- Audit AFTER UPDATE on enrollments: captures both before- and after-image, so
-- an ENROLLED -> DROPPED change leaves visible evidence.
DELIMITER ;;
CREATE TRIGGER trg_enrollments_after_update AFTER UPDATE ON enrollments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('enrollments', 'UPDATE', NEW.enrollment_id,
          JSON_OBJECT('status', OLD.status),
          JSON_OBJECT('status', NEW.status));;
DELIMITER ;

-- Audit AFTER DELETE on enrollments: keeps the before-image only.
DELIMITER ;;
CREATE TRIGGER trg_enrollments_after_delete AFTER DELETE ON enrollments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('enrollments', 'DELETE', OLD.enrollment_id,
          JSON_OBJECT('course_id', OLD.course_id, 'section_id', OLD.section_id,
                      'student_id', OLD.student_id, 'status', OLD.status),
          NULL);;
DELIMITER ;

-- Audit AFTER INSERT on fees: the money side of an enrollment is logged too.
DELIMITER ;;
CREATE TRIGGER trg_fees_after_insert AFTER INSERT ON fees
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('fees', 'INSERT', NEW.fee_id, NULL,
          JSON_OBJECT('enrollment_id', NEW.enrollment_id, 'amount', NEW.amount,
                      'status', NEW.status));;
DELIMITER ;

-- Audit AFTER UPDATE on fees: a voided fee (PAID -> FAILED) is logged.
DELIMITER ;;
CREATE TRIGGER trg_fees_after_update AFTER UPDATE ON fees
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('fees', 'UPDATE', NEW.fee_id,
          JSON_OBJECT('status', OLD.status),
          JSON_OBJECT('status', NEW.status));;
DELIMITER ;

-- Audit AFTER INSERT on hostel_stays (added so an enrollment with a hostel
-- stay writes exactly three audit rows: enrollment, fee, hostel stay).
DELIMITER ;;
CREATE TRIGGER trg_hostel_after_insert AFTER INSERT ON hostel_stays
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('hostel_stays', 'INSERT', NEW.stay_id, NULL,
          JSON_OBJECT('enrollment_id', NEW.enrollment_id, 'days', NEW.days,
                      'fee', NEW.fee));;
DELIMITER ;

-- Audit AFTER DELETE on hostel_stays.
DELIMITER ;;
CREATE TRIGGER trg_hostel_after_delete AFTER DELETE ON hostel_stays
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('hostel_stays', 'DELETE', OLD.stay_id,
          JSON_OBJECT('enrollment_id', OLD.enrollment_id, 'days', OLD.days,
                      'fee', OLD.fee),
          NULL);;
DELIMITER ;

-- Audit section changes: seed inserts them, and fee updates are worth logging.
DELIMITER ;;
CREATE TRIGGER trg_sections_after_insert AFTER INSERT ON sections
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('sections', 'INSERT', NEW.section_id, NULL,
          JSON_OBJECT('course_id', NEW.course_id, 'section_no', NEW.section_no,
                      'slot', NEW.slot, 'fee', NEW.fee));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_sections_after_update AFTER UPDATE ON sections
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('sections', 'UPDATE', NEW.section_id,
          JSON_OBJECT('fee', OLD.fee),
          JSON_OBJECT('fee', NEW.fee));;
DELIMITER ;
