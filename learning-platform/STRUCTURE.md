# First-Year Engineering Learning Database — Full Structure

A platform where first-year engineering students see exactly what they need to
learn, track what they have covered, and — through aggregated data from
students who finished each subject — discover what their own university does
**not** teach them.

Stack: Next.js (App Router) + Drizzle ORM + Postgres, matching this repo.

---

## 1. Core concept

There are two sources of truth that the platform reconciles:

1. **The canonical curriculum** — the comprehensive, university-independent
   list of everything a first-year engineering student should know to move on
   to second year, organized as *Subject → Topic → Subtopic*, each subtopic
   with a target **depth level**. This is editorial content we maintain,
   starting with Calculus I.

2. **Observed coverage** — what universities *actually* teach, reconstructed
   from surveys of students who have **finished** a subject ("Have you
   studied: using derivatives to solve real-world optimization?"), together
   with their grade.

The difference between (1) and (2), aggregated per university + course, is the
**gap analysis**: "here is what your university will not teach you."

---

## 2. User journeys

### 2.1 Onboarding (all users)

1. Sign up / log in (email + password or OAuth).
2. State **university** — pick from the database, or add it if missing
   (new entries go in as `unverified` until confirmed by a second student or
   a moderator).
3. State **course/program** (Mechanical, Electrical, Civil, Computer, General
   Engineering, …) — same pick-or-add flow.
4. This creates the student's **enrollment** (student × university × program ×
   intake year). The enrollment is what unlocks access to the full first-year
   database.
5. Answer: **"Are you starting first year, or actively attending it?"**
   (A third status, *finished*, is reached later per subject.)

### 2.2 The "starting" student — the branch outlook

A starting student gets a read-only **tree/branch view** of every first-year
subject:

```
Calculus I
├── 1. Limits and Continuity                      [depth: rigorous]
│   ├── Intuitive idea of a limit                 [depth: fluency]
│   ├── One-sided limits                          [depth: fluency]
│   ├── Epsilon–delta definition                  [depth: proof-level]
│   └── ...
├── 2. Derivatives: Definition and Basic Rules
│   └── ...
```

Each node shows:
- the **depth level** they'll be expected to reach (see §4.2),
- estimated study hours,
- prerequisite links between subtopics (e.g. *chain rule* ← *composite
  functions*),
- and — once enough data exists for their university + course — a **coverage
  badge**: *"87% of finished students at your university studied this"* or
  *"Your university likely will not teach this — plan to self-study."*

### 2.3 The "actively attending" student — progress tracking

- Same tree, but interactive: mark each subtopic *not started / in progress /
  done*.
- Per subject, the student's status is `in_progress` until they explicitly
  mark the subject **finished** (e.g. passed the exam). Marking finished is a
  deliberate, dated action — it is the gate to the coverage survey.

### 2.4 The "finished" student — the coverage survey (the data engine)

**Only students who marked a subject finished** are surveyed. The survey is
the core data-collection mechanism:

1. **Grade first** (one question): final grade + the grading scale it's on
   (we normalize, see §5.3).
2. **Coverage questions**, one topic at a time (never the whole subject in one
   screen — ~12 topics × ~10 subtopics, chunked so each session is ≤ 2–3
   minutes): for every subtopic, *"Have you studied: {subtopic}?"* with
   answers:
   - **Yes, in depth** — taught and examined
   - **Yes, briefly** — mentioned/skimmed, not practiced
   - **No** — never covered
   - **Don't remember**
3. Optional per-topic free-text: "anything your course covered here that
   isn't in this list?" → feeds curriculum improvement queue.

Surveys are resumable; partial responses are stored per subtopic, so a
student who answers 3 of 12 topics still contributes data.

### 2.5 The output — deep gap/coverage analysis

For each university + program + subject (once sample size ≥ threshold,
default n = 5 finished students):

- **Coverage rate** per subtopic: % answering *yes-in-depth* or *yes-briefly*.
- **Depth deficit**: subtopics where the canonical depth is *fluency+* but the
  dominant answer is *yes-briefly*.
- **Gap list**: subtopics with coverage below 40% → "your university will not
  teach you this."
- **Grade context**: average normalized grade of respondents, and (later)
  correlation between coverage of a subtopic cluster and grades.

Starting/active students at that university see this overlaid on their tree.

---

## 3. Entity model (overview)

```
universities ──< university_programs >── programs
                       │
students ──< enrollments (uni+program+year, phase: starting|attending)
                       │
subjects ──< topics ──< subtopics          (canonical curriculum, versioned)
    │                      │
    └──< subject_enrollments               (per student per subject:
              │                             in_progress | finished, grade)
              ├──< subtopic_progress       (active students: done/in progress)
              └──< coverage_responses      (finished students: the survey)
                            │
                  coverage_aggregates      (materialized per uni+program+
                                            subject+subtopic → the gap analysis)
```

Full DDL in [`db/schema.sql`](db/schema.sql). Highlights of the important
tables:

| Table | Purpose | Key fields |
|---|---|---|
| `subjects` | First-year subjects (Calculus I first) | `slug`, `name`, `min_sample_size` |
| `topics` | Ordered chapters within a subject | `subject_id`, `position`, `name` |
| `subtopics` | The atomic learning unit — what surveys ask about | `topic_id`, `position`, `name`, `depth_level`, `est_hours`, `description` |
| `subtopic_prerequisites` | DAG edges between subtopics | `subtopic_id`, `prerequisite_id` |
| `enrollments` | Student × uni × program × intake year | `phase` (`starting`/`attending`), `intake_year` |
| `subject_enrollments` | Student's state per subject | `status`, `finished_at`, `grade_value`, `grade_scale`, `grade_normalized` |
| `subtopic_progress` | Active-student tracker | `state` (`not_started`/`in_progress`/`done`) |
| `coverage_responses` | One survey answer per finished student per subtopic | `answer` (`yes_depth`/`yes_brief`/`no`/`unsure`) |
| `coverage_aggregates` | Cached rollup powering gap analysis | `n`, `pct_covered`, `pct_in_depth`, `verdict` |

---

## 4. The canonical curriculum

### 4.1 Structure and versioning

- Curriculum lives in the DB but is **seeded from versioned JSON files** in
  [`curriculum/`](curriculum/) — one file per subject
  (`calculus-1.json` first; linear algebra, physics I, chemistry,
  programming, etc. follow the same format).
- Subtopics carry a stable `slug` so survey answers survive reordering and
  renaming. Removing a subtopic soft-deletes it (`retired_at`) — historical
  responses are never orphaned.
- `curriculum_suggestions` table collects the free-text "my course also
  covered X" survey answers for editorial review.

### 4.2 Depth levels

Every subtopic declares how deep a student must go — shown in the outlook and
compared against survey answers:

| Level | Key | Meaning | Example (chain rule) |
|---|---|---|---|
| 1 | `awareness` | Know it exists, recognize it | "Composite functions have a differentiation rule" |
| 2 | `procedural` | Apply it mechanically to standard problems | Differentiate `sin(x²)` |
| 3 | `fluency` | Combine with other tools, multi-step problems | Related-rates problem requiring chain + implicit |
| 4 | `proof` | State precisely, prove, or derive | Prove the chain rule from the limit definition |

### 4.3 Calculus I

The complete taxonomy — 12 topics, 105 subtopics, each with depth level,
estimated hours, and prerequisites — is in
[`curriculum/calculus-1.json`](curriculum/calculus-1.json). Topic outline:

1. Precalculus foundations (review gate)
2. Limits and continuity
3. The derivative: definition and basic rules
4. Derivatives of transcendental functions
5. Advanced differentiation techniques
6. Applications of derivatives I: analysis of functions
7. Applications of derivatives II: modelling and problem solving
8. Integration: antiderivatives and the definite integral
9. Techniques of integration
10. Applications of integration
11. Sequences and series
12. Introduction to differential equations

---

## 5. Data-quality rules

### 5.1 Sample size and privacy
- No aggregate is shown for a university + program + subject until
  **n ≥ 5 finished students** have responded (configurable per subject).
- Aggregates only ever expose counts/percentages — never individual answers
  or grades. Individual grades are visible to no one but the student.

### 5.2 Answer weighting
- `yes_depth` = 1.0 coverage credit, `yes_brief` = 0.5, `no` = 0,
  `unsure` = excluded from the denominator.
- **Verdict thresholds** (per subtopic, per uni+program):
  - `taught` — weighted coverage ≥ 70%
  - `partially_taught` — 40–70%
  - `not_taught` — < 40% → appears in the gap list
  - `insufficient_data` — n below threshold

### 5.3 Grade normalization
Grades arrive on many scales (0–20 FR/IR, 1.0–4.0 GPA, percentages, ECTS
letters, German 1–5 inverted…). `subject_enrollments` stores the raw value +
scale, and a `grade_normalized` (0–100) computed via a per-scale conversion
table, so cross-university analysis is possible.

### 5.4 Integrity
- One coverage response per (subject_enrollment, subtopic) — upsert on
  re-answer, `updated_at` tracked.
- A student can only be surveyed for subjects with `status = finished`.
- Unverified universities/programs (student-added) don't pollute aggregates
  until verified; their students still get the canonical tree.

---

## 6. Aggregation pipeline

1. **Trigger**: nightly job (or on N new responses) per
   (university, program, subject).
2. Recompute `coverage_aggregates`: for each subtopic → `n`, `pct_covered`
   (weighted), `pct_in_depth`, `verdict`.
3. Gap analysis for the UI is a straight indexed read:
   `verdict = 'not_taught' ORDER BY topic.position, subtopic.position`.
4. Later phases: cohort filters (intake year — curricula change), grade
   correlation, cross-university subject comparison ("universities ranked by
   Calculus I coverage breadth").

In this stack: an Inngest scheduled function (already used in this repo)
writing to `coverage_aggregates`.

---

## 7. Application surface (Next.js routes)

| Route | Who | What |
|---|---|---|
| `/onboarding` | new user | uni → program → phase questions |
| `/dashboard` | all | subjects overview, progress %, pending surveys |
| `/subjects/[slug]` | all | the branch/tree outlook (+ coverage badges) |
| `/subjects/[slug]/track` | attending | mark subtopics done, mark subject finished |
| `/subjects/[slug]/survey` | finished | chunked topic-by-topic coverage survey |
| `/subjects/[slug]/gaps` | all (enrolled) | gap analysis for their uni+program |
| `/admin/curriculum` | editors | manage taxonomy, review suggestions |
| `/admin/verify` | moderators | verify student-added unis/programs |

API is Next.js server actions / route handlers over Drizzle; RLS on Postgres
(as already done in this repo's migration `0005_enable_rls.sql` style) keeps
each student's rows private.

---

## 8. Build order (phased)

1. **Phase 1 — Curriculum core**: schema, seed Calculus I, auth + onboarding,
   read-only tree outlook. *(Everything a "starting" student needs.)*
2. **Phase 2 — Tracking**: subtopic progress, subject finished action.
3. **Phase 3 — Survey**: grade capture, chunked coverage survey, resumability.
4. **Phase 4 — Aggregation**: nightly rollup, coverage badges, gap page,
   sample-size gating.
5. **Phase 5 — Breadth**: remaining first-year subjects (linear algebra,
   physics I, …), curriculum suggestion review, cohort/grade analytics.
