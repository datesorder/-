-- ============================================================================
-- 0001_init.sql
-- טבלאות הבסיס עבור אתר מכירת התמרים.
-- להריץ בסביבת ה-SQL Editor של Supabase (או דרך ה-CLI), בסדר הזה.
-- ============================================================================

create extension if not exists "pgcrypto"; -- עבור gen_random_uuid()

-- ---------------------------------------------------------------------------
-- settings: שורה יחידה עם פרטי המוכר וברירות המחדל
-- ---------------------------------------------------------------------------
create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  seller_name text not null default 'משק התמרים',
  phone text not null default '',
  bit_link text not null default '',
  paybox_link text not null default '',
  customer_intro text not null default '',
  pickup_info text not null default '',
  -- ברירת מחדל למכירה חדשה בלבד. לא משפיע על מכירות קיימות.
  default_prices jsonb not null default '{"1":40,"2":80,"3":120,"4":140}',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- sales: כל מכירה חודשית, כולל עותק קפוא של המחירים בזמן הפתיחה
-- ---------------------------------------------------------------------------
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  open_date timestamptz not null default now(),
  close_date timestamptz,
  status text not null default 'open' check (status in ('open', 'closed')),
  stock_enabled boolean not null default false,
  stock_total integer,
  -- עותק קבוע של המחירים בזמן פתיחת המכירה. שינוי מאוחר יותר ב-settings
  -- לא משפיע על המכירה הזו.
  -- מבנה: {"tiers": [{"minQty": 1, "pricePerUnit": 40}, {"minQty": 4, "pricePerUnit": 35}]}
  -- כמות כלשהי מתומחרת לפי המדרגה הגבוהה ביותר שהיא עומדת בה, כפול הכמות.
  prices jsonb not null,
  order_seq integer not null default 0,
  -- דדליין להזמנות, משולב בתוך אותה ישות מכירה (לא טבלה/מנגנון נפרד).
  -- create_order() דוחה הזמנות אחרי שהזמן הזה עבר, גם אם status עדיין 'open'.
  deadline timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_status on sales (status);

-- ---------------------------------------------------------------------------
-- customers: לקוחות חוזרים, מזוהים לפי טלפון בלבד (לא CRM מלא)
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  first_name text,
  last_name text,
  area text,
  total_orders integer not null default 0,
  total_packages integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- orders: הזמנות, עם סכום קבוע (amount) שלא מחושב מחדש לעולם
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete cascade,
  customer_id uuid references customers (id) on delete set null,
  order_number text not null,
  first_name text not null,
  last_name text not null,
  phone text not null,
  area text,
  qty integer not null check (qty > 0),
  amount numeric not null,
  pricing_snapshot jsonb not null, -- המחירים שהיו תקפים ברגע ההזמנה (לצורך שינוי כמות מאוחר יותר)
  payment_method text not null check (payment_method in ('cash', 'bit', 'paybox', 'other')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid')),
  order_status text not null default 'pending_pickup' check (order_status in ('pending_pickup', 'delivered', 'cancelled')),
  notes text,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_sale on orders (sale_id);
create index if not exists idx_orders_phone on orders (phone);
create unique index if not exists idx_orders_sale_number on orders (sale_id, order_number);

-- ---------------------------------------------------------------------------
-- admins: מיפוי בין משתמש ב-Supabase Auth לבין הרשאת ניהול
-- שורה כאן = מנהל מורשה. הוספה/הסרה נעשית ידנית ב-SQL Editor, לא דרך האתר.
-- ---------------------------------------------------------------------------
create table if not exists admins (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

-- שורת הגדרות ראשונית (מריצים פעם אחת)
insert into settings (seller_name, customer_intro)
select 'משק התמרים', 'תמרים טריים, ישר מהמשק, נמכרים בערך פעם בחודש.'
where not exists (select 1 from settings);
