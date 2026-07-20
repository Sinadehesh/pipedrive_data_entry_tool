-- First-Year Engineering Learning Database — Postgres schema
-- Companion to ../STRUCTURE.md. Portable to Drizzle table-by-table.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type depth_level as enum ('awareness', 'procedural', 'fluency', 'proof');

create type enrollment_phase as enum ('starting', 'attending');

create type subject_status as enum ('not_started', 'in_progress', 'finished');

create type progress_state as enum ('not_started', 'in_progress', 'done');

-- Survey answer to "Have you studied: {subtopic}?"
create type coverage_answer as enum ('yes_depth', 'yes_brief', 'no', 'unsure');

create type coverage_verdict as enum
  ('taught', 'partially_taught', 'not_taught', 'insufficient_data');

create type verification_status as enum ('unverified', 'verified', 'rejected');

-- ---------------------------------------------------------------------------
-- Reference data: universities and programs
-- ---------------------------------------------------------------------------

create table universities (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  country_code  char(2) not null,
  city          text,
  status        verification_status not null default 'unverified',
  added_by      uuid,                          -- student who added it, if any
  created_at    timestamptz not null default now(),
  unique (name, country_code)
);

-- Engineering disciplines: mechanical, electrical, civil, computer, ...
create table programs (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,            -- 'mechanical-engineering'
  name        text not null,
  status      verification_status not null default 'verified',
  created_at  timestamptz not null default now()
);

-- A university offering a program ("the course" a student names at signup).
create table university_programs (
  id             uuid primary key default gen_random_uuid(),
  university_id  uuid not null references universities(id),
  program_id     uuid not null references programs(id),
  local_name     text,                         -- uni's own name for the course
  status         verification_status not null default 'unverified',
  created_at     timestamptz not null default now(),
  unique (university_id, program_id)
);

-- ---------------------------------------------------------------------------
-- Canonical curriculum: subject -> topic -> subtopic
-- ---------------------------------------------------------------------------

create table subjects (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,       -- 'calculus-1'
  name             text not null,              -- 'Calculus I'
  description      text,
  year             smallint not null default 1,
  position         smallint not null,          -- display order among subjects
  min_sample_size  smallint not null default 5,-- gate for showing aggregates
  created_at       timestamptz not null default now()
);

create table topics (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references subjects(id),
  slug        text not null,                   -- 'limits-and-continuity'
  name        text not null,
  description text,
  position    smallint not null,
  retired_at  timestamptz,                     -- soft delete; never hard-delete
  unique (subject_id, slug)
);

create table subtopics (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references topics(id),
  slug        text not null,                   -- stable id for survey answers
  name        text not null,                   -- phrased so "Have you studied:
                                               --  {name}?" reads naturally
  description text,
  depth_level depth_level not null,
  est_hours   numeric(4,1),                    -- estimated study hours
  position    smallint not null,
  retired_at  timestamptz,
  unique (topic_id, slug)
);

-- Prerequisite DAG between subtopics (may cross topics/subjects).
create table subtopic_prerequisites (
  subtopic_id      uuid not null references subtopics(id),
  prerequisite_id  uuid not null references subtopics(id),
  primary key (subtopic_id, prerequisite_id),
  check (subtopic_id <> prerequisite_id)
);

-- "My course also covered X" free-text from surveys, for editorial review.
create table curriculum_suggestions (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references subjects(id),
  topic_id    uuid references topics(id),
  student_id  uuid not null,
  body        text not null,
  status      verification_status not null default 'unverified',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Students and enrollment
-- ---------------------------------------------------------------------------

create table students (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text not null,
  password_hash text,                          -- null when OAuth-only
  created_at    timestamptz not null default now()
);

-- Student x university x program x intake year. Unlocks first-year database.
create table enrollments (
  id                     uuid primary key default gen_random_uuid(),
  student_id             uuid not null references students(id),
  university_program_id  uuid not null references university_programs(id),
  intake_year            smallint not null,    -- cohort; curricula change
  phase                  enrollment_phase not null,
  created_at             timestamptz not null default now(),
  unique (student_id, university_program_id, intake_year)
);

-- Per-subject state. Grade is captured when status becomes 'finished'.
create table subject_enrollments (
  id               uuid primary key default gen_random_uuid(),
  enrollment_id    uuid not null references enrollments(id),
  subject_id       uuid not null references subjects(id),
  status           subject_status not null default 'not_started',
  finished_at      timestamptz,
  grade_value      text,                       -- raw, as the student states it
  grade_scale      text,                       -- '0-20', 'gpa-4', 'percent',
                                               -- 'ects-letter', 'de-1-5', ...
  grade_normalized numeric(5,2),               -- 0-100, via conversion table
  created_at       timestamptz not null default now(),
  unique (enrollment_id, subject_id),
  check (status <> 'finished' or finished_at is not null)
);

-- ---------------------------------------------------------------------------
-- Progress tracking (actively attending students)
-- ---------------------------------------------------------------------------

create table subtopic_progress (
  subject_enrollment_id uuid not null references subject_enrollments(id),
  subtopic_id           uuid not null references subtopics(id),
  state                 progress_state not null default 'not_started',
  updated_at            timestamptz not null default now(),
  primary key (subject_enrollment_id, subtopic_id)
);

-- ---------------------------------------------------------------------------
-- Coverage survey (finished students only — enforced in app layer + trigger)
-- ---------------------------------------------------------------------------

create table coverage_responses (
  subject_enrollment_id uuid not null references subject_enrollments(id),
  subtopic_id           uuid not null references subtopics(id),
  answer                coverage_answer not null,
  answered_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (subject_enrollment_id, subtopic_id)
);

-- Guard: responses only for finished subject enrollments.
create function assert_subject_finished() returns trigger as $$
begin
  if not exists (
    select 1 from subject_enrollments se
    where se.id = new.subject_enrollment_id and se.status = 'finished'
  ) then
    raise exception 'coverage responses require a finished subject enrollment';
  end if;
  return new;
end $$ language plpgsql;

create trigger coverage_requires_finished
  before insert or update on coverage_responses
  for each row execute function assert_subject_finished();

-- ---------------------------------------------------------------------------
-- Aggregates (rebuilt by the nightly job; powers the gap analysis)
-- ---------------------------------------------------------------------------

create table coverage_aggregates (
  university_program_id uuid not null references university_programs(id),
  subject_id            uuid not null references subjects(id),
  subtopic_id           uuid not null references subtopics(id),
  n                     integer not null,      -- finished respondents
  pct_covered           numeric(5,2) not null, -- weighted: depth=1, brief=0.5
  pct_in_depth          numeric(5,2) not null, -- yes_depth only
  avg_grade_normalized  numeric(5,2),          -- of respondents (n>=5 only)
  verdict               coverage_verdict not null,
  computed_at           timestamptz not null default now(),
  primary key (university_program_id, subject_id, subtopic_id)
);

create index idx_aggregates_gaps
  on coverage_aggregates (university_program_id, subject_id)
  where verdict = 'not_taught';

-- ---------------------------------------------------------------------------
-- Grade scale conversion (raw -> 0-100)
-- ---------------------------------------------------------------------------

create table grade_scales (
  scale       text not null,                   -- 'gpa-4', '0-20', 'de-1-5'...
  raw_value   text not null,                   -- '3.7', '17', '1.3', 'B'
  normalized  numeric(5,2) not null,           -- 0-100
  primary key (scale, raw_value)
);

-- ---------------------------------------------------------------------------
-- Useful indexes
-- ---------------------------------------------------------------------------

create index idx_topics_subject       on topics (subject_id, position);
create index idx_subtopics_topic      on subtopics (topic_id, position);
create index idx_enrollments_student  on enrollments (student_id);
create index idx_subj_enroll_status   on subject_enrollments (subject_id, status);
create index idx_responses_subtopic   on coverage_responses (subtopic_id);
