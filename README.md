# MUJ SMS — RDBMS teaching demo (student management system)

A small local web app demonstrating normalization (1NF-3NF), transactions,
ACID, constraints, triggers, locking/isolation and database logs on MySQL 8,
modeled on course registration at Manipal University Jaipur. The audience
watches the database change live -- via a student portal and a DBMS console.

## Prerequisites

Node.js 18+, npm, MySQL 8 (local), a user that can create databases.

## Setup

    npm install
    mysql -u root -p < schema.sql      # drops and recreates the muj_sms DB
    mysql -u root -p < seed.sql        # idempotent demo data
    cp .env.example .env               # set DB_USER / DB_PASSWORD
    npm start                          # http://localhost:3002

Optional normalization walk-through (adds view tabs in the UI):
`mysql -u root -p muj_sms < sql/1nf.sql` and the same for `sql/2nf.sql`,
`sql/3nf.sql`. Reset any time with the "Reset demo data" button.

## Demo script (8 steps; details in PROJECT_EXPLAINED.txt)

1. Tab `unnormalized_enrollments` + the three anomaly buttons -> run each query.
2. Tabs `enrollments`, `sections`, `fees`, `courses`: the 3NF layout.
3. Enroll a student in CSE201 section G4: new row + 3 audit-log trigger rows.
4. Enroll with forced failure (after fee): trace shows ROLLBACK, no partial rows.
5. Concept buttons FK / UNIQUE / CHECK / Trigger: raw MySQL error codes (1452/1062/3819/1644).
6. Isolation demo on a free section: A locks + commits, B waits (LOCK WAIT), B fails (1644).
7. Restart Node (Ctrl-C, `npm start`): data is still there (durability).
8. SQL box: SELECT * FROM mysql.general_log ... (server-level log).

## Enabling the general query log (needed for step 8)

    SET GLOBAL log_output = 'TABLE';
    SET GLOBAL general_log = 'ON';   # off after the demo: SET GLOBAL general_log = 'OFF'

All concepts, queries and triggers are explained in PROJECT_EXPLAINED.txt.
