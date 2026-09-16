-- ============================================================================
-- 0011_add_site_name_to_settings.sql
-- מוסיף שדה "שם האתר" (site_name) לטבלת settings, ניתן לעריכה מתוך
-- ניהול -> הגדרות, ומוצג בעמוד הציבורי. עמודה חדשה בלבד, עם default
-- שמבטיח שהאתר לא יישבר גם אם אף אחד עדיין לא ערך אותה - לא נוגעת בשום
-- עמודה/שורה קיימת אחרת.
--
-- מעדכן גם את get_public_settings() כדי שתחזיר גם את site_name לצד
-- הציבורי - נדרש DROP+CREATE כי RETURNS TABLE משתנה (אותו דפוס בדיוק
-- כמו ב-0006/0007/0010 עבור admin_create_sale). שאר ההגדרה של הפונקציה
-- (security definer, stable, סינון, search_path) נשארת זהה לחלוטין.
--
-- להריץ ב-SQL Editor של Supabase, אחרי 0001-0010. לא רץ אוטומטית כאן.
-- ============================================================================

alter table public.settings
add column if not exists site_name text not null default 'מכירת תמרים טריים';

drop function if exists get_public_settings();

create or replace function get_public_settings()
returns table (
  seller_name text,
  phone text,
  bit_link text,
  paybox_link text,
  customer_intro text,
  pickup_info text,
  site_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select seller_name, phone, bit_link, paybox_link, customer_intro, pickup_info, site_name
  from settings
  limit 1;
$$;

-- אותה מדיניות הרשאה בדיוק כמו קודם, מוענקת מחדש כי ה-DROP FUNCTION
-- למעלה מוחק את ה-grants הקודמים יחד עם הפונקציה הישנה.
revoke all on function get_public_settings() from public;
grant execute on function get_public_settings() to anon, authenticated;
