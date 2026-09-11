# חיבור האתר ל-Supabase — הוראות שלב-אחר-שלב

האתר עובד כבר עכשיו עם אחסון זמני (כדי שאפשר יהיה לבדוק ולהשתמש בו מיד). המסמך הזה מסביר איך לחבר אותו לפרויקט Supabase אמיתי, כדי לקבל אבטחה אמיתית (Authentication + RLS) ונתונים שלא תלויים בסביבת הצ'אט.

## שלב 1 — יצירת פרויקט Supabase

1. היכנסו ל-https://supabase.com ופתחו פרויקט חדש (יש תוכנית חינמית שמספיקה לחלוטין לפרויקט הזה).
2. שמרו ליד: **Project URL** ו-**anon public key** — נמצאים ב-Project Settings → API. אלה בטוחים לשימוש בצד הלקוח (לא ה-service role key — אותו אף פעם לא מכניסים לקוד של האתר).

## שלב 2 — הרצת קבצי ה-SQL

בתפריט הפרויקט: **SQL Editor** → New query. יש להריץ את שלושת הקבצים **בסדר הזה**, כל אחד בנפרד:

1. `supabase/migrations/0001_init.sql` — יוצר את הטבלאות (settings, sales, customers, orders, admins)
2. `supabase/migrations/0002_functions.sql` — יוצר את הפונקציות (`get_public_settings`, `get_open_sale`, `create_order`, `is_admin`)
3. `supabase/migrations/0003_rls.sql` — מפעיל את ההגנות (RLS) וחוסם גישה ישירה לטבלאות

אחרי ההרצה, כדאי לוודא ב-**Table Editor** שרואים 5 טבלאות, ושבטבלת `settings` יש שורה אחת עם ערכי ברירת מחדל.

## שלב 3 — הפעלת Authentication ויצירת משתמש מנהל (אביך)

1. בתפריט: **Authentication → Providers** — לוודא ש-Email מופעל (מופעל כברירת מחדל).
2. **Authentication → Users → Add user** — הזינו את האימייל שאביך ישתמש בו, ובחרו סיסמה (או שלחו לו קישור הזמנה, לפי מה שנוח). **הסיסמה נקבעת כאן, לא בקוד של האתר.**
3. אחרי יצירת המשתמש, העתיקו את ה-**User UID** שלו (עמודה בטבלת המשתמשים).
4. חזרו ל-SQL Editor והריצו (עם ה-UID וה-אימייל האמיתיים):

```sql
insert into admins (id, email)
values ('<ה-UID שהעתקתם>', '<כתובת האימייל>');
```

מעכשיו, רק המשתמש הזה (כי יש לו שורה בטבלת `admins`) יוכל להיכנס לאזור הניהול.

**להוספת מנהל נוסף בעתיד** — חוזרים בדיוק על שלבים 2–4.

## שלב 4 — חיבור האתר לפרויקט

כרגע קובץ האתר (`tamarim-site.jsx`) משתמש באחסון הזמני של סביבת הצ'אט. כדי לחבר אותו בפועל צריך:

1. להוציא את הקוד לסביבת פיתוח רגילה (למשל פרויקט Vite/Next.js), כי חיבור Supabase דורש חבילת `@supabase/supabase-js` וגישת רשת אמיתית — דברים שאין בסביבת הצ'אט הזו.
2. להתקין: `npm install @supabase/supabase-js`
3. ליצור קובץ `src/lib/supabaseClient.js`:

```js
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

4. לשמור את ה-URL וה-anon key בקובץ `.env` (לא ב-Git!):

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

5. להחליף את הפונקציות באובייקט `db` בקובץ `tamarim-site.jsx` בקריאות ל-Supabase, **באותם שמות פונקציה בדיוק** כדי ששאר האתר לא ישתנה. לדוגמה:

```js
// getSettings — היום קורא מ-window.storage, מחר:
async getSettings() {
  const { data, error } = await supabase.rpc('get_public_settings');
  if (error) throw error;
  return data?.[0] ?? null;
}

// submitOrder — היום כתוב ידנית בתוך App, מחר הופך לקריאה אחת:
async function submitOrder(formData) {
  const { data, error } = await supabase.rpc('create_order', {
    p_sale_id: currentSaleId,
    p_first_name: formData.firstName,
    p_last_name: formData.lastName,
    p_phone: formData.phone,
    p_area: formData.area,
    p_qty: formData.qty,
    p_notes: formData.notes,
    p_payment_method: formData.paymentMethod,
  });
  if (error) throw error;
  return data[0];
}
```

6. מסך הכניסה למנהל (`AdminGate`) יוחלף בטופס אימייל+סיסמה שקורא ל:

```js
const { error } = await supabase.auth.signInWithPassword({ email, password });
```

וכל מסך בניהול יבדוק בהתחלה:

```js
const { data: { user } } = await supabase.auth.getUser();
if (!user) { /* להציג מסך כניסה */ }
```

## רשימת בדיקות אחרי החיבור

- [ ] נכנסים לדף הבית ורואים את המכירה הפתוחה (או "אין מכירה פתוחה" אם עוד לא נפתחה)
- [ ] שולחים הזמנת בדיקה — מופיע מסך אישור עם מספר הזמנה נכון
- [ ] מנסים להיכנס ל-`/admin` **בלי** להתחבר — לא רואים שום הזמנה או פרטי לקוח
- [ ] מתחברים עם המשתמש שהוגדר כמנהל — רואים את כל ההזמנות והנתונים
- [ ] מתחברים עם משתמש **אחר** (לא רשום ב-admins, אם יש כזה לבדיקה) — לא אמורים לראות נתונים בכלל
- [ ] בטבלת `orders` ב-Supabase, בודקים שאי אפשר לקרוא ממנה עם ה-anon key בלי להיות מחוברים כמנהל (למשל דרך REST API ישירות)
- [ ] פותחים מכירה חדשה, סוגרים אותה, ומוודאים שהזמנות ישנות עדיין מציגות את המחיר הישן גם אחרי ששינוי מחיר ברירת המחדל
- [ ] בודקים ש-`service_role key` **לא** מופיע בשום מקום בקוד הצד-לקוח (רק ה-anon key)

## חשוב לזכור

- אף פעם אל תכניסו את ה-**service role key** לקוד של האתר — רק את ה-anon key.
- ניהול מנהלים (מי מורשה) נעשה ב-SQL Editor של Supabase, לא דרך האתר עצמו — זו בכוונה, כדי לא לבנות מערכת הרשאות מסובכת שלא צריך.
- אם בעתיד תרצו לשנות את מבנה הנתונים, עדיף להוסיף קובץ migration חדש (`0004_...sql`) ולא לערוך את הקבצים הקיימים.
