import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from './lib/supabaseClient';
import { adminGetSettings, adminListSales, adminCreateSale, adminGetOrders, adminGetCustomer, adminUpdateOrder, adminBulkUpdateOrders, adminCloseSale } from './lib/adminApi';
import { getOpenSale, createOrder } from './lib/publicApi';

/* =========================================================================
   שכבת גישה לנתונים (Data Access Layer)
   -------------------------------------------------------------------------
   כל התקשורת עם האחסון עוברת רק דרך האובייקט `db` שלמטה.
   כרגע הוא משתמש באחסון הזמני של הסביבה (window.storage) כדי שהאתר
   יעבוד ויישמר בין ביקורים כבר עכשיו.

   TODO(Supabase): כשיהיה חיבור אמיתי ל-Supabase, צריך להחליף רק את
   הפונקציות בתוך האובייקט הזה (באותם שמות ואותה חתימה) בקריאות
   supabase-js מול טבלאות sales / orders / settings. שאר האפליקציה
   לא צריכה להשתנות בכלל.
   ========================================================================= */

const SHARED = true; // כל המבקרים (לקוחות + מנהל) חולקים את אותם הנתונים

function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// הופך כל צורת כתיבה של טלפון (עם רווחים/נקודות/מקפים) למפתח תקין ועקבי
// לאחסון, כדי שהתאמת "לקוח חוזר" תעבוד גם אם מספרים נכתבו בפורמט שונה,
// ובעיקר כדי שלעולם לא ניצור מפתח לא-תקין (למשל עם רווח) שיגרום לשמירה להיכשל.
function sanitizePhoneKey(phone) {
  return (phone || '').replace(/[^0-9]/g, '') || 'unknown';
}

const db = {
  async getSettings() {
    try {
      const r = await window.storage.get('settings', SHARED);
      return r ? JSON.parse(r.value) : null;
    } catch {
      return null;
    }
  },
  async saveSettings(settings) {
    try {
      await window.storage.set('settings', JSON.stringify(settings), SHARED);
    } catch {
      // window.storage אינו קיים מחוץ לסביבת Claude - מתעלמים בשקט
    }
  },
  async listSaleIds() {
    try {
      const r = await window.storage.get('salesIndex', SHARED);
      return r ? JSON.parse(r.value) : [];
    } catch {
      return [];
    }
  },
  async saveSaleIds(ids) {
    try {
      await window.storage.set('salesIndex', JSON.stringify(ids), SHARED);
    } catch {
      // window.storage אינו קיים מחוץ לסביבת Claude - מתעלמים בשקט
    }
  },
  async getSale(id) {
    try {
      const r = await window.storage.get(`sale:${id}`, SHARED);
      return r ? JSON.parse(r.value) : null;
    } catch {
      return null;
    }
  },
  async saveSale(sale) {
    try {
      await window.storage.set(`sale:${sale.id}`, JSON.stringify(sale), SHARED);
    } catch {
      // window.storage אינו קיים מחוץ לסביבת Claude - מתעלמים בשקט
    }
  },
  async getOrders(saleId) {
    try {
      const r = await window.storage.get(`orders:${saleId}`, SHARED);
      return r ? JSON.parse(r.value) : [];
    } catch {
      return [];
    }
  },
  async saveOrders(saleId, orders) {
    try {
      await window.storage.set(`orders:${saleId}`, JSON.stringify(orders), SHARED);
    } catch {
      // window.storage אינו קיים מחוץ לסביבת Claude - מתעלמים בשקט
    }
  },
  // TODO(Supabase): today this is a simple key/value lookup. In Supabase this
  // becomes `select * from customers where phone = $1`.
  // Keyed by a sanitized (digits-only) phone, not the raw typed string —
  // window.storage keys can't contain spaces, and customers type phone
  // numbers with all kinds of formatting (spaces, dots, dashes).
  async getCustomer(phone) {
    try {
      const r = await window.storage.get(`customer:${sanitizePhoneKey(phone)}`, SHARED);
      return r ? JSON.parse(r.value) : null;
    } catch {
      return null;
    }
  },
  // TODO(Supabase): becomes an upsert into `customers` (on conflict phone).
  async saveCustomer(customer) {
    try {
      await window.storage.set(`customer:${sanitizePhoneKey(customer.phone)}`, JSON.stringify(customer), SHARED);
    } catch {
      // window.storage אינו קיים מחוץ לסביבת Claude - מתעלמים בשקט
    }
  },
};

/* TODO(Supabase): the `submitOrder` function inside the App component
   further down is written to mirror exactly what the
   `create_order` Postgres RPC function will do once Supabase is connected:
   look up the sale, validate it's open, compute the amount from the sale's
   frozen prices (never trust a client-supplied amount), upsert the
   customer by phone, and insert the order. Keeping that logic in one place
   today makes the eventual swap a small, mechanical change. */

/* ========================= קבועים וברירות מחדל ========================= */

const DEFAULT_SETTINGS = {
  sellerName: 'משק התמרים',
  phone: '',
  bitLink: '',
  payboxLink: '',
  // ברירת המחדל למכירה חדשה בלבד. לכל מכירה יש עותק קפוא משלה ב-sale.prices,
  // כך ששינוי כאן לא משפיע על מכירות שכבר נפתחו.
  // תמחור מדורג: 1-3 קופסאות = 40 ₪ ליחידה, 4+ = 35 ₪ ליחידה.
  defaultPrices: { tiers: [{ minQty: 1, pricePerUnit: 40 }, { minQty: 4, pricePerUnit: 35 }] },
  customerIntro: 'תמרים טריים, ישר מהמשק, נמכרים בערך פעם בחודש.',
  pickupInfo: '',
};

const PAYMENT_METHODS = [
  { v: 'cash', label: 'מזומן' },
  { v: 'bit', label: 'Bit' },
  { v: 'paybox', label: 'PayBox' },
  { v: 'other', label: 'אחר' },
];

const ORDER_STATUSES = [
  { v: 'pending_pickup', label: 'ממתין לאיסוף', tone: 'gold' },
  { v: 'delivered', label: 'נמסרה', tone: 'green' },
  { v: 'cancelled', label: 'בוטלה', tone: 'red' },
];

const PAYMENT_STATUS_LABEL = { pending: 'ממתין לתשלום', paid: 'שולם' };

// תצוגה בלבד: כשההזמנה שולמה והלקוח דיווח שזה קרה דרך Bit/PayBox (בזרימה
// האוטומטית), מציגים את זה בפירוש. זה דיווח של הלקוח, לא אימות טכני.
// לא משנה את ערך paymentStatus עצמו (עדיין 'pending'/'paid' בכל מקום אחר -
// דוחות, סינון, סטטיסטיקות ממשיכים לעבוד בדיוק כמו קודם).
function paymentStatusDisplay(order) {
  if (order.paymentStatus !== 'paid') return PAYMENT_STATUS_LABEL.pending;
  if (order.paymentMethod === 'bit') return 'שולם ב-Bit';
  if (order.paymentMethod === 'paybox') return 'שולם ב-PayBox';
  return PAYMENT_STATUS_LABEL.paid;
}

/* ============================ פונקציות עזר ============================= */

const fmtCurrency = (n) => `₪${Number(n || 0).toLocaleString('he-IL')}`;
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

// דדליין הזמנות למכירה: משולב בתוך sale.deadline (ISO), לא מנגנון נפרד.
// נבדק תמיד "on demand" (בטעינה ובזמן שליחה) - אין תזמון רקע אמיתי כרגע.
function isDeadlinePassed(sale) {
  return !!(sale && sale.deadline && Date.now() > new Date(sale.deadline).getTime());
}

function isSaleAcceptingOrders(sale) {
  return !!(sale && sale.status === 'open' && !isDeadlinePassed(sale));
}

const fmtDeadline = (iso) =>
  iso
    ? new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

// תמחור מדורג: prices = { tiers: [{ minQty, pricePerUnit }, ...] }.
// לכל כמות מוצא את המדרגה הגבוהה ביותר שהכמות עומדת בה, וכופל במחיר ליחידה.
// TODO(Supabase): create_order() צריך לבצע בדיוק את אותו חישוב בצד השרת -
// ראו העדכון המקביל ב-0002_functions.sql - לעולם לא לסמוך על סכום מהלקוח.
function calcAmount(prices, qty) {
  const q = Number(qty) || 0;
  const tiers = prices && Array.isArray(prices.tiers) ? prices.tiers : [];
  if (!tiers.length || q <= 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let rate = sorted[0].pricePerUnit;
  for (const t of sorted) {
    if (q >= t.minQty) rate = t.pricePerUnit;
  }
  return q * rate;
}

function ratePerUnitForQty(prices, qty) {
  const q = Number(qty) || 0;
  return q > 0 ? calcAmount(prices, q) / q : 0;
}

function toWhatsAppPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
}

function waLinkForOrder(order, settings) {
  const phone = toWhatsAppPhone(order.phone);
  if (!phone) return null;
  const text = `שלום ${order.firstName}, לגבי הזמנת התמרים שלך (מספר הזמנה ${order.orderNumber}) - כמות: ${order.qty} אריזות, סכום לתשלום: ${fmtCurrency(
    order.amount
  )}. תודה, ${settings.sellerName || ''}`.trim();
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

function orderStatusMeta(v) {
  return ORDER_STATUSES.find((s) => s.v === v) || ORDER_STATUSES[0];
}

function suggestedSaleName() {
  const label = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' }).format(new Date());
  return `מכירת תמרים – ${label}`;
}

function computeStockRemaining(sale, orders) {
  if (!sale?.stockEnabled) return null;
  const used = (orders || [])
    .filter((o) => o.orderStatus !== 'cancelled')
    .reduce((sum, o) => sum + Number(o.qty || 0), 0);
  return Math.max(0, Number(sale.stockTotal || 0) - used);
}

function exportOrdersToCSV(sale, orders) {
  const headers = [
    'מספר הזמנה',
    'תאריך',
    'שם פרטי',
    'שם משפחה',
    'טלפון',
    'אזור',
    'כמות',
    'סכום',
    'אמצעי תשלום',
    'סטטוס תשלום',
    'סטטוס הזמנה',
    'הערות לקוח',
  ];
  const rows = orders.map((o) => [
    o.orderNumber,
    fmtDate(o.createdAt),
    o.firstName,
    o.lastName,
    o.phone,
    o.area || '',
    o.qty,
    o.amount,
    PAYMENT_METHODS.find((m) => m.v === o.paymentMethod)?.label || o.paymentMethod,
    paymentStatusDisplay(o),
    orderStatusMeta(o.orderStatus).label,
    (o.notes || '').replace(/\n/g, ' '),
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `הזמנות-${sale?.name || 'מכירה'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// דוח מלא של מכירה: קובץ Excel (.xlsx) אמיתי עם גיליון הזמנות מפורט
// וגיליון סיכום. עובד היום מקומית/DEMO; אחרי חיבור Supabase אותה פונקציה
// יכולה להישאר זהה - רק מקור ה-orders/sale ישתנה מ-window.storage לשאילתה.
function buildSaleReportWorkbook(sale, orders) {
  const active = orders.filter((o) => o.orderStatus !== 'cancelled');
  const cancelled = orders.filter((o) => o.orderStatus === 'cancelled');
  const delivered = active.filter((o) => o.orderStatus === 'delivered');
  const pendingPickup = active.filter((o) => o.orderStatus === 'pending_pickup');
  const paid = active.filter((o) => o.paymentStatus === 'paid');
  const revenue = active.reduce((s, o) => s + Number(o.amount || 0), 0);
  const paidAmount = paid.reduce((s, o) => s + Number(o.amount || 0), 0);

  const ordersHeader = [
    'מספר הזמנה', 'תאריך ושעת הזמנה', 'שם פרטי', 'שם משפחה', 'טלפון', 'אזור',
    'כמות חבילות', 'סכום', 'אמצעי תשלום', 'סטטוס תשלום', 'סטטוס מסירה', 'הערות',
  ];
  const ordersRows = orders.map((o) => [
    o.orderNumber,
    fmtDateTime(o.createdAt),
    o.firstName,
    o.lastName,
    o.phone,
    o.area || '',
    o.qty,
    o.amount,
    PAYMENT_METHODS.find((m) => m.v === o.paymentMethod)?.label || o.paymentMethod,
    paymentStatusDisplay(o),
    orderStatusMeta(o.orderStatus).label,
    o.notes || '',
  ]);
  const ordersSheet = XLSX.utils.aoa_to_sheet([ordersHeader, ...ordersRows]);
  ordersSheet['!cols'] = [10, 16, 12, 12, 12, 12, 8, 8, 10, 12, 12, 24].map((w) => ({ wch: w }));

  const byMethod = PAYMENT_METHODS.map((m) => {
    const inMethod = active.filter((o) => o.paymentMethod === m.v);
    return [m.label, inMethod.length, inMethod.reduce((s, o) => s + Number(o.amount || 0), 0)];
  });

  const summaryRows = [
    ['דוח מכירה', sale.name],
    ['נפתחה', fmtDateTime(sale.openDate)],
    ['דדליין הזמנות', sale.deadline ? fmtDeadline(sale.deadline) : 'לא הוגדר'],
    ['סטטוס', sale.status === 'open' ? 'פתוחה' : 'סגורה'],
    [],
    ['מספר הזמנות (לא כולל בוטלו)', active.length],
    ['מספר חבילות', active.reduce((s, o) => s + Number(o.qty || 0), 0)],
    ['סך הכנסות', revenue],
    ['שולם', paidAmount],
    ['לא שולם', revenue - paidAmount],
    ['נמסרו', delivered.length],
    ['ממתינים לאיסוף', pendingPickup.length],
    ['הזמנות שבוטלו', cancelled.length],
    [],
    ['חלוקה לפי אמצעי תשלום', 'מספר הזמנות', 'סכום'],
    ...byMethod,
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 26 }, { wch: 16 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'סיכום');
  XLSX.utils.book_append_sheet(wb, ordersSheet, 'הזמנות');
  return wb;
}

function exportSaleReport(sale, orders) {
  const wb = buildSaleReportWorkbook(sale, orders);
  XLSX.writeFile(wb, `דוח-${sale.name}.xlsx`);
}

/* ============================ רכיבי UI קטנים ============================ */

function GlobalStyle() {
  return (
    <style>{`
      /* פונטים: לא תלויים ברשת (הטענת Google Fonts לא אמינה בסביבת התצוגה).
         מחרוזת פונטים מערכת רחבה, עם כיסוי טוב לעברית בכל מערכת הפעלה. */
      .tmr-root, .tmr-root * {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        box-sizing: border-box;
      }
      .tmr-display {
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .tmr-root input, .tmr-root select, .tmr-root textarea, .tmr-root button { font-family: inherit; }
      .tmr-scrollbar::-webkit-scrollbar { height: 6px; }
      .tmr-scrollbar::-webkit-scrollbar-thumb { background: #d6cbb2; border-radius: 4px; }
      .tmr-card-shadow { box-shadow: 0 1px 2px rgba(28, 20, 12, 0.04), 0 8px 24px -12px rgba(28, 20, 12, 0.12); }
    `}</style>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="h-8 w-8 rounded-full border-2 border-amber-800 border-t-transparent animate-spin" />
    </div>
  );
}

function Button({ children, variant = 'primary', className = '', ...props }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-amber-800/30';
  const variants = {
    primary: 'bg-amber-900 text-amber-50 shadow-sm hover:bg-amber-800',
    secondary: 'bg-white text-amber-900 border border-amber-900/25 hover:bg-amber-50',
    ghost: 'bg-transparent text-stone-500 hover:bg-stone-100',
    danger: 'bg-rose-800 text-rose-50 hover:bg-rose-900',
    subtle: 'bg-stone-100 text-stone-700 hover:bg-stone-200',
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-stone-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-base text-stone-800 placeholder:text-stone-400 focus:border-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-800/15 transition';

function Badge({ tone = 'stone', children }) {
  const tones = {
    gold: 'bg-amber-100 text-amber-900',
    green: 'bg-emerald-100 text-emerald-800',
    red: 'bg-rose-100 text-rose-800',
    blue: 'bg-sky-100 text-sky-800',
    stone: 'bg-stone-100 text-stone-600',
  };
  return <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function Card({ children, className = '' }) {
  return <div className={`tmr-card-shadow rounded-2xl border border-stone-200/80 bg-white ${className}`}>{children}</div>;
}

function Modal({ title, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-900/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-stone-100 bg-white px-5 py-4">
          <h3 className="text-base font-semibold text-stone-800">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 text-stone-400 hover:bg-stone-100" aria-label="סגור">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="sticky bottom-0 flex gap-2 border-t border-stone-100 bg-white px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-stone-900 px-4 py-2 text-sm text-white shadow-lg">
      {message}
    </div>
  );
}

/* ============================== צד לקוח ================================ */

function CustomerView({ settings, onSubmitOrder, onGoAdmin }) {
  const [step, setStep] = useState('form'); // 'form' | 'confirmation'
  const [lastOrder, setLastOrder] = useState(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', area: '', qty: 1, notes: '', paymentMethod: 'cash' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sale, setSale] = useState(null);
  const [saleLoading, setSaleLoading] = useState(true);
  const [saleLoadError, setSaleLoadError] = useState('');

  // המכירה הפתוחה מגיעה ישירות מ-Supabase (get_open_sale), לא מ-window.storage.
  // זה מקור מבודד לגמרי מהצד הציבורי - לא נוגע ב-app.salesById/db.getSale
  // שממשיכים לשרת את אזור הניהול בדיוק כפי שהיה.
  useEffect(() => {
    let active = true;
    getOpenSale()
      .then((data) => {
        if (active) setSale(data);
      })
      .catch((err) => {
        console.error('getOpenSale failed', err);
        if (active) setSaleLoadError('אירעה שגיאה בטעינת המכירה. נסו לרענן את הדף.');
      })
      .finally(() => {
        if (active) setSaleLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const activePrices = sale?.prices || settings.defaultPrices;
  const amount = calcAmount(activePrices, form.qty);
  // stock_remaining כבר מחושב בצד השרת בתוך get_open_sale() - אין יותר
  // תלות בהזמנות (getOrders) בצד הציבורי בשביל בדיקת המלאי.
  const stockRemaining = sale?.stockEnabled ? sale.stockRemaining : null;
  const soldOut = sale?.stockEnabled && stockRemaining <= 0;
  const deadlinePassed = isDeadlinePassed(sale);
  const saleOpen = isSaleAcceptingOrders(sale) && !soldOut;
  const paymentLink = form.paymentMethod === 'bit' ? settings.bitLink : form.paymentMethod === 'paybox' ? settings.payboxLink : null;

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function updatePhone(rawValue) {
    // ספרות בלבד, עד 10 תווים — חוסם אותיות/רווחים/מקפים כבר בזמן ההקלדה
    const digitsOnly = rawValue.replace(/\D/g, '').slice(0, 10);
    update('phone', digitsOnly);
  }

  const PHONE_RE = /^05\d{8}$/;

  function updateQty(rawValue) {
    if (rawValue === '') {
      update('qty', '');
      return;
    }
    const n = Math.floor(Number(rawValue));
    if (!Number.isFinite(n)) return;
    update('qty', Math.max(1, n));
  }

  function validate() {
    if (!form.firstName.trim() || !form.lastName.trim()) return 'נא למלא שם פרטי ושם משפחה';
    if (!PHONE_RE.test(form.phone)) return 'מספר טלפון לא תקין. יש להזין 10 ספרות שמתחילות ב-05, לדוגמה 0501234567';
    if (!Number.isInteger(Number(form.qty)) || Number(form.qty) < 1) return 'נא להזין כמות תקינה (1 ומעלה)';
    return '';
  }

  async function doSubmit({ markPaid = false, openPaymentAfter = false } = {}) {
    if (submitting) return; // מונע הזמנה כפולה בלחיצה כפולה/מהירה
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const order = await onSubmitOrder({ ...form, amount, markPaid, sale });
      setLastOrder(order);
      setStep('confirmation');
      if (openPaymentAfter && paymentLink) {
        window.open(paymentLink, '_blank', 'noreferrer');
      }
    } catch (err2) {
      console.error('order submit failed', err2);
      if (err2 && err2.message === 'SALE_CLOSED') {
        setError('המכירה נסגרה להזמנות (המועד האחרון להזמנה עבר). לא ניתן לשלוח את ההזמנה.');
      } else {
        setError('אירעה שגיאה בשליחת ההזמנה. נסו שוב, ואם זה חוזר על עצמו אפשר לפנות אלינו בטלפון.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    await doSubmit({ markPaid: false });
  }

  // Bit/PayBox: לחיצה על כפתור התשלום שולחת את ההזמנה אוטומטית ומסמנת
  // אותה כ"שולם" (דיווח הלקוח, לא אימות טכני), ואז פותחת את קישור התשלום
  // ישירות בלשונית/חלון חדש - בלי ליצור about:blank ולנווט אליו בנפרד.
  async function handlePayAndSubmit() {
    if (submitting) return;
    await doSubmit({ markPaid: true, openPaymentAfter: true });
  }

  if (step === 'confirmation' && lastOrder) {
    const link = lastOrder.paymentMethod === 'bit' ? settings.bitLink : lastOrder.paymentMethod === 'paybox' ? settings.payboxLink : null;
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <Card className="p-7 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-700">✓</div>
          <h2 className="tmr-display text-2xl">ההזמנה התקבלה בהצלחה!</h2>
          <div className="mt-6 space-y-2.5 rounded-xl border border-stone-100 bg-amber-50/70 p-4 text-right text-sm text-stone-700">
            <div className="flex justify-between"><span className="text-stone-500">מספר הזמנה</span><span className="font-medium">{lastOrder.orderNumber}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">שם</span><span className="font-medium">{lastOrder.firstName} {lastOrder.lastName}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">כמות</span><span className="font-medium">{lastOrder.qty} אריזות</span></div>
            <div className="flex justify-between"><span className="text-stone-500">סה״כ לתשלום</span><span className="font-semibold text-amber-900">{fmtCurrency(lastOrder.amount)}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">אמצעי תשלום</span><span className="font-medium">{PAYMENT_METHODS.find((m) => m.v === lastOrder.paymentMethod)?.label}</span></div>
          </div>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="mt-4 block">
              <Button className="w-full">תשלום ב-{PAYMENT_METHODS.find((m) => m.v === lastOrder.paymentMethod)?.label}</Button>
            </a>
          )}
          <p className="mt-4 text-xs leading-relaxed text-stone-400">
            לאחר ביצוע התשלום, אין צורך לשלוח אישור. ההזמנה תסומן כ״שולם״ לאחר שהתשלום יאומת.
          </p>
          <div className="mt-5 flex flex-col gap-2 border-t border-stone-100 pt-5">
            <Button
              variant="secondary"
              onClick={() => {
                setForm({ firstName: '', lastName: '', phone: '', area: '', qty: 1, notes: '', paymentMethod: 'cash' });
                setLastOrder(null);
                setStep('form');
              }}
            >
              ביצוע הזמנה נוספת
            </Button>
            <button onClick={onGoAdmin} className="text-xs text-stone-300 hover:text-stone-400">
              כניסה לניהול
            </button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 pb-16">
      <div className="mt-6 rounded-2xl bg-gradient-to-b from-amber-900 to-amber-800 px-6 py-10 text-center text-amber-50">
        <h1 className="tmr-display text-4xl leading-tight">תמרים טריים להזמנה</h1>
        <p className="mt-3 text-sm leading-relaxed text-amber-100/90">{settings.customerIntro}</p>
        {sale && <p className="mt-4 inline-block rounded-full bg-amber-950/30 px-3 py-1 text-xs font-medium text-amber-100">{sale.name}</p>}
        {sale && sale.deadline && sale.status === 'open' && !deadlinePassed && (
          <p className="mt-2 text-xs text-amber-200">ניתן להזמין עד {fmtDeadline(sale.deadline)}</p>
        )}
      </div>

      {saleLoading ? (
        <Spinner />
      ) : saleLoadError ? (
        <Card className="mt-6 p-6 text-center text-rose-700">{saleLoadError}</Card>
      ) : (
        <>
          {!sale && (
            <Card className="mt-6 p-6 text-center text-stone-500">
              אין כרגע מכירת תמרים פתוחה. אפשר לחזור בקרוב למועד המכירה הבא.
              {settings.phone && <div className="mt-2 text-sm">לשאלות: {settings.phone}</div>}
            </Card>
          )}

          {sale && sale.status !== 'open' && !deadlinePassed && (
            <Card className="mt-6 p-6 text-center text-stone-500">המכירה הנוכחית נסגרה להזמנות. תודה לכל מי שהזמין!</Card>
          )}

          {sale && deadlinePassed && (
            <Card className="mt-6 p-6 text-center text-stone-500">
              המועד האחרון להזמנה ({fmtDeadline(sale.deadline)}) עבר, והמכירה נסגרה. תודה לכל מי שהזמין!
            </Card>
          )}

          {sale && sale.status === 'open' && !deadlinePassed && soldOut && (
            <Card className="mt-6 p-6 text-center text-stone-500">המכירה אזלה — כל האריזות נמכרו. תודה על העניין!</Card>
          )}

          {saleOpen && (
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <Card className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="שם פרטי">
                <input className={inputCls} value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
              </Field>
              <Field label="שם משפחה">
                <input className={inputCls} value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
              </Field>
            </div>
            <Field label="טלפון">
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={10}
                className={inputCls}
                value={form.phone}
                onChange={(e) => updatePhone(e.target.value)}
                placeholder="0501234567"
              />
            </Field>
            <Field label="אזור / יישוב (אופציונלי)">
              <input className={inputCls} value={form.area} onChange={(e) => update('area', e.target.value)} />
            </Field>

            <Field label="כמות קופסאות" hint={`${fmtCurrency(ratePerUnitForQty(activePrices, form.qty || 1))} לקופסה בכמות הזו`}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => updateQty(Math.max(1, Number(form.qty || 1) - 1))}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-stone-300 bg-white text-xl font-semibold text-stone-600 hover:border-amber-800"
                  aria-label="הפחת כמות"
                >
                  −
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={form.qty}
                  onChange={(e) => updateQty(e.target.value)}
                  className={`${inputCls} text-center text-lg font-semibold`}
                />
                <button
                  type="button"
                  onClick={() => updateQty(Number(form.qty || 0) + 1)}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-stone-300 bg-white text-xl font-semibold text-stone-600 hover:border-amber-800"
                  aria-label="הוסף כמות"
                >
                  +
                </button>
              </div>
            </Field>

            <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
              <span className="text-sm text-stone-600">{form.qty || 0} קופסאות</span>
              <span className="text-right">
                <span className="block text-[11px] font-medium text-stone-500">סה״כ לתשלום</span>
                <span className="text-2xl font-bold text-amber-900">{fmtCurrency(amount)}</span>
              </span>
            </div>

            <Field label="הערות / בקשות מיוחדות (אופציונלי)">
              <textarea className={inputCls} rows={2} value={form.notes} onChange={(e) => update('notes', e.target.value)} />
            </Field>

            <Field label="אמצעי תשלום">
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    type="button"
                    key={m.v}
                    onClick={() => update('paymentMethod', m.v)}
                    className={`rounded-xl border py-3 text-sm font-semibold transition ${
                      form.paymentMethod === m.v ? 'border-amber-900 bg-amber-900 text-amber-50' : 'border-stone-300 bg-white text-stone-600 hover:border-amber-800'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>

            {(form.paymentMethod === 'bit' || form.paymentMethod === 'paybox') && (
              <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
                {paymentLink ? (
                  <>
                    <p className="text-sm font-medium leading-relaxed text-amber-900">
                      לחיצה על הכפתור תשלח את ההזמנה ותפתח את עמוד התשלום. הסימון כ"שולם" מבוסס על הדיווח שלכם ולא על אימות טכני מול {form.paymentMethod === 'bit' ? 'Bit' : 'PayBox'}.
                    </p>
                    <Button type="button" variant="secondary" className="w-full" disabled={submitting} onClick={handlePayAndSubmit}>
                      {submitting ? 'שולח…' : `לתשלום ב-${form.paymentMethod === 'bit' ? 'Bit' : 'PayBox'}`}
                    </Button>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-amber-800">
                    קישור תשלום ל{form.paymentMethod === 'bit' ? 'Bit' : 'PayBox'} עדיין לא הוגדר. אפשר לשלוח את ההזמנה ולסכם תשלום בנפרד
                    {settings.phone ? ` (${settings.phone})` : ''}.
                  </p>
                )}
              </div>
            )}

            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
            {!((form.paymentMethod === 'bit' || form.paymentMethod === 'paybox') && paymentLink) && (
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'שולח הזמנה…' : 'שלח הזמנה'}
              </Button>
            )}
          </Card>
        </form>
          )}
        </>
      )}

      <button onClick={onGoAdmin} className="mx-auto mt-10 block text-xs text-stone-300 hover:text-stone-400">
        כניסה לניהול
      </button>
    </div>
  );
}

/* ============================ שער כניסה למנהל ============================ */

function AdminGate({ onBack }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        setError('אימייל או סיסמה שגויים. נסו שוב.');
      }
      // בהצלחה: מאזין ה-onAuthStateChange באפליקציה יקלוט את ה-session
      // ויעביר אוטומטית למסך הניהול - אין צורך לנווט כאן.
    } catch (err) {
      console.error('login failed', err);
      setError('אירעה שגיאה בהתחברות. נסו שוב.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <Card className="w-full p-6">
        <h2 className="tmr-display text-xl font-bold text-stone-800">כניסה לניהול</h2>
        <form onSubmit={handleLogin} className="mt-5 space-y-4 text-right">
          <Field label="אימייל">
            <input
              type="email"
              required
              autoComplete="username"
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="סיסמה">
            <input
              type="password"
              required
              autoComplete="current-password"
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'מתחבר…' : 'כניסה'}
          </Button>
        </form>
        <Button variant="ghost" className="mt-2 w-full" onClick={onBack}>
          חזרה לאתר הלקוחות
        </Button>
      </Card>
    </div>
  );
}

/* ============================ טאבים לניהול ============================ */

const ADMIN_TABS = [
  { v: 'dashboard', label: 'סיכום' },
  { v: 'orders', label: 'הזמנות' },
  { v: 'history', label: 'היסטוריה' },
  { v: 'sales', label: 'ניהול מכירה' },
  { v: 'settings', label: 'הגדרות' },
];

function AdminView({ app }) {
  const [tab, setTab] = useState('dashboard');
  const [ordersFilterPreset, setOrdersFilterPreset] = useState(null);

  function goOrders(preset) {
    setOrdersFilterPreset(preset || null);
    setTab('orders');
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16">
      <div className="flex items-center justify-between py-4">
        <h1 className="tmr-display text-lg font-bold text-stone-800">ניהול מכירת תמרים</h1>
        <button onClick={app.exitAdmin} className="text-xs text-stone-400 hover:text-stone-600">
          יציאה לאתר הלקוחות
        </button>
      </div>

      <div className="tmr-scrollbar mb-6 flex gap-2 overflow-x-auto border-b border-stone-200 pb-px">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition ${
              tab === t.v ? 'border-amber-900 text-amber-900' : 'border-transparent text-stone-400 hover:text-stone-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardTab app={app} goOrders={goOrders} />}
      {tab === 'orders' && <OrdersTab app={app} saleId={app.currentSaleId} initialPreset={ordersFilterPreset} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'sales' && <SalesManagementTab app={app} />}
      {tab === 'settings' && <SettingsTab app={app} />}
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-stone-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-stone-800">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-stone-400">{sub}</div>}
    </Card>
  );
}

function DashboardTab({ app, goOrders }) {
  const sale = app.currentSaleId ? app.salesById[app.currentSaleId] : null;
  const orders = app.currentSaleId ? app.ordersBySaleId[app.currentSaleId] || [] : [];

  const stats = useMemo(() => {
    const active = orders.filter((o) => o.orderStatus !== 'cancelled');
    const packages = active.reduce((s, o) => s + Number(o.qty || 0), 0);
    const revenue = active.reduce((s, o) => s + Number(o.amount || 0), 0);
    const paid = active.filter((o) => o.paymentStatus === 'paid').reduce((s, o) => s + Number(o.amount || 0), 0);
    const pendingOrders = active.filter((o) => o.paymentStatus !== 'paid');
    const pendingPickup = active.filter((o) => o.orderStatus === 'pending_pickup');
    const delivered = active.filter((o) => o.orderStatus === 'delivered');
    return { count: active.length, packages, revenue, paid, pending: revenue - paid, pendingCount: pendingOrders.length, pendingPickupCount: pendingPickup.length, deliveredCount: delivered.length };
  }, [orders]);

  const stockRemaining = sale ? computeStockRemaining(sale, orders) : null;

  if (!sale) {
    return (
      <Card className="p-6 text-center text-stone-500">
        אין כרגע מכירה פתוחה. אפשר לפתוח מכירה חדשה בעמוד ההגדרות.
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-stone-800">{sale.name}</h2>
        <p className="text-xs text-stone-400">
          נפתחה {fmtDate(sale.openDate)} · <Badge tone={sale.status === 'open' ? 'green' : 'stone'}>{sale.status === 'open' ? 'פתוחה' : 'סגורה'}</Badge>
          {sale.deadline && ` · דדליין הזמנות: ${fmtDeadline(sale.deadline)}`}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="הזמנות" value={stats.count} />
        <StatCard label="אריזות" value={stats.packages} />
        <StatCard label="הכנסה צפויה" value={fmtCurrency(stats.revenue)} />
        <StatCard label="שולם" value={fmtCurrency(stats.paid)} />
        <StatCard label="ממתין לתשלום" value={fmtCurrency(stats.pending)} sub={`${stats.pendingCount} הזמנות`} />
        <StatCard label="ממתינים לאיסוף" value={stats.pendingPickupCount} />
        <StatCard label="נמסרו" value={stats.deliveredCount} />
        {sale.stockEnabled && <StatCard label="אריזות במלאי" value={stockRemaining} sub={`מתוך ${sale.stockTotal}`} />}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => goOrders('unpaid')}>
          מי עדיין לא שילם ({stats.pendingCount})
        </Button>
        <Button variant="secondary" onClick={() => goOrders('pending_pickup')}>
          ממתינים לאיסוף ({stats.pendingPickupCount})
        </Button>
        <Button variant="secondary" onClick={() => goOrders(null)}>
          כל ההזמנות
        </Button>
        <Button variant="subtle" onClick={() => exportSaleReport(sale, orders)}>
          הורדת דוח (Excel)
        </Button>
      </div>
    </div>
  );
}

/* ---- הזמנות (טבלת/רשימת הזמנות + חיפוש + סינון) ---- */

function OrdersTab({ app, saleId, initialPreset, readOnlyBanner }) {
  const [query, setQuery] = useState('');
  const [paymentFilter, setPaymentFilter] = useState(initialPreset === 'unpaid' ? 'pending' : 'all');
  const [statusFilter, setStatusFilter] = useState(initialPreset === 'pending_pickup' ? 'pending_pickup' : 'all');
  const [methodFilter, setMethodFilter] = useState('all');
  const [openOrderId, setOpenOrderId] = useState(null);
  const [loadingOrders, setLoadingOrders] = useState(false);

  const sale = saleId ? app.salesById[saleId] : null;
  const orders = saleId ? app.ordersBySaleId[saleId] || [] : [];

  useEffect(() => {
    if (saleId && !app.loadedSaleIds.has(saleId)) {
      setLoadingOrders(true);
      app.loadOrdersForSale(saleId).then(() => setLoadingOrders(false));
    }
  }, [saleId]);

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (paymentFilter !== 'all' && o.paymentStatus !== paymentFilter) return false;
      if (statusFilter !== 'all' && o.orderStatus !== statusFilter) return false;
      if (methodFilter !== 'all' && o.paymentMethod !== methodFilter) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const hay = `${o.firstName} ${o.lastName} ${o.phone} ${o.orderNumber}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, query, paymentFilter, statusFilter, methodFilter]);

  async function markAllPaid() {
    if (!confirm('לסמן את כל ההזמנות המוצגות כ״שולם״?')) return;
    await app.bulkUpdateOrders(
      saleId,
      filtered.map((o) => o.id),
      { paymentStatus: 'paid' }
    );
  }

  if (!sale) {
    return <Card className="p-6 text-center text-stone-500">אין מכירה להצגה.</Card>;
  }

  return (
    <div className="space-y-4">
      {readOnlyBanner}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="חיפוש לפי שם, טלפון או מספר הזמנה"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={`${inputCls} w-auto`} value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
          <option value="all">כל הסטטוסים (תשלום)</option>
          <option value="pending">ממתין לתשלום</option>
          <option value="paid">שולם</option>
        </select>
        <select className={`${inputCls} w-auto`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">כל הסטטוסים (הזמנה)</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s.v} value={s.v}>{s.label}</option>
          ))}
        </select>
        <select className={`${inputCls} w-auto`} value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
          <option value="all">כל אמצעי התשלום</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m.v} value={m.v}>{m.label}</option>
          ))}
        </select>
        <div className="mr-auto flex gap-2">
          <Button variant="subtle" onClick={markAllPaid} disabled={filtered.length === 0}>
            סמן הכל כשולם
          </Button>
          <Button variant="subtle" onClick={() => exportOrdersToCSV(sale, filtered)} disabled={filtered.length === 0}>
            ייצוא CSV
          </Button>
          <Button variant="subtle" onClick={() => exportSaleReport(sale, orders)}>
            הורדת דוח (Excel)
          </Button>
        </div>
      </div>

      {loadingOrders ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <Card className="p-6 text-center text-stone-400">אין הזמנות שתואמות לסינון.</Card>
      ) : (
        <div className="space-y-2">
          {filtered
            .slice()
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map((o) => (
              <div
                key={o.id}
                onClick={() => setOpenOrderId(o.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setOpenOrderId(o.id); }}
                className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-4 text-right transition hover:border-amber-800"
              >
                <div>
                  <div className="text-sm font-medium text-stone-800">
                    {o.firstName} {o.lastName} <span className="text-stone-300">·</span> <span className="text-stone-400">{o.orderNumber}</span>
                  </div>
                  <div className="mt-1 text-xs text-stone-400">{o.phone} · {o.qty} אריזות · {fmtDate(o.createdAt)}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="text-sm font-semibold text-stone-800">{fmtCurrency(o.amount)}</span>
                  <div className="flex gap-1">
                    <Badge tone={o.paymentStatus === 'paid' ? 'green' : 'red'}>{paymentStatusDisplay(o)}</Badge>
                    <Badge tone={orderStatusMeta(o.orderStatus).tone}>{orderStatusMeta(o.orderStatus).label}</Badge>
                  </div>
                  {o.orderStatus === 'pending_pickup' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        app.updateOrder(saleId, o.id, { orderStatus: 'delivered' });
                      }}
                      className="mt-0.5 rounded-lg bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-emerald-50 hover:bg-emerald-800"
                    >
                      ✓ נמסרה
                    </button>
                  )}
                  {o.paymentStatus !== 'paid' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        app.updateOrder(saleId, o.id, { paymentStatus: 'paid' });
                      }}
                      className="mt-0.5 rounded-lg bg-amber-900 px-2.5 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-800"
                    >
                      ✓ סומן כשולם
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {openOrderId && (
        <OrderDetailModal
          app={app}
          saleId={saleId}
          order={orders.find((o) => o.id === openOrderId)}
          onClose={() => setOpenOrderId(null)}
        />
      )}
    </div>
  );
}

function OrderDetailModal({ app, saleId, order, onClose }) {
  const [form, setForm] = useState(order);
  const [saving, setSaving] = useState(false);
  if (!order) return null;

  const settings = app.settings;
  const pricesForOrder = order.pricingSnapshot || settings.defaultPrices;
  const wa = waLinkForOrder(order, settings);
  const [customerInfo, setCustomerInfo] = useState(null);

  useEffect(() => {
    let active = true;
    adminGetCustomer(order.phone).then((c) => {
      if (active) setCustomerInfo(c);
    });
    return () => {
      active = false;
    };
  }, [order.phone]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function updateQty(rawValue) {
    const n = Math.floor(Number(rawValue));
    const qty = Number.isFinite(n) && n >= 1 ? n : 1;
    setForm((f) => ({ ...f, qty, amount: calcAmount(pricesForOrder, qty) }));
  }

  async function handleSave() {
    setSaving(true);
    await app.updateOrder(saleId, order.id, form);
    setSaving(false);
    onClose();
  }

  async function handleCancelOrder() {
    if (!confirm('לבטל את ההזמנה הזו?')) return;
    await app.updateOrder(saleId, order.id, { ...form, orderStatus: 'cancelled' });
    onClose();
  }

  return (
    <Modal
      title={`הזמנה ${order.orderNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button className="flex-1" onClick={handleSave} disabled={saving}>
            {saving ? 'שומר…' : 'שמירה'}
          </Button>
          <Button variant="ghost" onClick={onClose}>ביטול חלון</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="שם פרטי">
            <input className={inputCls} value={form.firstName} onChange={(e) => update('firstName', e.target.value)} />
          </Field>
          <Field label="שם משפחה">
            <input className={inputCls} value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
          </Field>
        </div>
        <Field label="טלפון">
          <input className={inputCls} value={form.phone} onChange={(e) => update('phone', e.target.value)} />
        </Field>
        <Field label="אזור">
          <input className={inputCls} value={form.area || ''} onChange={(e) => update('area', e.target.value)} />
        </Field>

        {customerInfo && customerInfo.totalOrders > 1 && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            לקוח חוזר — הזמין {customerInfo.totalOrders} פעמים בעבר, סה״כ {customerInfo.totalPackages} אריזות.
          </div>
        )}

        <Field label="כמות קופסאות">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => updateQty(Math.max(1, Number(form.qty || 1) - 1))}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-lg font-semibold text-stone-600"
              aria-label="הפחת כמות"
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={form.qty}
              onChange={(e) => updateQty(e.target.value)}
              className={`${inputCls} text-center`}
            />
            <button
              type="button"
              onClick={() => updateQty(Number(form.qty || 0) + 1)}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-lg font-semibold text-stone-600"
              aria-label="הוסף כמות"
            >
              +
            </button>
          </div>
          <div className="mt-2 text-sm text-stone-500">סכום מחושב: <span className="font-semibold text-amber-900">{fmtCurrency(form.amount)}</span></div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="אמצעי תשלום">
            <select className={inputCls} value={form.paymentMethod} onChange={(e) => update('paymentMethod', e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.v} value={m.v}>{m.label}</option>
              ))}
            </select>
          </Field>
          <Field label="סטטוס תשלום">
            <select className={inputCls} value={form.paymentStatus} onChange={(e) => update('paymentStatus', e.target.value)}>
              <option value="pending">ממתין לתשלום</option>
              <option value="paid">שולם</option>
            </select>
          </Field>
        </div>

        <Field label="סטטוס הזמנה">
          <select className={inputCls} value={form.orderStatus} onChange={(e) => update('orderStatus', e.target.value)}>
            {ORDER_STATUSES.map((s) => (
              <option key={s.v} value={s.v}>{s.label}</option>
            ))}
          </select>
        </Field>

        {form.notes && (
          <Field label="הערות הלקוח">
            <div className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600">{form.notes}</div>
          </Field>
        )}

        <Field label="הערה פנימית (למנהל בלבד)">
          <textarea className={inputCls} rows={2} value={form.internalNote || ''} onChange={(e) => update('internalNote', e.target.value)} />
        </Field>

        <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
          {wa && (
            <a href={wa} target="_blank" rel="noreferrer">
              <Button variant="secondary">WhatsApp ללקוח</Button>
            </a>
          )}
          <Button variant="danger" onClick={handleCancelOrder}>ביטול הזמנה</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---- היסטוריית מכירות ---- */

function HistoryTab({ app }) {
  const [rows, setRows] = useState(null);
  const [drillSaleId, setDrillSaleId] = useState(null);

  useEffect(() => {
    (async () => {
      const list = [];
      for (const id of app.salesIndex) {
        const sale = app.salesById[id];
        const orders = app.loadedSaleIds.has(id) ? app.ordersBySaleId[id] : (await app.loadOrdersForSale(id));
        const active = (orders || []).filter((o) => o.orderStatus !== 'cancelled');
        list.push({
          id,
          sale,
          count: active.length,
          packages: active.reduce((s, o) => s + Number(o.qty || 0), 0),
          revenue: active.reduce((s, o) => s + Number(o.amount || 0), 0),
          paid: active.filter((o) => o.paymentStatus === 'paid').reduce((s, o) => s + Number(o.amount || 0), 0),
        });
      }
      setRows(list);
    })();
  }, [app.salesIndex]);

  if (drillSaleId) {
    return (
      <OrdersTab
        app={app}
        saleId={drillSaleId}
        readOnlyBanner={
          <Button variant="ghost" onClick={() => setDrillSaleId(null)}>
            ← חזרה להיסטוריה
          </Button>
        }
      />
    );
  }

  if (!rows) return <Spinner />;
  if (rows.length === 0) return <Card className="p-6 text-center text-stone-400">עדיין אין מכירות בהיסטוריה.</Card>;

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => setDrillSaleId(r.id)}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-4 text-right hover:border-amber-800"
        >
          <div>
            <div className="text-sm font-medium text-stone-800">{r.sale?.name}</div>
            <div className="mt-1 text-xs text-stone-400">
              {r.count} הזמנות · {r.packages} אריזות · <Badge tone={r.sale?.status === 'open' ? 'green' : 'stone'}>{r.sale?.status === 'open' ? 'פתוחה' : 'סגורה'}</Badge>
            </div>
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold text-stone-800">{fmtCurrency(r.revenue)}</div>
            <div className="text-xs text-stone-400">שולם {fmtCurrency(r.paid)}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

/* ---- הגדרות ---- */

function SalesManagementTab({ app }) {
  const [newSaleError, setNewSaleError] = useState('');

  function defaultDeadlineDate() {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function freshNewSaleForm() {
    return {
      name: suggestedSaleName(),
      stockEnabled: false,
      stockTotal: 100,
      closeCurrent: true,
      deadlineDate: defaultDeadlineDate(),
      deadlineTime: '20:00',
      sourcePricesId: null,
      sourceLabel: '',
    };
  }

  const [newSale, setNewSale] = useState(freshNewSaleForm);
  const [otherSales, setOtherSales] = useState([]);
  const [otherSalesError, setOtherSalesError] = useState('');

  // רשימת "שכפול מכירה קודמת" נטענת ישירות מ-Supabase, במבודד לגמרי -
  // לא נוגעת ב-app.salesIndex/app.salesById (עדיין מוזנים מ-window.storage
  // ומשמשים את "מכירה נוכחית" ואת שאר האתר בדיוק כפי שהיה עד עכשיו).
  useEffect(() => {
    let active = true;
    adminListSales()
      .then((data) => {
        if (active) setOtherSales(data);
      })
      .catch((err) => {
        console.error('adminListSales failed', err);
        if (active) setOtherSalesError('שגיאה בטעינת רשימת המכירות מ-Supabase: ' + (err?.message || 'שגיאה לא ידועה'));
      });
    return () => {
      active = false;
    };
  }, []);

  const currentSale = app.currentSaleId ? app.salesById[app.currentSaleId] : null;

  async function handleOpenSale() {
    if (!newSale.name.trim()) return;
    if (!newSale.deadlineDate || !newSale.deadlineTime) {
      setNewSaleError('יש להגדיר דדליין להזמנות (תאריך ושעה) לפני פתיחת המכירה');
      return;
    }
    const deadline = new Date(`${newSale.deadlineDate}T${newSale.deadlineTime}`);
    if (Number.isNaN(deadline.getTime())) {
      setNewSaleError('תאריך/שעה לא תקינים');
      return;
    }
    setNewSaleError('');
    const sourcePrices = newSale.sourcePricesId ? otherSales.find((s) => s.id === newSale.sourcePricesId)?.prices : null;
    await app.createSale({
      name: newSale.name.trim(),
      stockEnabled: newSale.stockEnabled,
      stockTotal: Number(newSale.stockTotal) || 0,
      closeCurrent: newSale.closeCurrent,
      prices: sourcePrices || undefined,
      deadline: deadline.toISOString(),
    });
    setNewSale(freshNewSaleForm());
  }

  async function handleCloseSale() {
    if (!currentSale) return;
    if (!confirm(`לסגור את "${currentSale.name}" להזמנות חדשות?`)) return;
    await app.closeSale(currentSale.id);
  }

  function handleDuplicate(sourceId) {
    const source = otherSales.find((s) => s.id === sourceId);
    if (!source) return;
    // ממלא מראש שם + מלאי + מחירים מהמכירה שנבחרה; הדדליין תמיד נקבע מחדש
    // בטופס למטה - זו החלטה חדשה שצריך לקבל לכל מכירה, לא משהו שמשכפלים.
    setNewSale((s) => ({
      ...s,
      name: suggestedSaleName(),
      stockEnabled: source.stockEnabled,
      stockTotal: source.stockTotal,
      sourcePricesId: sourceId,
      sourceLabel: source.name,
    }));
    setNewSaleError('');
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-stone-800">מכירה נוכחית</h3>
        {currentSale ? (
          <div className="mt-3 space-y-3 rounded-lg bg-amber-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-stone-800">{currentSale.name}</div>
                <div className="text-xs text-stone-400">
                  נפתחה {fmtDate(currentSale.openDate)}
                  {currentSale.deadline && ` · דדליין הזמנות: ${fmtDeadline(currentSale.deadline)}`}
                </div>
              </div>
              <Button variant="secondary" onClick={handleCloseSale}>סגירת מכירה</Button>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-amber-200/60 pt-3">
              <Button variant="subtle" onClick={() => exportSaleReport(currentSale, app.ordersBySaleId[currentSale.id] || [])}>
                הורדת דוח (Excel)
              </Button>
              {DEMO_MODE && (
                <Button variant="ghost" onClick={() => app.debugForceDeadlinePassed(currentSale.id)}>
                  🧪 בדיקה: הזז דדליין לעבר
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-stone-400">אין כרגע מכירה פתוחה.</p>
        )}

        <div className="mt-5 space-y-3 border-t border-stone-100 pt-4">
          <h4 className="text-sm font-medium text-stone-700">פתיחת מכירה חדשה</h4>
          {newSale.sourceLabel && (
            <p className="rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600">
              מולאו שם, מלאי ומחירים מתוך "{newSale.sourceLabel}". נשאר רק להגדיר דדליין וללחוץ "פתיחת מכירה חדשה".
            </p>
          )}
          <Field label="שם המכירה">
            <input className={inputCls} value={newSale.name} onChange={(e) => setNewSale((s) => ({ ...s, name: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="דדליין הזמנות - תאריך">
              <input type="date" className={inputCls} value={newSale.deadlineDate} onChange={(e) => setNewSale((s) => ({ ...s, deadlineDate: e.target.value }))} />
            </Field>
            <Field label="דדליין הזמנות - שעה">
              <input type="time" className={inputCls} value={newSale.deadlineTime} onChange={(e) => setNewSale((s) => ({ ...s, deadlineTime: e.target.value }))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" checked={newSale.stockEnabled} onChange={(e) => setNewSale((s) => ({ ...s, stockEnabled: e.target.checked }))} />
            הגבלת מלאי אריזות
          </label>
          {newSale.stockEnabled && (
            <Field label="כמות אריזות זמינה">
              <input type="number" className={inputCls} value={newSale.stockTotal} onChange={(e) => setNewSale((s) => ({ ...s, stockTotal: e.target.value }))} />
            </Field>
          )}
          {currentSale && (
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" checked={newSale.closeCurrent} onChange={(e) => setNewSale((s) => ({ ...s, closeCurrent: e.target.checked }))} />
              סגור את המכירה הנוכחית אוטומטית
            </label>
          )}
          {newSaleError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{newSaleError}</p>}
          <Button onClick={handleOpenSale}>פתיחת מכירה חדשה</Button>

          {otherSalesError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{otherSalesError}</p>}
          {otherSales.length > 0 && (
            <div className="pt-2">
              <span className="text-xs text-stone-400">או שכפול הגדרות ממכירה קודמת (מחירים + מלאי בלבד, ללא הזמנות, דדליין תמיד נקבע מחדש):</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {otherSales.map((s) => (
                  <Button key={s.id} variant="subtle" onClick={() => handleDuplicate(s.id)}>
                    שכפל את "{s.name}"
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function SettingsTab({ app }) {
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [saved, setSaved] = useState(false);

  // טעינה מבודדת ל-Admin בלבד, ישירות מ-Supabase. לא נוגעת ב-app.settings
  // (עדיין מוזן מ-db.getSettings()/window.storage ומשמש את הצד הציבורי
  // בדיוק כפי שהיה עד עכשיו).
  useEffect(() => {
    let active = true;
    adminGetSettings()
      .then((data) => {
        if (active) setForm(data);
      })
      .catch((err) => {
        console.error('adminGetSettings failed', err);
        if (active) setLoadError('שגיאה בטעינת ההגדרות מ-Supabase: ' + (err?.message || 'שגיאה לא ידועה'));
      });
    return () => {
      active = false;
    };
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function updateTier(index, field, value) {
    setForm((f) => {
      const tiers = f.defaultPrices.tiers.map((t, i) => (i === index ? { ...t, [field]: Number(value) || 0 } : t));
      return { ...f, defaultPrices: { ...f.defaultPrices, tiers } };
    });
  }

  function addPriceTier() {
    setForm((f) => {
      const tiers = f.defaultPrices.tiers;
      const lastMin = tiers.length ? Math.max(...tiers.map((t) => t.minQty)) : 0;
      return { ...f, defaultPrices: { ...f.defaultPrices, tiers: [...tiers, { minQty: lastMin + 1, pricePerUnit: 0 }] } };
    });
  }

  function removePriceTier(index) {
    setForm((f) => {
      if (f.defaultPrices.tiers.length <= 1) return f;
      const tiers = f.defaultPrices.tiers.filter((_, i) => i !== index);
      return { ...f, defaultPrices: { ...f.defaultPrices, tiers } };
    });
  }

  async function handleSaveSettings() {
    await app.saveSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (loadError) {
    return <Card className="p-6 text-center text-rose-700">{loadError}</Card>;
  }
  if (!form) {
    return <Spinner />;
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold text-stone-800">פרטי מוכר</h3>
        <Field label="שם המוכר">
          <input className={inputCls} value={form.sellerName} onChange={(e) => update('sellerName', e.target.value)} />
        </Field>
        <Field label="טלפון">
          <input className={inputCls} value={form.phone} onChange={(e) => update('phone', e.target.value)} />
        </Field>
        <Field label="טקסט פתיחה ללקוחות">
          <textarea className={inputCls} rows={2} value={form.customerIntro} onChange={(e) => update('customerIntro', e.target.value)} />
        </Field>
        <Field label="פרטי איסוף / חלוקה">
          <textarea className={inputCls} rows={2} value={form.pickupInfo} onChange={(e) => update('pickupInfo', e.target.value)} />
        </Field>
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-semibold text-stone-800">קישורי תשלום</h3>
        <Field label="קישור Bit" hint="אם ריק, כפתור Bit לא יוצג ללקוח">
          <input className={inputCls} value={form.bitLink} onChange={(e) => update('bitLink', e.target.value)} placeholder="https://..." />
        </Field>
        <Field label="קישור PayBox" hint="אם ריק, כפתור PayBox לא יוצג ללקוח">
          <input className={inputCls} value={form.payboxLink} onChange={(e) => update('payboxLink', e.target.value)} placeholder="https://..." />
        </Field>
      </Card>

      <Card className="space-y-3 p-5">
        <h3 className="text-sm font-semibold text-stone-800">תמחור ברירת מחדל (מדורג)</h3>
        <p className="text-xs text-stone-400">
          התמחור הזה ייקבע למכירה הבאה שתיפתח בלבד. לכל מכירה יש עותק קבוע משלה בזמן הפתיחה, כך ששינוי כאן לא משנה מכירות
          שכבר קיימות. כל מדרגה קובעת מחיר ליחידה החל מכמות מסוימת ומעלה.
        </p>
        {form.defaultPrices.tiers.map((tier, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="shrink-0 text-sm text-stone-600">החל מ-</span>
            <input
              type="number"
              min={1}
              className={inputCls}
              value={tier.minQty}
              onChange={(e) => updateTier(i, 'minQty', e.target.value)}
            />
            <span className="shrink-0 text-sm text-stone-600">קופסאות →</span>
            <input
              type="number"
              className={inputCls}
              value={tier.pricePerUnit}
              onChange={(e) => updateTier(i, 'pricePerUnit', e.target.value)}
            />
            <span className="shrink-0 text-sm text-stone-400">₪ ליחידה</span>
            <button
              type="button"
              onClick={() => removePriceTier(i)}
              disabled={form.defaultPrices.tiers.length <= 1}
              className="shrink-0 rounded-lg px-2 py-1 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-30"
              aria-label="הסרת מדרגה"
            >
              הסר
            </button>
          </div>
        ))}
        <Button variant="subtle" onClick={addPriceTier}>הוספת מדרגת כמות</Button>
        <div className="rounded-lg bg-stone-50 p-3 text-xs text-stone-500">
          לדוגמה עם ההגדרות הנוכחיות: 1 = {fmtCurrency(calcAmount(form.defaultPrices, 1))} · 4 = {fmtCurrency(calcAmount(form.defaultPrices, 4))} · 10 = {fmtCurrency(calcAmount(form.defaultPrices, 10))}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSaveSettings}>שמירת הגדרות</Button>
        {saved && <span className="text-sm text-emerald-700">נשמר ✓</span>}
      </div>
    </div>
  );
}


/* ============================================================================
   ██  DEMO DATA — בלוק בדיקה בלבד  ██
   ----------------------------------------------------------------------------
   כל מה שבין השורה הזו לבין סימון END DEMO DATA למטה הוא לצורך בדיקת האתר
   עם נתונים לדוגמה בלבד, לפני חיבור Supabase. שמות/טלפונים פיקטיביים לגמרי.

   לכיבוי מצב הדגמה: להפוך את DEMO_MODE ל-false (שורה הבאה).
   להסרה מוחלטת בעתיד: למחוק את כל הבלוק הזה (עד סימון END DEMO DATA), ואת שורת
   הקריאה היחידה ל-seedDemoData() בתוך App (מסומנת שם באותו תג DEMO_MODE).
   שום קובץ אחר לא נוגע בבלוק הזה — הנתונים כתובים באותו מבנה בדיוק
   (settings / sale / customers / orders) שהמערכת האמיתית משתמשת בו, ונכתבים
   דרך אותן פונקציות db.* בדיוק, כך שהבדיקה משקפת נאמנה את ההתנהגות האמיתית.
   ============================================================================ */

const DEMO_MODE = true;

function daysAgo(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 15, 0, 0);
  return d.toISOString();
}

function daysFromNow(n, hour = 20) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const DEMO_SALE_ID = 'demo-sale-2026-09';
const DEMO_PRICES = { tiers: [{ minQty: 1, pricePerUnit: 40 }, { minQty: 4, pricePerUnit: 35 }] };

const DEMO_SETTINGS = {
  sellerName: 'משק התמרים של אבא (דמו)',
  phone: '050-0000000',
  bitLink: 'https://bit.ly/demo-bit-link',
  payboxLink: 'https://paybox.co.il/demo-link',
  defaultPrices: { ...DEMO_PRICES },
  customerIntro: 'תמרים טריים, ישר מהמשק. זהו נתוני דמו לבדיקת האתר בלבד.',
  pickupInfo: 'איסוף עצמי בימי חמישי בין 17:00–19:00 (כתובת לדוגמה).',
};

const DEMO_SALE = {
  id: DEMO_SALE_ID,
  name: 'מכירת תמרים – ספטמבר 2026 (דמו)',
  openDate: daysAgo(9),
  closeDate: null,
  status: 'open',
  stockEnabled: true,
  stockTotal: 60,
  prices: { ...DEMO_PRICES },
  orderSeq: 14,
  deadline: daysFromNow(5), // עוד 5 ימים מהיום, כדי שאפשר לבדוק "לפני הדדליין" כרגע
};

// שם + טלפון פיקטיביים לגמרי, לצורך בדיקה בלבד
const DEMO_ORDERS_RAW = [
  { n: 1, first: 'יוסי', last: 'כהן', phone: '050-1000001', area: 'מודיעין', qty: 2, method: 'cash', paid: true, status: 'delivered', day: 8 },
  { n: 2, first: 'רותי', last: 'לוי', phone: '050-1000002', area: 'רעננה', qty: 1, method: 'bit', paid: true, status: 'pending_pickup', day: 8 },
  { n: 3, first: 'דוד', last: 'מזרחי', phone: '050-1000003', area: 'חולון', qty: 4, method: 'paybox', paid: false, status: 'pending_pickup', day: 7 },
  { n: 4, first: 'מאיה', last: 'ברק', phone: '050-1000004', area: 'כפר סבא', qty: 3, method: 'cash', paid: true, status: 'pending_pickup', day: 6 },
  { n: 5, first: 'שרה', last: 'אברהם', phone: '050-1000005', area: '', qty: 1, method: 'other', paid: false, status: 'pending_pickup', day: 6 },
  { n: 6, first: 'יוסי', last: 'כהן', phone: '050-1000001', area: 'מודיעין', qty: 1, method: 'bit', paid: true, status: 'delivered', day: 5, notes: 'הזמנה חוזרת, תודה!' },
  { n: 7, first: 'אורית', last: 'שלום', phone: '050-1000007', area: 'הרצליה', qty: 2, method: 'cash', paid: false, status: 'pending_pickup', day: 5 },
  { n: 8, first: 'אבי', last: 'פרץ', phone: '050-1000008', area: 'ראשון לציון', qty: 4, method: 'paybox', paid: true, status: 'pending_pickup', day: 4 },
  { n: 9, first: 'נועה', last: 'גולן', phone: '050-1000009', area: 'פתח תקווה', qty: 2, method: 'bit', paid: false, status: 'pending_pickup', day: 4 },
  { n: 10, first: 'רותי', last: 'לוי', phone: '050-1000002', area: 'רעננה', qty: 3, method: 'cash', paid: true, status: 'delivered', day: 3 },
  { n: 11, first: 'אלי', last: 'דגן', phone: '050-1000011', area: 'נתניה', qty: 1, method: 'cash', paid: false, status: 'cancelled', day: 3, notes: 'ביטל טלפונית' },
  { n: 12, first: 'גלית', last: 'נחום', phone: '050-1000012', area: '', qty: 3, method: 'other', paid: false, status: 'pending_pickup', day: 2 },
  { n: 13, first: 'עידו', last: 'שגיא', phone: '050-1000013', area: 'רמת גן', qty: 2, method: 'paybox', paid: true, status: 'pending_pickup', day: 1 },
  { n: 14, first: 'טל', last: 'ארז', phone: '050-1000014', area: 'גבעתיים', qty: 1, method: 'bit', paid: false, status: 'pending_pickup', day: 0 },
];

function buildDemoOrders() {
  return DEMO_ORDERS_RAW.map((o) => ({
    id: `demo_ord_${o.n}`,
    orderNumber: `#${String(o.n).padStart(3, '0')}`,
    saleId: DEMO_SALE_ID,
    createdAt: daysAgo(o.day),
    firstName: o.first,
    lastName: o.last,
    phone: o.phone,
    area: o.area,
    qty: o.qty,
    amount: calcAmount(DEMO_PRICES, o.qty),
    pricingSnapshot: { ...DEMO_PRICES },
    paymentMethod: o.method,
    paymentStatus: o.paid ? 'paid' : 'pending',
    orderStatus: o.status,
    notes: o.notes || '',
    internalNote: '',
  }));
}

function buildDemoCustomers() {
  const map = {};
  for (const o of DEMO_ORDERS_RAW) {
    if (!map[o.phone]) {
      map[o.phone] = { phone: o.phone, firstName: o.first, lastName: o.last, area: o.area, totalOrders: 0, totalPackages: 0 };
    }
    map[o.phone].totalOrders += 1;
    map[o.phone].totalPackages += o.qty;
    map[o.phone].firstName = o.first;
    map[o.phone].lastName = o.last;
  }
  return Object.values(map);
}

// נכתב דרך אותן פונקציות db.* בדיוק שהאפליקציה האמיתית משתמשת בהן —
// כך שה"בדיקה" עוברת דרך אותה שכבת נתונים שתחליף אחר כך ל-Supabase.
async function seedDemoData() {
  await db.saveSettings(DEMO_SETTINGS);
  await db.saveSaleIds([DEMO_SALE_ID]);
  await db.saveSale(DEMO_SALE);
  await db.saveOrders(DEMO_SALE_ID, buildDemoOrders());
  for (const c of buildDemoCustomers()) {
    await db.saveCustomer(c);
  }
}

function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    <div className="bg-amber-900 py-1.5 text-center text-xs font-medium text-amber-50">
      🧪 מצב הדגמה — כל הנתונים כאן פיקטיביים לצורך בדיקה, ולא נשמרים לצמיתות
    </div>
  );
}

/* END DEMO DATA */

/* ================================ App =================================== */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [salesIndex, setSalesIndex] = useState([]);
  const [salesById, setSalesById] = useState({});
  const [ordersBySaleId, setOrdersBySaleId] = useState({});
  const [loadedSaleIds, setLoadedSaleIds] = useState(() => new Set());
  const [currentSaleId, setCurrentSaleId] = useState(null);
  const [view, setView] = useState('customer'); // 'customer' | 'admin-gate' | 'admin'
  const [toast, setToast] = useState('');
  const [session, setSession] = useState(null); // Supabase Auth session - null = not logged in

  function notify(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  // מעקב Session אמיתי אחרי Supabase Auth - Effect נפרד ובלתי-תלוי לגמרי
  // מה-Effect שטוען את נתוני האתר הציבורי (DEMO_MODE/window.storage) למטה,
  // כדי שכשל כלשהו כאן לעולם לא יחסום את טעינת האתר הציבורי. session הוא
  // מקור האמת היחיד לגישת ניהול - לא view - כי view הוא רק ניווט UI.
  useEffect(() => {
    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session);
      })
      .catch((err) => {
        console.error('auth getSession failed', err);
      });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (active) setSession(newSession);
    });
    return () => {
      active = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  // מעבר אוטומטי למסך הניהול ברגע שיש session תקין (אחרי login מוצלח)
  useEffect(() => {
    if (session && view === 'admin-gate') {
      setView('admin');
    }
  }, [session, view]);

  useEffect(() => {
    (async () => {
      if (DEMO_MODE) {
        // זריעה חד-פעמית בלבד: אם כבר יש settings שמורים, סימן שכבר זרענו
        // בעבר - לא דורסים שוב, כדי שהזמנות/שינויים שנוצרו במהלך הבדיקה
        // (כולל אחרי reload) לא יימחקו. זריעה אמיתית קורית רק בפעם הראשונה.
        const alreadySeeded = await db.getSettings();
        if (!alreadySeeded) {
          await seedDemoData();
        }
      }
      let s = await db.getSettings();
      if (!s) {
        s = DEFAULT_SETTINGS;
        await db.saveSettings(s);
      }
      const index = await db.listSaleIds();
      const byId = {};
      for (const id of index) {
        const sale = await db.getSale(id);
        if (sale) byId[id] = sale;
      }

      // סגירת מכירות שעבר הדדליין שלהן — נבדק "on demand" בטעינה בלבד
      // (אין תזמון רקע אמיתי). זה משתמש באותו שדה status הקיים, לא במנגנון
      // מקביל. אחרי חיבור Supabase, זו תהיה עבודה טבעית ל-Cron/Edge Function.
      for (const id of index) {
        const sale = byId[id];
        if (sale && sale.status === 'open' && isDeadlinePassed(sale)) {
          const closed = { ...sale, status: 'closed', closeDate: sale.deadline };
          byId[id] = closed;
          await db.saveSale(closed);
        }
      }

      const openId = index.find((id) => byId[id]?.status === 'open') || null;
      const ordersMap = {};
      if (openId) ordersMap[openId] = await db.getOrders(openId);

      // עדיפות למכירה אמיתית מ-Supabase, אם קיימת - בלי לגעת ברזולוציה
      // הקיימת מ-window.storage/DEMO שלמעלה, שממשיכה לשמש כברירת מחדל/
      // fallback אם אין מכירה פתוחה אמיתית ב-Supabase או שהבדיקה נכשלה.
      let finalOpenId = openId;
      let finalById = byId;
      let finalOrdersMap = ordersMap;
      try {
        const supabaseSales = await adminListSales();
        const openSupabaseSale = supabaseSales.find((sale) => sale.status === 'open');
        if (openSupabaseSale) {
          finalOpenId = openSupabaseSale.id;
          finalById = { ...byId, [openSupabaseSale.id]: openSupabaseSale };
          finalOrdersMap = { ...ordersMap, [openSupabaseSale.id]: await adminGetOrders(openSupabaseSale.id) };
        }
      } catch (err) {
        console.warn('adminListSales check failed, staying with window.storage sale', err);
      }

      setSettings(s);
      setSalesIndex(index);
      setSalesById(finalById);
      setCurrentSaleId(finalOpenId);
      setOrdersBySaleId(finalOrdersMap);
      setLoadedSaleIds(new Set(finalOpenId ? [finalOpenId] : []));
      setLoading(false);
    })();
  }, []);

  const loadOrdersForSale = useCallback(async (saleId) => {
    const orders = await adminGetOrders(saleId);
    setOrdersBySaleId((m) => ({ ...m, [saleId]: orders }));
    setLoadedSaleIds((s) => new Set(s).add(saleId));
    return orders;
  }, []);

  // הצד הציבורי: יצירת הזמנה עוברת עכשיו דרך create_order() ב-Supabase
  // (RPC), לא דרך window.storage. sale מגיע מה-formData (נטען ב-CustomerView
  // עצמו דרך get_open_sale()) - לא מ-salesById/currentSaleId המשותפים, כדי
  // לא לערבב בין המכירה האמיתית (Supabase) לבין הצד שעדיין משמש את Admin.
  const submitOrder = useCallback(async (formData) => {
    const sale = formData.sale;
    // בדיקה סמכותית מקומית, לא רק תצוגתית: גם אם הטאב נשאר פתוח מעבר
    // לדדליין, השליחה בפועל תמיד נבדקת מחדש כאן ברגע הלחיצה. הבדיקה
    // הסופית והאמיתית היא בכל זאת בתוך create_order() עצמה בשרת.
    if (!isSaleAcceptingOrders(sale)) {
      throw new Error('SALE_CLOSED');
    }
    const order = await createOrder({
      saleId: sale.id,
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      phone: formData.phone.trim(),
      area: formData.area?.trim() || '',
      qty: Number(formData.qty),
      notes: formData.notes?.trim() || '',
      paymentMethod: formData.paymentMethod,
      markPaid: !!formData.markPaid,
    });
    // מסך האישור הקיים צריך firstName/lastName/qty בנוסף למה שה-RPC מחזיר
    // (id/orderNumber/amount/paymentMethod) - אלה כבר ידועים מקומית מהטופס,
    // אין צורך שה-RPC יחזיר אותם בחזרה.
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      amount: order.amount,
      paymentMethod: order.paymentMethod,
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      qty: Number(formData.qty),
    };
  }, []);

  const updateOrder = useCallback(
    async (saleId, orderId, patch) => {
      const orders = ordersBySaleId[saleId] || (await loadOrdersForSale(saleId));
      const next = orders.map((o) => (o.id === orderId ? { ...o, ...patch } : o));
      await adminUpdateOrder(orderId, patch);
      setOrdersBySaleId((m) => ({ ...m, [saleId]: next }));
      notify('ההזמנה עודכנה');
    },
    [ordersBySaleId, loadOrdersForSale]
  );

  const bulkUpdateOrders = useCallback(
    async (saleId, orderIds, patch) => {
      const orders = ordersBySaleId[saleId] || (await loadOrdersForSale(saleId));
      const idSet = new Set(orderIds);
      const next = orders.map((o) => (idSet.has(o.id) ? { ...o, ...patch } : o));
      await adminBulkUpdateOrders(orderIds, patch);
      setOrdersBySaleId((m) => ({ ...m, [saleId]: next }));
      notify('ההזמנות עודכנו');
    },
    [ordersBySaleId, loadOrdersForSale]
  );

  const saveSettings = useCallback(async (newSettings) => {
    await db.saveSettings(newSettings);
    setSettings(newSettings);
  }, []);

  const createSale = useCallback(
    async ({ name, stockEnabled, stockTotal, closeCurrent, prices, deadline }) => {
      if (closeCurrent && currentSaleId && salesById[currentSaleId]) {
        const closed = { ...salesById[currentSaleId], status: 'closed' };
        await db.saveSale(closed);
        setSalesById((m) => ({ ...m, [closed.id]: closed }));
      }
      // עותק קבוע של המחירים בזמן פתיחת המכירה - זו הפעולה המקבילה ל-
      // "sale.prices := settings.default_prices" שכבר קיימת בפועל בתוך
      // admin_create_sale() בצד השרת.
      const finalPrices = prices ? { ...prices } : { ...settings.defaultPrices };
      // היצירה עצמה עוברת דרך ה-RPC של Supabase - ה-id האמיתי (uuid) מגיע
      // בחזרה מהשרת, לא נוצר יותר מקומית עם uid('sale_').
      const sale = await adminCreateSale({
        name,
        deadline: deadline || null,
        prices: finalPrices,
        stockEnabled: !!stockEnabled,
        stockTotal: Number(stockTotal) || 0,
        closeCurrent: !!closeCurrent,
      });
      const nextIndex = [sale.id, ...salesIndex];
      setSalesIndex(nextIndex);
      setSalesById((m) => ({ ...m, [sale.id]: sale }));
      setCurrentSaleId(sale.id);
      notify('המכירה נפתחה');
    },
    [currentSaleId, salesById, salesIndex, settings]
  );

  const closeSale = useCallback(
    async (saleId) => {
      const sale = { ...salesById[saleId], status: 'closed', closeDate: new Date().toISOString() };
      await adminCloseSale(saleId);
      setSalesById((m) => ({ ...m, [saleId]: sale }));
      if (saleId === currentSaleId) setCurrentSaleId(null);
      notify('המכירה נסגרה');
    },
    [salesById, currentSaleId]
  );

  // כלי בדיקה למצב DEMO בלבד: דוחף את הדדליין של מכירה לדקה אחת בעבר,
  // כדי שאפשר לבדוק בפועל שהזמנה נחסמת בלי לחכות לזמן אמיתי.
  // הסטטוס נשאר 'open' בכוונה, כדי לדמות בדיוק את הרגע שבו הדדליין עבר
  // אבל אף אחד עדיין לא טען מחדש את הדף (שם הבדיקה 'on demand' רצה).
  const debugForceDeadlinePassed = useCallback(
    async (saleId) => {
      if (!DEMO_MODE) return;
      const sale = { ...salesById[saleId], deadline: new Date(Date.now() - 60000).toISOString() };
      await db.saveSale(sale);
      setSalesById((m) => ({ ...m, [saleId]: sale }));
      notify('הדדליין הוזז לעבר (לבדיקה בלבד)');
    },
    [salesById]
  );

  const app = {
    settings,
    salesIndex,
    salesById,
    ordersBySaleId,
    loadedSaleIds,
    currentSaleId,
    loadOrdersForSale,
    updateOrder,
    bulkUpdateOrders,
    saveSettings,
    createSale,
    closeSale,
    debugForceDeadlinePassed,
    exitAdmin: async () => {
      try {
        await supabase.auth.signOut();
      } catch (err) {
        console.error('sign out failed', err);
      }
      setView('customer');
    },
  };

  return (
    <div dir="rtl" lang="he" className="tmr-root min-h-screen bg-amber-50">
      <GlobalStyle />
      <DemoBanner />
      {loading ? (
        <Spinner />
      ) : view === 'customer' ? (
        <CustomerView
          settings={settings}
          onSubmitOrder={submitOrder}
          onGoAdmin={() => setView('admin-gate')}
        />
      ) : view === 'admin' && session ? (
        <AdminView app={app} />
      ) : (
        // גם view === 'admin-gate', וגם מקרה קצה שבו view === 'admin' אבל
        // אין session תקין (למשל אחרי logout ממקום אחר) - תמיד חזרה למסך
        // התחברות אמיתי, לא לתצוגת הניהול.
        <AdminGate onBack={() => setView('customer')} />
      )}
      <Toast message={toast} />
    </div>
  );
}
