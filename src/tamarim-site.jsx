import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from './lib/supabaseClient';
import { adminGetSettings, adminListSales, adminCreateSale, adminGetOrders, adminGetCustomer, adminUpdateOrder, adminBulkUpdateOrders, adminCloseSale, adminSaveSettings, adminDeleteOrder } from './lib/adminApi';
import { getOpenSale, createOrder, getPublicSettings } from './lib/publicApi';

/* ========================= קבועים וברירות מחדל ========================= */

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

// "היום" כמחרוזת "YYYY-MM-DD" לפי השעון המקומי (לא UTC) - זה מה שהמשתמש
// עצמו נחשב אצלו "היום". עדיין בשימוש להצגת/התראת pickup_date (לא לקביעת
// מחזור החיים - ראו isSaleFullyHandled/getSaleLifecycleStage למטה).
function todayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// הזמנה נחשבת "מטופלת": בוטלה (cancelled - לא חוסמת בכלל), או שנמסרה
// וגם שולמה. מכירה בלי אף הזמנה נחשבת מטופלת במלואה (כלל "0 הזמנות").
function isSaleFullyHandled(orders) {
  const relevant = (orders || []).filter((o) => o.orderStatus !== 'cancelled');
  if (relevant.length === 0) return true;
  return relevant.every((o) => o.orderStatus === 'delivered' && o.paymentStatus === 'paid');
}

// שלב מחזור החיים של מכירה בממשק - "open" (עדיין status='open') /
// "ended" (נסגרה, אבל יש הזמנה אחת לפחות שלא טופלה) / "history" (נסגרה
// וכל ההזמנות טופלו, כולל מכירה בלי הזמנות בכלל). זהו מצב מחושב תמיד
// מהנתונים הנוכחיים (status + orders) - לא נשמר בשום מקום ב-DB, ולכן
// מתעדכן אוטומטית ברגע שסטטוס הזמנה משתנה. pickup_date אינו חלק מהחישוב
// הזה בכלל - הוא נשאר לשימוש בתצוגה/בהתראות הקיימות בלבד.
function getSaleLifecycleStage(sale, orders) {
  if (!sale) return null;
  if (sale.status === 'open') return 'open';
  return isSaleFullyHandled(orders) ? 'history' : 'ended';
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
  const text = 'היי, זה יובל מהתמרים. ההזמנה שלך מוכנה, אפשר להגיע לאסוף';
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
// וגיליון סיכום. sale/orders מגיעים מ-Supabase (adminListSales/adminGetOrders).
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
    ['תאריך איסוף', sale.pickupDate ? fmtDate(sale.pickupDate) : 'לא הוגדר'],
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

// שכבת העיצוב (בהשראת Apple): טיפוגרפיה, חומרים שקופים, צללים ותנועה.
// שמות המחלקות הקיימים (tmr-root / tmr-display / tmr-scrollbar /
// tmr-card-shadow) נשמרו, כך ששום רכיב שמשתמש בהם לא נשבר.
function GlobalStyle() {
  return (
    <style>{`
      /* פונטים: מערכת בלבד (בלי הטענה מהרשת). SF Pro באייפון/מק,
         Segoe UI בווינדוס, Roboto באנדרואיד - כולם עם כיסוי טוב לעברית. */
      .tmr-root, .tmr-root * {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Hebrew", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        box-sizing: border-box;
      }
      .tmr-root {
        color: #1D1D1F;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        -webkit-text-size-adjust: 100%;
        -webkit-tap-highlight-color: transparent;
        font-feature-settings: "kern";
      }
      .tmr-root ::selection { background: rgba(176, 125, 69, 0.22); }
      .tmr-root input, .tmr-root select, .tmr-root textarea, .tmr-root button { font-family: inherit; }
      .tmr-root button, .tmr-root [role="button"], .tmr-root a { touch-action: manipulation; }

      /* טיפוגרפיה: ריווח אותיות שלילי לכותרות גדולות, צפוף יותר ככל שהטקסט גדל */
      .tmr-display {
        font-weight: 700;
        letter-spacing: -0.022em;
        line-height: 1.08;
      }
      .tmr-title { font-weight: 600; letter-spacing: -0.012em; }
      .tmr-num { font-variant-numeric: tabular-nums; letter-spacing: -0.015em; }

      /* מיקוד מקלדת ברור, בלי טבעת מיותרת בלחיצת עכבר/מגע */
      .tmr-root :focus-visible { outline: 3px solid rgba(149, 101, 55, 0.45); outline-offset: 2px; }
      .tmr-root input:focus-visible, .tmr-root select:focus-visible, .tmr-root textarea:focus-visible { outline: none; }

      .tmr-scrollbar { scrollbar-width: none; }
      .tmr-scrollbar::-webkit-scrollbar { display: none; }

      /* משטחים: צל רך בשתי שכבות + קו מתאר עדין במקום מסגרת */
      .tmr-card-shadow {
        box-shadow:
          0 0 0 0.5px rgba(0, 0, 0, 0.06),
          0 1px 2px rgba(0, 0, 0, 0.04),
          0 10px 28px -14px rgba(0, 0, 0, 0.16);
      }
      .tmr-row {
        box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.07), 0 1px 2px rgba(0, 0, 0, 0.04);
        transition: transform 120ms ease-out, box-shadow 200ms ease-out;
      }
      @media (hover: hover) {
        .tmr-row:hover { box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 8px 24px -12px rgba(0, 0, 0, 0.18); }
      }
      .tmr-row:active { transform: scale(0.985); }

      /* תגובה מיידית בלחיצה (pointer-down), לא רק בשחרור */
      .tmr-press { transition: transform 100ms ease-out, background-color 150ms ease-out, box-shadow 150ms ease-out, opacity 150ms ease-out; }
      .tmr-press:not(:disabled):active { transform: scale(0.97); }

      /* חומר שקוף (Glass): לסרגל הניהול ולהודעות */
      .tmr-glass {
        background: rgba(245, 245, 247, 0.72);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
      }
      .tmr-glass-light {
        background: rgba(255, 255, 255, 0.78);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
      }
      .tmr-glass-dark {
        background: rgba(29, 29, 31, 0.86);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
      }
      .tmr-edge { box-shadow: 0 0.5px 0 rgba(0, 0, 0, 0.08); }

      /* כותרת הדף ללקוח: חום תמר עמוק עם הארה עדינה */
      .tmr-hero {
        background:
          radial-gradient(120% 90% at 50% 0%, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0) 60%),
          linear-gradient(180deg, #5A3A20 0%, #3F2816 100%);
        box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08) inset, 0 18px 40px -22px rgba(63, 40, 22, 0.65);
      }

      /* בקרה מפולחת (Segmented control) לטאבים של הניהול */
      .tmr-segment { background: rgba(118, 118, 128, 0.12); }
      .tmr-segment-active { background: #fff; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.12), 0 3px 1px rgba(0, 0, 0, 0.04); }

      /* חלונות קופצים: רקע מעומעם, גיליון שעולה מלמטה במובייל ומופיע במרכז במחשב */
      @keyframes tmr-scrim-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes tmr-sheet-in { from { transform: translateY(100%); } to { transform: translateY(0); } }
      @keyframes tmr-dialog-in {
        from { opacity: 0; transform: scale(0.96); filter: blur(4px); }
        to { opacity: 1; transform: scale(1); filter: blur(0); }
      }
      @keyframes tmr-toast-in {
        from { opacity: 0; transform: translateY(12px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes tmr-pop {
        0% { opacity: 0; transform: scale(0.6); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes tmr-fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .tmr-scrim { background: rgba(0, 0, 0, 0.32); animation: tmr-scrim-in 220ms ease-out both; }
      .tmr-sheet { animation: tmr-sheet-in 380ms cubic-bezier(0.32, 0.72, 0, 1) both; padding-bottom: env(safe-area-inset-bottom); }
      @media (min-width: 640px) {
        .tmr-sheet { animation: tmr-dialog-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both; padding-bottom: 0; }
      }
      .tmr-toast { animation: tmr-toast-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
      .tmr-pop { animation: tmr-pop 420ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
      .tmr-fade-up { animation: tmr-fade-up 360ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
      .tmr-safe-bottom { padding-bottom: max(1rem, env(safe-area-inset-bottom)); }

      @keyframes tmr-spin { to { transform: rotate(360deg); } }
      .tmr-spinner { animation: tmr-spin 0.8s linear infinite; }

      /* נגישות: פחות תנועה, פחות שקיפות, יותר ניגודיות - לפי הגדרות המכשיר */
      @media (prefers-reduced-motion: reduce) {
        .tmr-sheet, .tmr-toast, .tmr-pop, .tmr-fade-up { animation: tmr-scrim-in 180ms ease-out both !important; }
        .tmr-press:not(:disabled):active, .tmr-row:active { transform: none; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .tmr-glass { background: #F5F5F7; -webkit-backdrop-filter: none; backdrop-filter: none; }
        .tmr-glass-light { background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; }
        .tmr-glass-dark { background: #1D1D1F; -webkit-backdrop-filter: none; backdrop-filter: none; }
      }
      @media (prefers-contrast: more) {
        .tmr-card-shadow, .tmr-row { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35); }
        .tmr-glass, .tmr-glass-light { background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4); }
      }
    `}</style>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16" role="status" aria-label="טוען">
      <div className="tmr-spinner h-7 w-7 rounded-full border-[2.5px] border-stone-300 border-t-amber-700" />
    </div>
  );
}

function TrashIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6h17" />
      <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
      <path d="M18.5 6l-.8 13.1A2 2 0 0 1 15.7 21H8.3a2 2 0 0 1-2-1.9L5.5 6" />
      <path d="M10 10.5v6" />
      <path d="M14 10.5v6" />
    </svg>
  );
}

function Button({ children, variant = 'primary', className = '', ...props }) {
  const base =
    'tmr-press inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[14px] px-5 py-2.5 text-[15px] font-semibold tracking-[-0.01em] select-none disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none';
  const variants = {
    primary: 'bg-amber-900 text-white shadow-[0_1px_2px_rgba(0,0,0,0.12)] hover:bg-amber-800',
    secondary: 'bg-amber-900/[0.08] text-amber-900 hover:bg-amber-900/[0.13]',
    ghost: 'bg-transparent text-amber-800 hover:bg-stone-900/[0.05]',
    danger: 'bg-rose-600 text-white shadow-[0_1px_2px_rgba(0,0,0,0.12)] hover:bg-rose-700',
    tintedDanger: 'bg-rose-500/[0.1] text-rose-700 hover:bg-rose-500/[0.16]',
    subtle: 'bg-stone-900/[0.06] text-stone-800 hover:bg-stone-900/[0.1]',
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
      <span className="mb-1.5 block px-1 text-[13px] font-medium text-stone-500">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block px-1 text-xs text-stone-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-[12px] border border-stone-300/80 bg-white px-4 py-3 text-base text-stone-900 placeholder:text-stone-400 shadow-[0_1px_1px_rgba(0,0,0,0.02)] focus:border-amber-600 focus:outline-none focus:ring-4 focus:ring-amber-600/15 transition-[border-color,box-shadow] duration-150';

function Badge({ tone = 'stone', children }) {
  const tones = {
    gold: 'bg-amber-500/[0.14] text-amber-800',
    green: 'bg-emerald-500/[0.14] text-emerald-800',
    red: 'bg-rose-500/[0.12] text-rose-700',
    blue: 'bg-sky-500/[0.12] text-sky-800',
    stone: 'bg-stone-900/[0.06] text-stone-600',
  };
  return <span className={`inline-block rounded-full px-2.5 py-[3px] text-xs font-semibold tracking-[-0.005em] ${tones[tone]}`}>{children}</span>;
}

function Card({ children, className = '' }) {
  return <div className={`tmr-card-shadow rounded-[22px] bg-white ${className}`}>{children}</div>;
}

function Modal({ title, onClose, children, footer }) {
  // נועל את גלילת הדף מאחורי החלון (חשוב במיוחד באייפון), ומחזיר בסגירה.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="tmr-scrim fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="tmr-sheet flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[28px] bg-white shadow-[0_-8px_40px_rgba(0,0,0,0.18)] sm:max-w-lg sm:rounded-[28px] sm:shadow-[0_24px_80px_-12px_rgba(0,0,0,0.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tmr-glass-light tmr-edge relative z-10 shrink-0 px-5 pb-3 pt-2.5">
          <div className="mx-auto mb-2 h-[5px] w-9 rounded-full bg-stone-300 sm:hidden" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3">
            <h3 className="tmr-title text-[17px] text-stone-900">{title}</h3>
            <button
              onClick={onClose}
              className="tmr-press flex h-8 w-8 items-center justify-center rounded-full bg-stone-900/[0.07] text-[13px] font-bold text-stone-500 hover:bg-stone-900/[0.11]"
              aria-label="סגור"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
        {footer && <div className="tmr-glass-light relative z-10 flex shrink-0 gap-2 border-t border-stone-900/[0.06] px-5 pt-3 tmr-safe-bottom">{footer}</div>}
      </div>
    </div>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div
        key={message}
        role="status"
        aria-live="polite"
        className="tmr-toast tmr-glass-dark flex max-w-full items-center gap-2 rounded-full px-5 py-3 text-[15px] font-medium text-white shadow-[0_12px_32px_-8px_rgba(0,0,0,0.4)]"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-[11px]" aria-hidden="true">✓</span>
        {message}
      </div>
    </div>
  );
}

/* ============================== צד לקוח ================================ */

function CustomerView({ onSubmitOrder, onGoAdmin }) {
  const [step, setStep] = useState('form'); // 'form' | 'confirmation'
  const [lastOrder, setLastOrder] = useState(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', area: '', qty: 1, notes: '', paymentMethod: 'cash' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sale, setSale] = useState(null);
  const [saleLoading, setSaleLoading] = useState(true);
  const [saleLoadError, setSaleLoadError] = useState('');
  const [publicSettings, setPublicSettings] = useState(null);
  const [publicSettingsLoading, setPublicSettingsLoading] = useState(true);
  const [publicSettingsLoadError, setPublicSettingsLoadError] = useState('');

  // המכירה הפתוחה מגיעה ישירות מ-Supabase (get_open_sale). זה מקור מבודד
  // לגמרי מהצד הציבורי - לא נוגע ב-app.salesById ששרת רק את אזור הניהול.
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

  // הגדרות ציבוריות (טלפון, קישורי Bit/PayBox, טקסט פתיחה) מגיעות ישירות
  // מ-Supabase (get_public_settings). מבודד לגמרי, באותו דפוס בדיוק כמו
  // טעינת ה-sale למעלה. אין fallback בכוונה - עדיף להראות שגיאה מפורשת
  // מאשר הגדרות ישנות.
  useEffect(() => {
    let active = true;
    getPublicSettings()
      .then((data) => {
        if (active) setPublicSettings(data);
      })
      .catch((err) => {
        console.error('getPublicSettings failed', err);
        if (active) setPublicSettingsLoadError('אירעה שגיאה בטעינת ההגדרות. נסו לרענן את הדף.');
      })
      .finally(() => {
        if (active) setPublicSettingsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const activePrices = sale?.prices;
  const amount = calcAmount(activePrices, form.qty);
  // stock_remaining כבר מחושב בצד השרת בתוך get_open_sale() - אין יותר
  // תלות בהזמנות (getOrders) בצד הציבורי בשביל בדיקת המלאי.
  const stockRemaining = sale?.stockEnabled ? sale.stockRemaining : null;
  const soldOut = sale?.stockEnabled && stockRemaining <= 0;
  const deadlinePassed = isDeadlinePassed(sale);
  const saleOpen = isSaleAcceptingOrders(sale) && !soldOut;
  const paymentLink = form.paymentMethod === 'bit' ? publicSettings?.bitLink : form.paymentMethod === 'paybox' ? publicSettings?.payboxLink : null;

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

  async function doSubmit({ markPaid = false } = {}) {
    if (submitting) return false; // מונע הזמנה כפולה בלחיצה כפולה/מהירה
    const err = validate();
    if (err) {
      setError(err);
      return false;
    }
    setError('');
    setSubmitting(true);
    try {
      const order = await onSubmitOrder({ ...form, amount, markPaid, sale });
      setLastOrder(order);
      setStep('confirmation');
      return true;
    } catch (err2) {
      console.error('order submit failed', err2);
      if (err2 && err2.message === 'SALE_CLOSED') {
        setError('המכירה נסגרה להזמנות (המועד האחרון להזמנה עבר). לא ניתן לשלוח את ההזמנה.');
      } else {
        setError('אירעה שגיאה בשליחת ההזמנה. נסו שוב, ואם זה חוזר על עצמו אפשר לפנות אלינו בטלפון.');
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    await doSubmit({ markPaid: false });
  }

  // Bit/PayBox: ההזמנה נוצרת קודם (await), ורק בהצלחה מנווטים לקישור
  // התשלום - באותו חלון (window.location.href), לא בטאב/חלון חדש. ניווט
  // באותו חלון אינו כפוף לחסימת popup-blocker (זה לא window.open), ולכן
  // בטוח לבצע אותו אחרי await בלי סיכון שהוא ייחסם - וגם לא נוצר טאב
  // about:blank מיותר, כי אין יצירת חלון/טאב בכלל.
  async function handlePayAndSubmit() {
    if (submitting) return;
    const ok = await doSubmit({ markPaid: true });
    if (ok && paymentLink) {
      window.location.href = paymentLink;
    }
  }

  if (step === 'confirmation' && lastOrder) {
    const link = lastOrder.paymentMethod === 'bit' ? publicSettings?.bitLink : lastOrder.paymentMethod === 'paybox' ? publicSettings?.payboxLink : null;
    return (
      <div className="tmr-fade-up mx-auto max-w-md px-4 py-10">
        <Card className="p-7 text-center sm:p-8">
          <div className="tmr-pop mx-auto mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-emerald-500 text-4xl font-semibold text-white shadow-[0_10px_24px_-10px_rgba(48,177,82,0.7)]">✓</div>
          <h2 className="tmr-display text-[28px] text-stone-900">ההזמנה התקבלה בהצלחה!</h2>
          <div className="mt-6 space-y-3 rounded-[16px] bg-stone-50 p-4 text-right text-[15px] text-stone-800">
            <div className="flex justify-between"><span className="text-stone-500">מספר הזמנה</span><span className="font-medium">{lastOrder.orderNumber}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">שם</span><span className="font-medium">{lastOrder.firstName} {lastOrder.lastName}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">כמות</span><span className="font-medium">{lastOrder.qty} אריזות</span></div>
            <div className="flex justify-between"><span className="text-stone-500">סה״כ לתשלום</span><span className="tmr-num font-semibold text-amber-900">{fmtCurrency(lastOrder.amount)}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">אמצעי תשלום</span><span className="font-medium">{PAYMENT_METHODS.find((m) => m.v === lastOrder.paymentMethod)?.label}</span></div>
          </div>
          {link && (
            <a href={link} rel="noreferrer" className="mt-4 block">
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
      <div className="tmr-hero tmr-fade-up mt-4 rounded-[28px] px-6 pb-10 pt-12 text-center text-white sm:mt-8">
        <h1 className="tmr-display text-[34px] sm:text-[40px]">{publicSettings?.siteName || 'הזמנת תמרים - תמרולה'}</h1>
        <p className="mx-auto mt-3 max-w-xs text-[15px] leading-relaxed text-white/80">{publicSettings?.customerIntro}</p>
        {sale && <p className="mt-5 inline-block rounded-full bg-white/[0.14] px-3.5 py-1.5 text-[13px] font-semibold text-white ring-1 ring-inset ring-white/15">{sale.name}</p>}
        {sale && sale.deadline && sale.status === 'open' && !deadlinePassed && (
          <p className="mt-3 text-[13px] text-white/75">ניתן להזמין עד {fmtDeadline(sale.deadline)}</p>
        )}
        {sale && sale.pickupDate && <p className="mt-1 text-[13px] text-white/75">איסוף בתאריך {fmtDate(sale.pickupDate)}</p>}
      </div>

      {saleLoading || publicSettingsLoading ? (
        <Spinner />
      ) : saleLoadError || publicSettingsLoadError ? (
        <Card className="mt-6 p-6 text-center text-rose-700">{saleLoadError || publicSettingsLoadError}</Card>
      ) : (
        <>
          {!sale && (
            <Card className="mt-6 p-6 text-center text-stone-500">
              אין כרגע מכירת תמרים פתוחה. אפשר לחזור בקרוב למועד המכירה הבא.
              {publicSettings?.phone && <div className="mt-2 text-sm">לשאלות: {publicSettings.phone}</div>}
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
                  className="tmr-press flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-stone-900/[0.06] text-2xl font-medium text-stone-800 hover:bg-stone-900/[0.1]"
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
                  className={`${inputCls} tmr-num text-center text-lg font-semibold`}
                />
                <button
                  type="button"
                  onClick={() => updateQty(Number(form.qty || 0) + 1)}
                  className="tmr-press flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-stone-900/[0.06] text-2xl font-medium text-stone-800 hover:bg-stone-900/[0.1]"
                  aria-label="הוסף כמות"
                >
                  +
                </button>
              </div>
            </Field>

            <div className="flex items-center justify-between rounded-[16px] bg-amber-50 px-4 py-4 ring-1 ring-inset ring-amber-900/[0.08]">
              <span className="text-sm text-stone-600">{form.qty || 0} קופסאות</span>
              <span className="text-right">
                <span className="block text-[11px] font-medium text-stone-500">סה״כ לתשלום</span>
                <span className="tmr-num text-[28px] font-bold text-amber-900">{fmtCurrency(amount)}</span>
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
                    className={`tmr-press min-h-[48px] rounded-[14px] border py-3 text-[15px] font-semibold ${
                      form.paymentMethod === m.v ? 'border-amber-900 bg-amber-900 text-white shadow-[0_4px_12px_-4px_rgba(78,50,28,0.5)]' : 'border-stone-300/80 bg-white text-stone-700 hover:border-amber-600'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>

            {(form.paymentMethod === 'bit' || form.paymentMethod === 'paybox') && (
              <div className="space-y-3 rounded-[16px] bg-amber-50 p-4 ring-1 ring-inset ring-amber-900/10">
                {paymentLink ? (
                  <>
                    <p className="text-sm font-medium leading-relaxed text-amber-900">
                      {form.paymentMethod === 'bit' ? 'לחץ לשליחת ההזמנה ומעבר לתשלום בביט' : 'לחץ לשליחת ההזמנה ומעבר לתשלום ב-PayBox'}
                    </p>
                    <Button type="button" className="w-full" disabled={submitting} onClick={handlePayAndSubmit}>
                      {submitting ? 'שולח…' : `לתשלום ב-${form.paymentMethod === 'bit' ? 'Bit' : 'PayBox'}`}
                    </Button>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-amber-800">
                    קישור תשלום ל{form.paymentMethod === 'bit' ? 'Bit' : 'PayBox'} עדיין לא הוגדר. אפשר לשלוח את ההזמנה ולסכם תשלום בנפרד
                    {publicSettings?.phone ? ` (${publicSettings.phone})` : ''}.
                  </p>
                )}
              </div>
            )}

            {error && <p className="rounded-[12px] bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/10">{error}</p>}
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
      <Card className="tmr-fade-up w-full p-7">
        <h2 className="tmr-display text-[26px] text-stone-900">כניסה לניהול</h2>
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
          {error && <p className="rounded-[12px] bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/10">{error}</p>}
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

  // טוענים את רשימת המכירות הסגורות (ל"מכירות שהסתיימו"/היסטוריה) פעם
  // אחת בכניסה לאזור הניהול, ללא תלות באיזה טאב פתוח קודם - כך ש-Dashboard
  // ו-SalesManagementTab יוכלו להציג מיד את מי שדורש טיפול.
  useEffect(() => {
    app.loadClosedSales();
  }, []);

  function goOrders(preset) {
    setOrdersFilterPreset(preset || null);
    setTab('orders');
  }

  function goSales() {
    setTab('sales');
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16">
      <div className="tmr-glass tmr-edge sticky top-0 z-30 -mx-4 mb-6 px-4 pb-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-3 py-2">
          <h1 className="tmr-display text-[22px] text-stone-900">ניהול מכירת תמרים</h1>
          <button onClick={app.exitAdmin} className="tmr-press shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium text-amber-800 hover:bg-stone-900/[0.05]">
            יציאה לאתר הלקוחות
          </button>
        </div>

        <div className="tmr-scrollbar tmr-segment mt-1 flex gap-1 overflow-x-auto rounded-[12px] p-1">
          {ADMIN_TABS.map((t) => (
            <button
              key={t.v}
              onClick={() => setTab(t.v)}
              aria-pressed={tab === t.v}
              className={`tmr-press flex-1 whitespace-nowrap rounded-[9px] px-3.5 py-1.5 text-[13px] font-semibold ${
                tab === t.v ? 'tmr-segment-active text-stone-900' : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'dashboard' && <DashboardTab app={app} goOrders={goOrders} goSales={goSales} />}
      {tab === 'orders' && <OrdersTab app={app} saleId={app.currentSaleId} initialPreset={ordersFilterPreset} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'sales' && <SalesManagementTab app={app} />}
      {tab === 'settings' && <SettingsTab app={app} />}
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="text-[13px] font-medium text-stone-500">{label}</div>
      <div className="tmr-num mt-1 text-[26px] font-semibold text-stone-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-stone-400">{sub}</div>}
    </Card>
  );
}

function DashboardTab({ app, goOrders, goSales }) {
  const sale = app.currentSaleId ? app.salesById[app.currentSaleId] : null;
  const orders = app.currentSaleId ? app.ordersBySaleId[app.currentSaleId] || [] : [];

  // מכירות "שהסתיימו" (closed, אבל יש הזמנה שלא טופלה) - מוצג תמיד,
  // גם כשקיימת מכירה פתוחה וגם כשלא, כדי שלא "ייעלמו" מהמנהל. מחשבים
  // רק עבור מכירות שההזמנות שלהן כבר נטענו (app.loadedSaleIds) - כדי לא
  // לסווג מכירה בטעות לפני שההזמנות שלה בכלל הגיעו מ-Supabase.
  const endedSalesCount = useMemo(() => {
    return (app.closedSaleIds || []).filter((id) => {
      if (!app.loadedSaleIds.has(id)) return false;
      const s = app.salesById[id];
      return getSaleLifecycleStage(s, app.ordersBySaleId[id]) === 'ended';
    }).length;
  }, [app.closedSaleIds, app.salesById, app.ordersBySaleId, app.loadedSaleIds]);

  const endedSalesBanner = endedSalesCount > 0 && (
    <Card className="bg-amber-50 p-4 ring-1 ring-inset ring-amber-900/10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-amber-900">
          {endedSalesCount} מכירות שהסתיימו ועדיין דורשות טיפול
        </h3>
        <Button variant="secondary" onClick={goSales}>
          למעבר לטיפול
        </Button>
      </div>
    </Card>
  );

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

  // הזמנות שתאריך האיסוף של המכירה שלהן כבר הגיע/עבר, ועדיין לא סומנו
  // כנמסרו (pending_pickup). התראה מקומית בצד הלקוח בלבד - אין טבלה/RPC
  // חדשים, רק חישוב מהנתונים שכבר קיימים כאן (sale + orders).
  const overduePickupOrders = useMemo(() => {
    if (!sale || !sale.pickupDate) return [];
    if (sale.pickupDate > todayDateString()) return [];
    return orders.filter((o) => o.orderStatus === 'pending_pickup');
  }, [orders, sale]);

  const stockRemaining = sale ? computeStockRemaining(sale, orders) : null;

  if (!sale) {
    return (
      <div className="space-y-5">
        {endedSalesBanner}
        <Card className="p-6 text-center text-stone-500">
          אין כרגע מכירה פתוחה. אפשר לפתוח מכירה חדשה בעמוד ההגדרות.
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {endedSalesBanner}
      <div>
        <h2 className="tmr-title text-xl text-stone-900">{sale.name}</h2>
        <p className="text-xs text-stone-400">
          נפתחה {fmtDate(sale.openDate)} · <Badge tone={sale.status === 'open' ? 'green' : 'stone'}>{sale.status === 'open' ? 'פתוחה' : 'סגורה'}</Badge>
          {sale.deadline && ` · דדליין הזמנות: ${fmtDeadline(sale.deadline)}`}
          {` · תאריך איסוף: ${sale.pickupDate ? fmtDate(sale.pickupDate) : 'לא הוגדר'}`}
        </p>
      </div>

      {overduePickupOrders.length > 0 && (
        <Card className="bg-rose-50 p-4 ring-1 ring-inset ring-rose-600/15">
          <h3 className="text-sm font-semibold text-rose-800">
            הזמנות שתאריך האיסוף שלהן הגיע/עבר ועדיין לא נאספו ({overduePickupOrders.length})
          </h3>
          <ul className="mt-2 space-y-1">
            {overduePickupOrders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-white/80 px-3 py-2 text-sm text-rose-900">
                <span>
                  {o.orderNumber} · {o.firstName} {o.lastName}
                </span>
                <span className="text-xs text-rose-700">איסוף: {fmtDate(sale.pickupDate)} · טרם נאסף</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
  // מחיקה לצמיתות: עותק של ההזמנה שמחכה לאישור (null = אין חלון אישור פתוח)
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

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

  // מחיקה לצמיתות: חלון פרטי ההזמנה נסגר קודם, ורק אז נפתח חלון האישור
  // (עם עותק של פרטי ההזמנה). כך חלון הפרטים לעולם לא מנסה להציג הזמנה
  // שכבר הוסרה מהרשימה.
  function requestDeleteOrder(order) {
    setOpenOrderId(null);
    setDeleteError('');
    setDeleteTarget(order);
  }

  async function confirmDeleteOrder() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await app.deleteOrder(saleId, deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      console.error('deleteOrder failed', err);
      setDeleteError('המחיקה נכשלה וההזמנה לא נמחקה. נסו שוב בעוד רגע.');
    } finally {
      setDeleting(false);
    }
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
                className="tmr-row flex w-full cursor-pointer items-center justify-between gap-3 rounded-[18px] bg-white p-4 text-right"
              >
                <div>
                  <div className="text-[15px] font-semibold text-stone-900">
                    {o.firstName} {o.lastName} <span className="text-stone-300">·</span> <span className="text-stone-400">{o.orderNumber}</span>
                  </div>
                  <div className="mt-1 text-xs text-stone-400">{o.phone} · {o.qty} אריזות · {fmtDate(o.createdAt)}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="tmr-num text-[15px] font-semibold text-stone-900">{fmtCurrency(o.amount)}</span>
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
                      className="tmr-press mt-0.5 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
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
                      className="tmr-press mt-0.5 rounded-full bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
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
          onRequestDelete={requestDeleteOrder}
        />
      )}

      {deleteTarget && (
        <Modal
          title="מחיקת הזמנה לצמיתות"
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
          footer={
            <>
              <Button variant="subtle" className="flex-1" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                ביטול
              </Button>
              <Button variant="danger" className="flex-1" onClick={confirmDeleteOrder} disabled={deleting}>
                <TrashIcon />
                {deleting ? 'מוחק…' : 'מחק לצמיתות'}
              </Button>
            </>
          }
        >
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-500/[0.12] text-rose-600">
              <TrashIcon className="h-7 w-7" />
            </div>
            <div>
              <div className="tmr-title text-lg text-stone-900">
                {deleteTarget.firstName} {deleteTarget.lastName}
              </div>
              <div className="mt-0.5 text-sm text-stone-500">הזמנה {deleteTarget.orderNumber}</div>
            </div>
            <p className="rounded-[12px] bg-rose-50 px-3.5 py-3 text-right text-sm leading-relaxed text-rose-800 ring-1 ring-inset ring-rose-600/10">
              <strong className="font-semibold">פעולה זו אינה ניתנת לשחזור.</strong> ההזמנה תימחק לצמיתות ממסד הנתונים, ולא תופיע יותר
              ברשימות ההזמנות, בהיסטוריה ובדוחות. פרטי הלקוח עצמו לא יימחקו.
            </p>
            {deleteError && (
              <p className="rounded-[12px] bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/10">{deleteError}</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function OrderDetailModal({ app, saleId, order, onClose, onRequestDelete }) {
  const [form, setForm] = useState(order);
  const [saving, setSaving] = useState(false);
  if (!order) return null;

  const [customerInfo, setCustomerInfo] = useState(null);
  // הגדרות נטענות כאן ישירות מ-Supabase (adminGetSettings, אותה פונקציה
  // שכבר משמשת את SettingsTab).
  const [modalSettings, setModalSettings] = useState(null);

  useEffect(() => {
    let active = true;
    adminGetCustomer(order.phone).then((c) => {
      if (active) setCustomerInfo(c);
    });
    return () => {
      active = false;
    };
  }, [order.phone]);

  useEffect(() => {
    let active = true;
    adminGetSettings()
      .then((data) => {
        if (active) setModalSettings(data);
      })
      .catch((err) => {
        console.error('adminGetSettings failed in OrderDetailModal', err);
      });
    return () => {
      active = false;
    };
  }, []);

  // עד שההגדרות נטענות, pricesForOrder נשען רק על pricingSnapshot של ההזמנה
  // עצמה (שכמעט תמיד קיים בפועל) - אין חסימת UI/spinner בשביל זה, כי המודל
  // עדיין פונקציונלי לחלוטין בלעדיהן ברוב המקרים.
  const pricesForOrder = order.pricingSnapshot || modalSettings?.defaultPrices;
  const wa = modalSettings ? waLinkForOrder(order, modalSettings) : null;

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
          <div className="rounded-[12px] bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">
            לקוח חוזר — הזמין {customerInfo.totalOrders} פעמים בעבר, סה״כ {customerInfo.totalPackages} אריזות.
          </div>
        )}

        <Field label="כמות קופסאות">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => updateQty(Math.max(1, Number(form.qty || 1) - 1))}
              className="tmr-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-stone-900/[0.06] text-xl font-medium text-stone-800 hover:bg-stone-900/[0.1]"
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
              className={`${inputCls} tmr-num text-center`}
            />
            <button
              type="button"
              onClick={() => updateQty(Number(form.qty || 0) + 1)}
              className="tmr-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-stone-900/[0.06] text-xl font-medium text-stone-800 hover:bg-stone-900/[0.1]"
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
            <div className="rounded-[12px] bg-stone-50 p-3.5 text-sm text-stone-700">{form.notes}</div>
          </Field>
        )}

        <Field label="הערה פנימית (למנהל בלבד)">
          <textarea className={inputCls} rows={2} value={form.internalNote || ''} onChange={(e) => update('internalNote', e.target.value)} />
        </Field>

        <div className="space-y-3 border-t border-stone-900/[0.06] pt-4">
          {wa && (
            <a href={wa} target="_blank" rel="noreferrer" className="block">
              <Button variant="secondary" className="w-full">WhatsApp ללקוח</Button>
            </a>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Button variant="tintedDanger" className="w-full" onClick={handleCancelOrder}>ביטול הזמנה</Button>
              <p className="mt-1.5 px-1 text-xs leading-relaxed text-stone-400">ההזמנה נשארת במערכת בסטטוס "בוטלה".</p>
            </div>
            {onRequestDelete && (
              <div>
                <Button variant="danger" className="w-full" onClick={() => onRequestDelete(order)}>
                  <TrashIcon />
                  מחיקה לצמיתות
                </Button>
                <p className="mt-1.5 px-1 text-xs leading-relaxed text-stone-400">ההזמנה תוסר לגמרי ממסד הנתונים.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ---- היסטוריית מכירות ---- */

function HistoryTab({ app }) {
  const [rows, setRows] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [drillSaleId, setDrillSaleId] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // כל ההיסטוריה, לא רק 4 האחרונות (זה ה-limit שמיועד לבורר "שכפול
        // מכירה קודמת" ב-SalesManagementTab בלבד).
        const sales = await adminListSales({ limit: null });

        // ממזגים את כל המכירות ההיסטוריות ל-cache המשותף (app.salesById) -
        // כך ש-OrdersTab (drill-down) ימצא את המכירה הנכונה בדיוק כמו היום,
        // בלי שום שינוי ב-OrdersTab עצמו.
        app.setSalesById((m) => {
          const merged = { ...m };
          for (const sale of sales) merged[sale.id] = sale;
          return merged;
        });

        // מכירה נחשבת "היסטורית" רק אם היא closed וכל ההזמנות שלה טופלו
        // (getSaleLifecycleStage) - לא לפי pickup_date יותר. בניגוד ל-status
        // בלבד, זה דורש את ההזמנות של כל מכירה סגורה, אז טוענים אותן (תוך
        // שימוש מלא ב-cache המשותף - app.loadedSaleIds/app.ordersBySaleId -
        // כדי לא לבצע fetch כפול למכירה שכבר נטענה על ידי App/טאב אחר).
        const closedSales = sales.filter((s) => s.status === 'closed');

        const list = [];
        for (const sale of closedSales) {
          const orders = app.loadedSaleIds.has(sale.id) ? app.ordersBySaleId[sale.id] : (await app.loadOrdersForSale(sale.id));
          if (getSaleLifecycleStage(sale, orders) !== 'history') continue;
          const activeOrders = (orders || []).filter((o) => o.orderStatus !== 'cancelled');
          list.push({
            id: sale.id,
            sale,
            count: activeOrders.length,
            packages: activeOrders.reduce((s, o) => s + Number(o.qty || 0), 0),
            revenue: activeOrders.reduce((s, o) => s + Number(o.amount || 0), 0),
            paid: activeOrders.filter((o) => o.paymentStatus === 'paid').reduce((s, o) => s + Number(o.amount || 0), 0),
          });
        }
        if (active) setRows(list);
      } catch (err) {
        console.error('adminListSales (history) failed', err);
        if (active) setLoadError('אירעה שגיאה בטעינת ההיסטוריה. נסו לרענן את הדף.');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

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

  if (loadError) return <Card className="p-6 text-center text-rose-700">{loadError}</Card>;
  if (!rows) return <Spinner />;
  if (rows.length === 0) return <Card className="p-6 text-center text-stone-400">עדיין אין מכירות בהיסטוריה.</Card>;

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => setDrillSaleId(r.id)}
          className="tmr-row flex w-full items-center justify-between gap-3 rounded-[18px] bg-white p-4 text-right"
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
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closingSale, setClosingSale] = useState(false);
  const [drillSaleId, setDrillSaleId] = useState(null);

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
      pickupDate: defaultDeadlineDate(),
      sourcePricesId: null,
      sourceLabel: '',
    };
  }

  const [newSale, setNewSale] = useState(freshNewSaleForm);
  const [otherSales, setOtherSales] = useState([]);
  const [otherSalesError, setOtherSalesError] = useState('');

  // רשימת "שכפול מכירה קודמת" נטענת ישירות מ-Supabase, במבודד לגמרי -
  // לא נוגעת ב-app.salesIndex/app.salesById (ששרתים את "מכירה נוכחית"
  // ואת שאר האתר בדיוק כפי שהיה עד עכשיו).
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

  // מכירות "שהסתיימו" (closed, עם הזמנה אחת לפחות שלא טופלה) - מטופלות
  // כאן ולא רק כבורר שכפול. מחשבים רק עבור מכירות שההזמנות שלהן כבר
  // נטענו (app.loadedSaleIds, נטען ברמת App על ידי app.loadClosedSales).
  const endedSales = useMemo(() => {
    return (app.closedSaleIds || [])
      .filter((id) => app.loadedSaleIds.has(id))
      .map((id) => app.salesById[id])
      .filter((s) => s && getSaleLifecycleStage(s, app.ordersBySaleId[s.id]) === 'ended')
      .sort((a, b) => new Date(b.openDate) - new Date(a.openDate));
  }, [app.closedSaleIds, app.salesById, app.ordersBySaleId, app.loadedSaleIds]);

  if (drillSaleId) {
    return (
      <OrdersTab
        app={app}
        saleId={drillSaleId}
        readOnlyBanner={
          <Button variant="ghost" onClick={() => setDrillSaleId(null)}>
            ← חזרה למכירות שהסתיימו
          </Button>
        }
      />
    );
  }

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
    if (!newSale.pickupDate) {
      setNewSaleError('יש להגדיר תאריך איסוף');
      return;
    }
    // השוואה לפי תאריך בלבד (מחרוזות YYYY-MM-DD, ללא רכיב שעה) - בדיוק
    // כפי שנדרש, ללא תלות באזור זמן.
    if (newSale.pickupDate < newSale.deadlineDate) {
      setNewSaleError('תאריך האיסוף לא יכול להיות לפני מועד סיום ההזמנות');
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
      pickupDate: newSale.pickupDate,
    });
    setNewSale(freshNewSaleForm());
  }

  function handleCloseSale() {
    if (!currentSale) return;
    setConfirmingClose(true);
  }

  async function handleConfirmCloseSale() {
    if (!currentSale || closingSale) return;
    setClosingSale(true);
    try {
      await app.closeSale(currentSale.id);
      setConfirmingClose(false);
    } catch (err) {
      console.error('closeSale failed', err);
    } finally {
      setClosingSale(false);
    }
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
        <h3 className="tmr-title text-[17px] text-stone-900">מכירה נוכחית</h3>
        {currentSale ? (
          <div className="mt-3 space-y-3 rounded-[16px] bg-amber-50 p-4 ring-1 ring-inset ring-amber-900/[0.08]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-stone-800">{currentSale.name}</div>
                <div className="text-xs text-stone-400">
                  נפתחה {fmtDate(currentSale.openDate)}
                  {currentSale.deadline && ` · דדליין הזמנות: ${fmtDeadline(currentSale.deadline)}`}
                  {` · תאריך איסוף: ${currentSale.pickupDate ? fmtDate(currentSale.pickupDate) : 'לא הוגדר'}`}
                </div>
              </div>
              <Button variant="secondary" onClick={handleCloseSale}>סגירת מכירה</Button>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-amber-200/60 pt-3">
              <Button variant="subtle" onClick={() => exportSaleReport(currentSale, app.ordersBySaleId[currentSale.id] || [])}>
                הורדת דוח (Excel)
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-stone-400">אין כרגע מכירה פתוחה.</p>
        )}

        <div className="mt-5 space-y-3 border-t border-stone-100 pt-4">
          <h4 className="tmr-title text-[15px] text-stone-800">פתיחת מכירה חדשה</h4>
          {newSale.sourceLabel && (
            <p className="rounded-[12px] bg-stone-100 px-3.5 py-2.5 text-xs text-stone-600">
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
          <Field label="תאריך איסוף">
            <input type="date" className={inputCls} value={newSale.pickupDate} onChange={(e) => setNewSale((s) => ({ ...s, pickupDate: e.target.value }))} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-amber-800" checked={newSale.stockEnabled} onChange={(e) => setNewSale((s) => ({ ...s, stockEnabled: e.target.checked }))} />
            הגבלת מלאי אריזות
          </label>
          {newSale.stockEnabled && (
            <Field label="כמות אריזות זמינה">
              <input type="number" className={inputCls} value={newSale.stockTotal} onChange={(e) => setNewSale((s) => ({ ...s, stockTotal: e.target.value }))} />
            </Field>
          )}
          {currentSale && (
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" className="h-5 w-5 shrink-0 accent-amber-800" checked={newSale.closeCurrent} onChange={(e) => setNewSale((s) => ({ ...s, closeCurrent: e.target.checked }))} />
              סגור את המכירה הנוכחית אוטומטית
            </label>
          )}
          {newSaleError && <p className="rounded-[12px] bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/10">{newSaleError}</p>}
          <Button onClick={handleOpenSale}>פתיחת מכירה חדשה</Button>

          {otherSalesError && <p className="rounded-[12px] bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/10">{otherSalesError}</p>}
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

      {endedSales.length > 0 && (
        <Card className="p-5">
          <h3 className="tmr-title text-[17px] text-stone-900">מכירות שהסתיימו</h3>
          <p className="mt-1 text-xs text-stone-400">
            נסגרו להזמנות, אבל יש בהן עדיין הזמנה שלא נמסרה ו/או לא שולמה. הן יעברו להיסטוריה אוטומטית ברגע שכל ההזמנות שלהן יטופלו.
          </p>
          <div className="mt-3 space-y-2">
            {endedSales.map((s) => (
              <button
                key={s.id}
                onClick={() => setDrillSaleId(s.id)}
                className="tmr-row flex w-full items-center justify-between gap-3 rounded-[16px] bg-white p-3.5 text-right"
              >
                <div>
                  <div className="text-sm font-medium text-stone-800">{s.name}</div>
                  <div className="text-xs text-stone-400">נפתחה {fmtDate(s.openDate)}</div>
                </div>
                <span className="text-xs text-amber-800">לטיפול ←</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {confirmingClose && currentSale && (
        <Modal
          title="סגירת מכירה"
          onClose={() => {
            if (!closingSale) setConfirmingClose(false);
          }}
          footer={
            <>
              <Button variant="ghost" className="flex-1" onClick={() => setConfirmingClose(false)} disabled={closingSale}>
                ביטול
              </Button>
              <Button className="flex-1" onClick={handleConfirmCloseSale} disabled={closingSale}>
                {closingSale ? 'סוגר…' : 'סגור מכירה'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-stone-600">
            האם אתה בטוח שברצונך לסגור את המכירה "{currentSale.name}" להזמנות חדשות?
          </p>
        </Modal>
      )}
    </div>
  );
}

function SettingsTab({ app }) {
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [saved, setSaved] = useState(false);

  // טעינה מבודדת ל-Admin בלבד, ישירות מ-Supabase.
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
        <h3 className="tmr-title text-[17px] text-stone-900">שם האתר</h3>
        <Field label="שם האתר">
          <input className={inputCls} value={form.siteName} onChange={(e) => update('siteName', e.target.value)} />
        </Field>
      </Card>
      <Card className="space-y-4 p-5">
        <h3 className="tmr-title text-[17px] text-stone-900">פרטי מוכר</h3>
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
        <h3 className="tmr-title text-[17px] text-stone-900">קישורי תשלום</h3>
        <Field label="קישור Bit" hint="אם ריק, כפתור Bit לא יוצג ללקוח">
          <input className={inputCls} value={form.bitLink} onChange={(e) => update('bitLink', e.target.value)} placeholder="https://..." />
        </Field>
        <Field label="קישור PayBox" hint="אם ריק, כפתור PayBox לא יוצג ללקוח">
          <input className={inputCls} value={form.payboxLink} onChange={(e) => update('payboxLink', e.target.value)} placeholder="https://..." />
        </Field>
      </Card>

      <Card className="space-y-3 p-5">
        <h3 className="tmr-title text-[17px] text-stone-900">תמחור ברירת מחדל (מדורג)</h3>
        <p className="text-xs text-stone-400">
          התמחור הזה ייקבע למכירה הבאה שתיפתח בלבד. לכל מכירה יש עותק קבוע משלה בזמן הפתיחה, כך ששינוי כאן לא משנה מכירות
          שכבר קיימות. כל מדרגה קובעת מחיר ליחידה החל מכמות מסוימת ומעלה.
        </p>
        {form.defaultPrices.tiers.map((tier, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="shrink-0 text-sm text-stone-600">החל מ-</span>
            <input
              type="number"
              min={1}
              className="w-20 shrink-0 tmr-num rounded-[12px] border border-stone-300/80 bg-white px-3 py-2.5 text-base text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none focus:ring-4 focus:ring-amber-600/15 transition-[border-color,box-shadow] duration-150"
              value={tier.minQty}
              onChange={(e) => updateTier(i, 'minQty', e.target.value)}
            />
            <span className="shrink-0 text-sm text-stone-600">קופסאות →</span>
            <input
              type="number"
              className="w-24 shrink-0 tmr-num rounded-[12px] border border-stone-300/80 bg-white px-3 py-2.5 text-base text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none focus:ring-4 focus:ring-amber-600/15 transition-[border-color,box-shadow] duration-150"
              value={tier.pricePerUnit}
              onChange={(e) => updateTier(i, 'pricePerUnit', e.target.value)}
            />
            <span className="shrink-0 text-sm text-stone-400">₪ ליחידה</span>
            <button
              type="button"
              onClick={() => removePriceTier(i)}
              disabled={form.defaultPrices.tiers.length <= 1}
              className="tmr-press shrink-0 rounded-full px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-30"
              aria-label="הסרת מדרגה"
            >
              הסר
            </button>
          </div>
        ))}
        <Button variant="subtle" onClick={addPriceTier}>הוספת מדרגת כמות</Button>
        <div className="rounded-[12px] bg-stone-50 p-3.5 text-xs text-stone-500">
          לדוגמה עם ההגדרות הנוכחיות: 1 = {fmtCurrency(calcAmount(form.defaultPrices, 1))} · 4 = {fmtCurrency(calcAmount(form.defaultPrices, 4))} · 10 = {fmtCurrency(calcAmount(form.defaultPrices, 10))}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSaveSettings}>שמירת הגדרות</Button>
        {saved && <span className="text-sm font-medium text-emerald-700">נשמר ✓</span>}
      </div>
    </div>
  );
}


/* ================================ App =================================== */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [salesIndex, setSalesIndex] = useState([]);
  const [salesById, setSalesById] = useState({});
  const [ordersBySaleId, setOrdersBySaleId] = useState({});
  const [loadedSaleIds, setLoadedSaleIds] = useState(() => new Set());
  const [currentSaleId, setCurrentSaleId] = useState(null);
  const [view, setView] = useState('customer'); // 'customer' | 'admin-gate' | 'admin'
  const [toast, setToast] = useState('');
  const [session, setSession] = useState(null); // Supabase Auth session - null = not logged in

  // דגלים למניעת טעינה כפולה/מקבילה של בדיקת המכירה הפתוחה מ-Supabase -
  // היא עשויה לרוץ גם מה-bootstrap (unauthenticated, עלול להיכשל בשקט)
  // וגם מ-Effect נפרד שמופעל ברגע שיש session תקין (ר' למטה).
  const supabaseSaleAppliedRef = useRef(false);
  const supabaseSaleInFlightRef = useRef(false);

  function notify(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  // בודקת אם קיימת מכירה פתוחה אמיתית ב-Supabase, ואם כן - קובעת לפיה את
  // salesById/currentSaleId/ordersBySaleId (המקור היחיד לנתונים האלה כיום).
  // מיושמת פעם אחת בלבד בזכות ה-ref: אם כבר נמצאה/הוחלה בעבר (למשל
  // ע"י ה-bootstrap, כשכבר יש session תקף מרענון קודם), קריאה נוספת (למשל
  // מיד אחרי login) היא no-op ולא יוצרת טעינה כפולה.
  const applySupabaseOpenSale = useCallback(async () => {
    if (supabaseSaleAppliedRef.current || supabaseSaleInFlightRef.current) return;
    supabaseSaleInFlightRef.current = true;
    try {
      const supabaseSales = await adminListSales();
      const openSupabaseSale = supabaseSales.find((sale) => sale.status === 'open');
      if (openSupabaseSale) {
        // מציגים את המכירה מיד ברגע שהיא נמצאה - בלי לחכות לטעינת ה-orders
        // שלה, כדי לא לעכב את הופעתה. ה-orders עדיין נטענים מיד אחרי (לא
        // הוסרה הקריאה), רק לא חוסמים בהם את הופעת המכירה עצמה.
        setSalesById((m) => ({ ...m, [openSupabaseSale.id]: openSupabaseSale }));
        setCurrentSaleId(openSupabaseSale.id);
        setLoadedSaleIds((s) => new Set(s).add(openSupabaseSale.id));
        supabaseSaleAppliedRef.current = true;

        try {
          const orders = await adminGetOrders(openSupabaseSale.id);
          setOrdersBySaleId((m) => ({ ...m, [openSupabaseSale.id]: orders }));
        } catch (ordersErr) {
          // כשל בטעינת ה-orders לא אמור לבטל את המכירה שכבר הוצגה בהצלחה.
          console.warn('adminGetOrders failed after showing the open sale', ordersErr);
        }
      } else {
        // Supabase ענתה בהצלחה (בלי error) שאין אף מכירה עם status='open' -
        // זו תשובה אמינה, לא כשל. מאפסים את currentSaleId (למרות שזה כבר
        // ערך ברירת המחדל) כדי להיות מפורשים. salesById/ordersBySaleId לא
        // נוקים - DashboardTab/OrdersTab/SalesManagementTab כולם בודקים
        // קודם currentSaleId, אז null מספיק כדי שכולם יגיעו נכון למצב
        // "אין מכירה פתוחה".
        setCurrentSaleId(null);
        supabaseSaleAppliedRef.current = true;
      }
    } catch (err) {
      // כשל אמיתי (רשת/הרשאה) - לא נוגעים ב-state בכלל. currentSaleId
      // נשאר על ערך ברירת המחדל (null), וה-UI הקיים כבר יודע להציג
      // "אין כרגע מכירה פתוחה" - בלי קריסה ובלי נתונים ישנים/דמו.
      console.warn('adminListSales check failed', err);
    } finally {
      supabaseSaleInFlightRef.current = false;
    }
  }, []);

  // מעקב Session אמיתי אחרי Supabase Auth - Effect נפרד ובלתי-תלוי לגמרי
  // מה-Effect שטוען את נתוני המכירה הפתוחה למטה (applySupabaseOpenSale),
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

  // בכניסה ראשונה (login טרי), ה-bootstrap שלמטה עלול לנסות לבדוק את
  // Supabase לפני שיש session תקף בכלל (ולכן נכשל בשקט, ו-currentSaleId
  // נשאר על ברירת המחדל null). ברגע שה-session הופך זמין (מיד אחרי login),
  // מנסים שוב - applySupabaseOpenSale כבר מוגנת מפני ריצה כפולה, כך שאם
  // ה-bootstrap כבר הצליח בעצמו (למשל ברענון עם session קיים), זו קריאה
  // חסרת אפקט (no-op).
  useEffect(() => {
    if (session) {
      applySupabaseOpenSale();
    }
  }, [session, applySupabaseOpenSale]);

  useEffect(() => {
    (async () => {
      // ה-bootstrap כולו מסתמך אך ורק על Supabase דרך applySupabaseOpenSale():
      // אם נמצאה מכירה פתוחה - היא מוצגת עם ההזמנות שלה; אם Supabase ענתה
      // בהצלחה שאין מכירה פתוחה - currentSaleId מתאפס ל-null (המצב ההתחלתי
      // ממילא) וה-UI הקיים כבר יודע להציג "אין כרגע מכירה פתוחה"; ואם
      // הקריאה נכשלת (רשת/הרשאה) - ה-catch הפנימי של applySupabaseOpenSale
      // רק רושם אזהרה ולא נוגע ב-state כלל, כך שהאפליקציה נשארת פשוט על
      // המצב ההתחלתי (currentSaleId=null) - בלי קריסה ובלי נתונים ישנים.
      await applySupabaseOpenSale();
      setLoading(false);
    })();
  }, []);

  const loadOrdersForSale = useCallback(async (saleId) => {
    const orders = await adminGetOrders(saleId);
    setOrdersBySaleId((m) => ({ ...m, [saleId]: orders }));
    setLoadedSaleIds((s) => new Set(s).add(saleId));
    return orders;
  }, []);

  // ---- מכירות סגורות ("מכירות שהסתיימו" / "היסטוריה") ----
  // כדי לסווג מכירה סגורה (ended/history) צריך את ההזמנות שלה, לא רק את
  // ה-status. הטעינה כאן היא ברמת App (לא בתוך כל טאב בנפרד) כדי שכל
  // הצרכנים (Dashboard, SalesManagementTab, HistoryTab) ישתמשו באותו
  // cache משותף (salesById/ordersBySaleId/loadedSaleIds) ולא יבצעו כל אחד
  // fetch נפרד לאותן מכירות/הזמנות.
  const [closedSaleIds, setClosedSaleIds] = useState([]);
  const closedSalesLoadedRef = useRef(false);
  const closedOrdersRequestedRef = useRef(new Set());

  // שולפת את כל המכירות (limit: null, בדיוק כמו ש-HistoryTab כבר עשה),
  // ממזגת אותן ל-salesById המשותף, ושומרת בנפרד רק את ה-IDs של מכירות
  // סגורות. פעם אחת בלבד לכל טעינת עמוד (מוגן ב-ref) - זה fetch יחיד,
  // לא N+1, ומרוענן רק ב-refresh מלא של הדף.
  const loadClosedSales = useCallback(async () => {
    if (closedSalesLoadedRef.current) return;
    closedSalesLoadedRef.current = true;
    try {
      const allSales = await adminListSales({ limit: null });
      setSalesById((m) => {
        const merged = { ...m };
        for (const sale of allSales) merged[sale.id] = sale;
        return merged;
      });
      setClosedSaleIds(allSales.filter((s) => s.status === 'closed').map((s) => s.id));
    } catch (err) {
      console.warn('loadClosedSales failed', err);
      closedSalesLoadedRef.current = false; // כשל אמיתי - מאפשרים ניסיון חוזר בעתיד
    }
  }, []);

  // ברגע שיש רשימת מכירות סגורות, טוענים את ההזמנות של כל אחת שעוד לא
  // נטענה (כדי שאפשר יהיה לחשב עבורה getSaleLifecycleStage). כל מכירה
  // מתבקשת פעם אחת בלבד (closedOrdersRequestedRef) - גם אם האפקט רץ שוב
  // בגלל עדכון state, לא נשלחת בקשת Supabase כפולה לאותה מכירה.
  useEffect(() => {
    const toLoad = closedSaleIds.filter(
      (id) => !loadedSaleIds.has(id) && !closedOrdersRequestedRef.current.has(id)
    );
    if (!toLoad.length) return;
    toLoad.forEach((id) => closedOrdersRequestedRef.current.add(id));
    Promise.all(toLoad.map((id) => loadOrdersForSale(id))).catch((err) => {
      console.warn('loading orders for closed sales failed', err);
      toLoad.forEach((id) => closedOrdersRequestedRef.current.delete(id)); // מאפשר ניסיון חוזר
    });
  }, [closedSaleIds, loadedSaleIds, loadOrdersForSale]);

  // הצד הציבורי: יצירת הזמנה עוברת עכשיו דרך create_order() ב-Supabase
  // (RPC). sale מגיע מה-formData (נטען ב-CustomerView עצמו דרך
  // get_open_sale()) - לא מ-salesById/currentSaleId המשותפים, כדי לשמור
  // את הצד הציבורי מבודד מה-state המשותף שמשמש גם את Admin.
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

  // מחיקה לצמיתות של הזמנה אחת. מסירים אותה מה-state רק אחרי שהשרת אישר
  // את המחיקה - אם המחיקה נכשלה, ההזמנה נשארת ברשימה כמו שהיא.
  const deleteOrder = useCallback(async (saleId, orderId) => {
    await adminDeleteOrder(orderId);
    setOrdersBySaleId((m) => ({ ...m, [saleId]: (m[saleId] || []).filter((o) => o.id !== orderId) }));
    notify('ההזמנה נמחקה לצמיתות');
  }, []);

  const saveSettings = useCallback(async (newSettings) => {
    await adminSaveSettings(newSettings);
  }, []);

  const createSale = useCallback(
    async ({ name, stockEnabled, stockTotal, closeCurrent, prices, deadline, pickupDate }) => {
      // עותק קבוע של המחירים בזמן פתיחת המכירה - זו הפעולה המקבילה ל-
      // "sale.prices := settings.default_prices" שכבר קיימת בפועל בתוך
      // admin_create_sale() בצד השרת. כשלא מועברים prices מפורשים (מכירה
      // חדשה שאינה שכפול), נטענת ברירת המחדל ישירות מ-Supabase - lazy,
      // רק ברגע הזה, בלי טעינה מוקדמת/state נוסף.
      let finalPrices;
      if (prices) {
        finalPrices = { ...prices };
      } else {
        const settingsFromSupabase = await adminGetSettings();
        finalPrices = { ...settingsFromSupabase.defaultPrices };
      }
      // היצירה עצמה עוברת דרך ה-RPC של Supabase - ה-id האמיתי (uuid) מגיע
      // בחזרה מהשרת, לא נוצר יותר מקומית עם uid('sale_').
      const sale = await adminCreateSale({
        name,
        deadline: deadline || null,
        prices: finalPrices,
        stockEnabled: !!stockEnabled,
        stockTotal: Number(stockTotal) || 0,
        closeCurrent: !!closeCurrent,
        pickupDate: pickupDate || null,
      });
      const nextIndex = [sale.id, ...salesIndex];
      setSalesIndex(nextIndex);
      setSalesById((m) => ({ ...m, [sale.id]: sale }));
      setCurrentSaleId(sale.id);
      notify('המכירה נפתחה');
    },
    [salesIndex]
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
  const app = {
    salesIndex,
    salesById,
    setSalesById,
    ordersBySaleId,
    loadedSaleIds,
    currentSaleId,
    closedSaleIds,
    loadClosedSales,
    loadOrdersForSale,
    updateOrder,
    bulkUpdateOrders,
    deleteOrder,
    saveSettings,
    createSale,
    closeSale,
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
    <div dir="rtl" lang="he" className="tmr-root min-h-screen bg-stone-50">
      <GlobalStyle />
      {loading ? (
        <Spinner />
      ) : view === 'customer' ? (
        <CustomerView
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
