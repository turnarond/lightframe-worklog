-- v3.0 初始 schema
-- 同步时间戳统一用 BIGINT 毫秒（与客户端 updatedAt 同尺度）。
-- 任务/日志/偏好整行以 jsonb 存储，保证前端任意字段不丢。

create table if not exists users(
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  display_name text,
  email_verified boolean default false,
  reset_token_hash text,
  reset_expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists tasks(
  id text not null,
  user_id uuid not null references users(id) on delete cascade,
  updated_at bigint not null,
  deleted_at bigint,
  data jsonb not null,
  primary key (user_id, id)
);
create index if not exists tasks_user_upd on tasks(user_id, updated_at);

create table if not exists daily_logs(
  date text not null,
  user_id uuid not null references users(id) on delete cascade,
  updated_at bigint not null,
  deleted_at bigint,
  data jsonb not null,
  primary key (user_id, date)
);
create index if not exists logs_user_upd on daily_logs(user_id, updated_at);

create table if not exists prefs(
  key text not null,
  user_id uuid not null references users(id) on delete cascade,
  updated_at bigint not null,
  deleted_at bigint,
  data jsonb not null,
  primary key (user_id, key)
);
create index if not exists prefs_user_upd on prefs(user_id, updated_at);
