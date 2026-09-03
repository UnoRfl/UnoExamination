# Database

The whole backend is this database. There is no server code: row level
security decides which rows you can touch, `SECURITY DEFINER` functions decide
what you can do, and grading runs inside Postgres so the answer key is never
sent to a browser.

## Recreating it on a fresh project

The migrations below are already applied to the live project. To stand up
a new one, run [`dump-schema.sql`](dump-schema.sql) on a project that already
has the schema — it prints a single complete script you paste into the new
project's SQL Editor. Or with the CLI:

```bash
supabase link --project-ref <SOURCE_REF>
supabase db dump -f schema.sql --schema public,private
supabase link --project-ref <NEW_REF>
psql "$(supabase db url --linked)" -f schema.sql
```

Then set a bootstrap code so the first professor can promote themself:

```sql
insert into private.config (key, value)
values ('bootstrap_secret', 'PICK-A-LONG-RANDOM-STRING')
on conflict (key) do update set value = excluded.value;
```

Enter that code once on `/professor.html`; it is deleted after a single use.

## Migrations, in order

| # | Migration | What it establishes |
|---|---|---|
| 1 | `exam_core_schema` | enums, `profiles`, `exams`, `questions`, `answer_keys`, `sessions`, `session_events`, `grades`. One attempt per student is a `unique (exam_code, student_id)` constraint, not application logic. |
| 2 | `exam_security_helpers` | `private.*` predicates: my role, e-mail confirmed, do I own this exam, is the exam open, am I on the roster, **is this session still writable** (the server-side deadline), plus the signup trigger that creates a profile. |
| 3 | `exam_rls_policies` | RLS on every table. Students get one exam by code while it is open; questions only after their session exists; `answer_keys` has no student policy at all. |
| 4 | `exam_immutability_triggers` | Column-level rules RLS cannot express: identity and `started_at` immutable, violations monotonic, only `in_progress → submitted\|locked`, timestamps taken from the server, professors may not author answers. |
| 5 | `exam_grading_engine` | `private.norm_text`, `private.score_one`, `public.grade_session`, `grade_exam`, `set_override`, `set_feedback`. Text answers are normalised the same way the old client did (case, spacing, smart quotes, edge punctuation). |
| 6 | `exam_rpcs_and_bootstrap` | `claim_professor`, `set_role_by_email`, `start_exam`, `get_paper` (deterministic per-session shuffle, no key), `exam_intro`, and the `private.config` table. |
| 7 | `guards_allow_service_role` | Lets a trusted server-side caller (`auth.uid()` null) administer, since RLS already keeps `anon` away from these tables. |
| 8 | `lock_rpc_execute_grants` | Revokes EXECUTE from `PUBLIC`/`anon` on every definer function — revoking from `anon` alone does nothing, because `PUBLIC` holds the default grant that `anon` inherits. |
| 9 | `grant_rls_helper_execute` | Grants EXECUTE on the ten policy helpers to `authenticated`. An RLS policy runs as the *querying* role, so without this every policy fails with "permission denied for function is_professor". Guard, trigger and grading internals stay revoked. |
| 10 | `add_admin_role` | Adds `admin` to the `app_role` enum, alone — Postgres will not let a new enum value be *used* in the transaction that adds it. |
| 11 | `exam_type_teachers_and_roster` | `exams.exam_type`; `exam_teachers` (co-teachers) and `exam_roster` (a class list with names, numbers and sections, migrated from the old `exams.roster` array). Redefines `private.owns_exam` to mean **may manage this exam** — owner, co-teacher or administrator — which extends every existing policy at once, and adds the narrower `private.exam_owner` for the things a co-teacher must not do. Drops `profiles_promote`, which let any professor rewrite any other profile. |
| 12 | `roster_teachers_stats_rpcs` | `exams.passing_percent`; `roster_upsert` / `roster_remove`, `teacher_add` / `teacher_remove` / `exam_teachers_list`, `exam_section_stats`, `reset_sessions`, `staff_overview`, `admin_stats`. `set_role_by_email` is narrowed: a professor may invite a *student* to be a professor and nothing else. `start_exam` takes the student's number and section from the roster when they are on it. |
| 13-14 | `fix_*_variable_shadowing*` | A local variable named `code` was ambiguous with `exams.code` in six functions, so they raised at runtime. Renamed to `v_code`. Caught by the role probe, not by review. |

## Testing it

`npm run test:e2e` signs in as a real professor and two real students and drives
the REST API exactly as the browser does: the full lifecycle, then 18 attacks.
It needs a service-role key, used only to create, confirm and delete throwaway
accounts:

```bash
SUPABASE_SERVICE_KEY=... npm run test:e2e
```

Last run: **62 assertions passed, 0 failed.**

### The role probe

The roles, the roster and the co-teacher rules were verified against the live
project by impersonating each role with `set_config('request.jwt.claims', …)`
and asserting both directions — what each role *can* do and what it *cannot*.
24 checks, all passing:

- a professor cannot add themselves as a co-teacher; the owner can add one
- a student can never be made a teacher
- a co-teacher can read and edit the roster, and read section statistics
- a co-teacher cannot delete the exam, add another teacher, or take ownership
- a student cannot read the roster or the teacher list, reset attempts, read
  section statistics, edit a roster, see the staff overview, or change a role
- a professor cannot demote another professor, create an administrator, or see
  the staff overview — but can invite a student to become a professor
- re-importing a class list updates students rather than duplicating them

It found two real defects: the variable shadowing in migrations 13-14, and the
`profiles_promote` policy that let any professor rewrite any other profile.
