-- ============================================================================
-- 0010_add_pickup_date_to_admin_create_sale.sql
-- שלב 2 ממנגנון "תאריך איסוף": מוסיף פרמטר חדש p_pickup_date (date,
-- default null) ל-admin_create_sale(), ששומר אותו בעמודת sales.pickup_date
-- שכבר נוספה ב-0009. שום לוגיקה קיימת אחרת (תמחור, מלאי, deadline, status,
-- closeCurrent, הרשאות) לא השתנתה - אותה לוגיקה בדיוק כמו ב-0007, עם
-- תוספת אחת בלבד: pickup_date נכנס ל-INSERT ומוחזר גם ב-RETURNS TABLE
-- (באותו דפוס בדיוק כמו 0005, שהוסיפה את id להחזרה של create_order).
--
-- הוספת פרמטר חדש משנה את חתימת הפונקציה, ולכן (כמו ב-0006/0008) נדרש
-- DROP FUNCTION עם החתימה המדויקת הקיימת (מ-0007) לפני היצירה מחדש.
-- להריץ ב-SQL Editor של Supabase, אחרי 0001-0009.
-- ============================================================================

drop function if exists admin_create_sale(text, timestamptz, jsonb, boolean, integer, boolean);

create or replace function admin_create_sale(
  p_name text,
  p_deadline timestamptz,
  p_prices jsonb,
  p_stock_enabled boolean default false,
  p_stock_total integer default null,
  p_close_current boolean default true,
  p_pickup_date date default null
)
returns table (
  id uuid,
  name text,
  open_date timestamptz,
  close_date timestamptz,
  status text,
  stock_enabled boolean,
  stock_total integer,
  prices jsonb,
  order_seq integer,
  deadline timestamptz,
  pickup_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- הפונקציה רצה כ-SECURITY DEFINER (עוקפת RLS), ולכן חייבת לבדוק הרשאה
  -- בעצמה - בניגוד לפעולת טבלה רגילה שכבר מוגנת ע"י מדיניות ה-RLS.
  if not is_admin() then
    raise exception 'not authorized';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'sale name is required';
  end if;
  if p_prices is null then
    raise exception 'prices is required';
  end if;

  -- closeCurrent: סוגר אטומית, באותה טרנזקציה, כל מכירה שעדיין 'open' -
  -- מקביל בדיוק להתנהגות הקיימת ב-createSale() (רק מכירה אחת אמורה
  -- להיות פתוחה בו-זמנית, כך שזה שקול לסגירת "המכירה הנוכחית" הספציפית,
  -- אך חסין יותר למקרה קצה של יותר משורה 'open' אחת).
  if p_close_current then
    update sales
    set status = 'closed', close_date = now()
    where sales.status = 'open';
  end if;

  insert into sales (
    name, status, stock_enabled, stock_total, prices, order_seq, deadline, pickup_date
  ) values (
    btrim(p_name), 'open', coalesce(p_stock_enabled, false), p_stock_total, p_prices, 0, p_deadline, p_pickup_date
  )
  returning sales.id into v_id;

  return query
    select s.id, s.name, s.open_date, s.close_date, s.status, s.stock_enabled,
           s.stock_total, s.prices, s.order_seq, s.deadline, s.pickup_date
    from sales s
    where s.id = v_id;
end;
$$;

-- אותה מדיניות הרשאה בדיוק כמו קודם, מוענקת מחדש כי החתימה השתנתה
-- (ה-DROP FUNCTION למעלה מוחק את ה-grants הקודמים יחד עם הפונקציה הישנה).
revoke all on function admin_create_sale(text, timestamptz, jsonb, boolean, integer, boolean, date) from public;
grant execute on function admin_create_sale(text, timestamptz, jsonb, boolean, integer, boolean, date) to authenticated;
