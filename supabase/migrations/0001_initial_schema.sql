-- QuanTrade initial schema.
-- Money is numeric(18,4): never float, because a float ledger drifts.

create table books (
  id               text primary key,
  market           text not null check (market in ('NSE','US')),
  currency         text not null check (currency in ('INR','USD')),
  starting_capital numeric(18,4) not null,
  cash             numeric(18,4) not null,
  created_at       timestamptz not null default now()
);

create table instruments (
  symbol text primary key,
  market text not null check (market in ('NSE','US')),
  name   text not null,
  sector text not null
);

create table daily_bars (
  symbol text not null references instruments(symbol) on delete cascade,
  date   date not null,
  open   numeric(18,4) not null,
  high   numeric(18,4) not null,
  low    numeric(18,4) not null,
  close  numeric(18,4) not null,
  volume bigint not null,
  primary key (symbol, date),
  constraint bar_coherent check (
    high >= greatest(open, close) and
    low  <= least(open, close) and
    high >= low and volume >= 0
  )
);

create table runs (
  id         uuid primary key default gen_random_uuid(),
  book_id    text references books(id),
  type       text not null check (type in ('propose','settle','reflect')),
  status     text not null check (status in ('running','ok','failed','skipped')),
  model      text,
  tokens     integer,
  error      text,
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);

create table proposals (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references runs(id) on delete cascade,
  book_id               text not null references books(id),
  symbol                text not null references instruments(symbol),
  direction             text not null check (direction in ('long','short')),
  conviction            numeric(4,3) not null check (conviction between 0 and 1),
  stop_loss             numeric(18,4) not null,
  target                numeric(18,4) not null,
  max_hold_sessions     smallint not null check (max_hold_sessions between 1 and 10),
  thesis                text not null,
  rules_applied         text[] not null default '{}',
  falsifier             text not null,
  signals_snapshot      jsonb not null,
  status                text not null default 'pending'
                        check (status in ('pending','approved','rejected','expired','engine_rejected')),
  engine_reject_reason  text,
  expires_at            timestamptz not null,
  decided_at            timestamptz,
  created_at            timestamptz not null default now()
);

create table positions (
  id                uuid primary key default gen_random_uuid(),
  proposal_id       uuid not null references proposals(id) on delete cascade,
  book_id           text not null references books(id),
  symbol            text not null references instruments(symbol),
  sector            text not null,
  direction         text not null check (direction in ('long','short')),
  qty               integer not null check (qty > 0),
  entry_price       numeric(18,4) not null,
  entry_date        date not null,
  stop_loss         numeric(18,4) not null,
  target            numeric(18,4) not null,
  max_hold_sessions smallint not null,
  entry_costs       numeric(18,4) not null default 0,
  status            text not null default 'open' check (status in ('open','closed')),
  is_shadow         boolean not null default false,
  exit_price        numeric(18,4),
  exit_date         date,
  exit_reason       text check (exit_reason in ('stop','target','max_hold','forced')),
  exit_costs        numeric(18,4),
  gross_pnl         numeric(18,4),
  net_pnl           numeric(18,4),
  created_at        timestamptz not null default now(),
  -- A closed position must carry a complete exit record. This makes the
  -- half-written state you get from a crashed settle impossible to persist.
  constraint exit_complete check (
    status = 'open' or
    (exit_price is not null and exit_date is not null and
     exit_reason is not null and net_pnl is not null)
  ),
  -- One position per proposal, so a retried settle cannot double-open.
  constraint one_position_per_proposal unique (proposal_id)
);

create table post_mortems (
  id          uuid primary key default gen_random_uuid(),
  position_id uuid not null unique references positions(id) on delete cascade,
  category    text not null check (category in
              ('thesis_wrong','thesis_right_timing_wrong','rule_violated','unmodelled_event','correct')),
  expected    text not null,
  actual      text not null,
  lesson      text not null,
  created_at  timestamptz not null default now()
);

create table reflections (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references runs(id) on delete cascade,
  book_id        text not null references books(id),
  trades_covered uuid[] not null,
  commit_sha     text,
  summary        text not null,
  rules_added    text[] not null default '{}',
  rules_retired  text[] not null default '{}',
  created_at     timestamptz not null default now()
);

create table equity_snapshots (
  book_id         text not null references books(id),
  date            date not null,
  equity          numeric(18,4) not null,
  cash            numeric(18,4) not null,
  deployed        numeric(18,4) not null,
  benchmark_value numeric(18,4),
  primary key (book_id, date)
);

create index proposals_pending_idx on proposals (book_id, status, created_at desc);
create index positions_open_idx    on positions (book_id, status);
create index positions_closed_idx  on positions (book_id, exit_date desc) where status = 'closed';
create index bars_symbol_date_idx  on daily_bars (symbol, date desc);
create index runs_book_type_idx    on runs (book_id, type, started_at desc);

-- Single-owner app: any authenticated user may read; only the service role writes.
alter table books            enable row level security;
alter table instruments      enable row level security;
alter table daily_bars       enable row level security;
alter table runs             enable row level security;
alter table proposals        enable row level security;
alter table positions        enable row level security;
alter table post_mortems     enable row level security;
alter table reflections      enable row level security;
alter table equity_snapshots enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'books','instruments','daily_bars','runs','proposals',
    'positions','post_mortems','reflections','equity_snapshots'
  ] loop
    execute format('create policy %I_read on %I for select to authenticated using (true);', t, t);
  end loop;
end $$;

-- The one write the browser is allowed: deciding a pending proposal.
create policy proposals_decide on proposals
  for update to authenticated
  using (status = 'pending')
  with check (status in ('approved','rejected'));

insert into books (id, market, currency, starting_capital, cash) values
  ('nse-main', 'NSE', 'INR', 999999, 999999),
  ('us-main',  'US',  'USD', 999999, 999999);
