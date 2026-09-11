-- ============================================================================
-- 0002_functions.sql
-- פונקציות SECURITY DEFINER: אלה הדרך היחידה שבה לקוח אנונימי (הגולש הציבורי)
-- נוגע בנתונים. הן חושפות רק את מה שצריך, ואף פעם לא את טבלאות ה-orders /
-- customers עצמן. יש להריץ אחרי 0001_init.sql ולפני 0003_rls.sql.
-- ============================================================================

-- בדיקת "האם המשתמש המחובר הוא מנהל?" — משמשת גם את מדיניות ה-RLS
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins where id = auth.uid());
$$;

-- מידע ציבורי על המוכר, לצורך הצגה בדף הבית. בלי שום שדה פנימי.
create or replace function get_public_settings()
returns table (
  seller_name text,
  phone text,
  bit_link text,
  paybox_link text,
  customer_intro text,
  pickup_info text
)
language sql
stable
security definer
set search_path = public
as $$
  select seller_name, phone, bit_link, paybox_link, customer_intro, pickup_info
  from settings
  limit 1;
$$;

-- המכירה הפתוחה הנוכחית (אם יש), כולל כמות במלאי שנותרה — בלי לחשוף
-- שום מידע על הזמנות/לקוחות עצמם.
create or replace function get_open_sale()
returns table (
  id uuid,
  name text,
  status text,
  open_date timestamptz,
  close_date timestamptz,
  deadline timestamptz,
  prices jsonb,
  stock_enabled boolean,
  stock_total integer,
  stock_remaining integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id, s.name, s.status, s.open_date, s.close_date, s.deadline, s.prices,
    s.stock_enabled, s.stock_total,
    case
      when s.stock_enabled then
        greatest(0, s.stock_total - coalesce((
          select sum(o.qty) from orders o
          where o.sale_id = s.id and o.order_status <> 'cancelled'
        ), 0))
      else null
    end as stock_remaining
  from sales s
  where s.status = 'open'
  order by s.open_date desc
  limit 1;
$$;

-- יצירת הזמנה. זו הפונקציה היחידה שדרכה לקוח אנונימי יכול לכתוב נתונים.
-- מחשבת מחדש את הסכום מתוך sale.prices (תמחור מדורג - לא סומכת על שום סכום
-- מהלקוח), בודקת שהמכירה פתוחה, שהדדליין לא עבר, ושיש מלאי, ומעדכנת/יוצרת
-- רשומת customer.
create or replace function create_order(
  p_sale_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_area text,
  p_qty integer,
  p_notes text,
  p_payment_method text
)
returns table (
  order_number text,
  amount numeric,
  payment_method text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale sales%rowtype;
  v_rate numeric;
  v_amount numeric;
  v_seq integer;
  v_order_number text;
  v_customer_id uuid;
  v_remaining integer;
begin
  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    raise exception 'sale not found';
  end if;
  if v_sale.status <> 'open' then
    raise exception 'sale is closed';
  end if;
  if v_sale.deadline is not null and now() > v_sale.deadline then
    raise exception 'deadline passed';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'invalid quantity';
  end if;
  if p_payment_method not in ('cash', 'bit', 'paybox', 'other') then
    raise exception 'invalid payment method';
  end if;

  -- תמחור מדורג: המדרגה עם ה-minQty הגבוה ביותר שעדיין <= לכמות שהוזמנה.
  -- זהה בדיוק ללוגיקת calcAmount() בצד הלקוח.
  select (elem->>'pricePerUnit')::numeric into v_rate
  from jsonb_array_elements(v_sale.prices->'tiers') elem
  where (elem->>'minQty')::int <= p_qty
  order by (elem->>'minQty')::int desc
  limit 1;

  if v_rate is null then
    raise exception 'no matching price tier for this quantity';
  end if;
  v_amount := v_rate * p_qty;

  if v_sale.stock_enabled then
    select coalesce(sum(qty), 0) into v_remaining
    from orders where sale_id = p_sale_id and order_status <> 'cancelled';
    if (v_sale.stock_total - v_remaining) < p_qty then
      raise exception 'not enough stock remaining';
    end if;
  end if;

  v_seq := v_sale.order_seq + 1;
  v_order_number := '#' || lpad(v_seq::text, 3, '0');
  update sales set order_seq = v_seq where id = p_sale_id;

  insert into customers (phone, first_name, last_name, area, total_orders, total_packages)
  values (p_phone, p_first_name, p_last_name, p_area, 1, p_qty)
  on conflict (phone) do update
    set first_name = excluded.first_name,
        last_name = excluded.last_name,
        area = coalesce(excluded.area, customers.area),
        total_orders = customers.total_orders + 1,
        total_packages = customers.total_packages + excluded.total_packages,
        updated_at = now()
  returning id into v_customer_id;

  insert into orders (
    sale_id, customer_id, order_number, first_name, last_name, phone, area,
    qty, amount, pricing_snapshot, payment_method, payment_status, order_status, notes
  ) values (
    p_sale_id, v_customer_id, v_order_number, p_first_name, p_last_name, p_phone, p_area,
    p_qty, v_amount, v_sale.prices, p_payment_method, 'pending', 'pending_pickup', p_notes
  );

  return query select v_order_number, v_amount, p_payment_method;
end;
$$;

-- הרשאות הרצה: אנונימי + מחוברים יכולים לקרוא מידע ציבורי וליצור הזמנה,
-- אבל לא לקרוא ישירות מהטבלאות (זה נחסם ב-0003_rls.sql).
grant execute on function get_public_settings() to anon, authenticated;
grant execute on function get_open_sale() to anon, authenticated;
grant execute on function create_order(uuid, text, text, text, text, integer, text, text) to anon, authenticated;
