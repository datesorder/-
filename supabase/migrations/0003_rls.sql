-- ============================================================================
-- 0003_rls.sql
-- מדיניות אבטחה: מפעיל RLS על כל הטבלאות, לא נותן ל-anon/authenticated רגילים
-- שום גישה ישירה לטבלאות (רק לפונקציות מ-0002_functions.sql), ונותן למנהלים
-- (מי שיש להם שורה בטבלת admins) גישה מלאה.
-- להריץ אחרי 0001_init.sql ו-0002_functions.sql.
-- ============================================================================

alter table settings enable row level security;
alter table sales enable row level security;
alter table customers enable row level security;
alter table orders enable row level security;
alter table admins enable row level security;

-- לוודא שהתפקידים הרגילים לא מקבלים גישה ישירה לטבלאות דרך ה-API
revoke all on settings, sales, customers, orders, admins from anon, authenticated;

-- ---------------------------------------------------------------------------
-- מדיניות מנהל: גישה מלאה לכל טבלה, רק למי שרשום ב-admins
-- ---------------------------------------------------------------------------
create policy "admins full access - settings"
  on settings for all
  using (is_admin())
  with check (is_admin());

create policy "admins full access - sales"
  on sales for all
  using (is_admin())
  with check (is_admin());

create policy "admins full access - customers"
  on customers for all
  using (is_admin())
  with check (is_admin());

create policy "admins full access - orders"
  on orders for all
  using (is_admin())
  with check (is_admin());

-- טבלת admins עצמה: בכוונה בלי שום מדיניות ל-anon/authenticated.
-- ניהול מנהלים (הוספה/הסרה) נעשה ידנית ב-SQL Editor של Supabase, לא דרך האתר.
-- (is_admin() רץ כ-SECURITY DEFINER ולכן עוקף את זה בבדיקות שלו בלבד)

-- הערה: ל-anon ול-authenticated הרגיל אין אף מדיניות select/insert/update/delete
-- על settings / sales / customers / orders — כלומר גישה חסומה כברירת מחדל.
-- הדרך היחידה שבה הלקוח הציבורי נוגע בנתונים היא דרך הפונקציות
-- get_public_settings() / get_open_sale() / create_order() שנוצרו ב-0002.
