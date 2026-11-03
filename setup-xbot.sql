-- run once in Supabase SQL editor (tables are only reachable by the job, not by the public)
create table if not exists forum_x_state (handle text primary key, user_id uuid not null, started_at timestamptz not null default now());
create table if not exists forum_x_seen (tweet_id text primary key, handle text not null, post_id uuid references forum_posts(id) on delete set null, created_at timestamptz not null default now());
alter table forum_x_state enable row level security;
alter table forum_x_seen enable row level security;
