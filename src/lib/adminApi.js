import { supabase } from './supabaseClient'

// שכבת API נפרדת לגמרי ל-Admin, שמדברת ישירות מול Supabase (מאומת, תחת RLS).
// לא נוגעת ב-db הקיים, שממשיך לשרת את הצד הציבורי כרגיל.
// כל פונקציה כאן ממפה במפורש מ-snake_case (Supabase) ל-camelCase, כדי
// שה-UI הקיים ימשיך לקבל בדיוק את אותו מבנה נתונים שהוא כבר מצפה לו.

export async function adminGetSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('seller_name, phone, customer_intro, pickup_info, bit_link, paybox_link, default_prices')
    .limit(1)
    .single()

  if (error) {
    throw error
  }

  return {
    sellerName: data.seller_name,
    phone: data.phone,
    customerIntro: data.customer_intro,
    pickupInfo: data.pickup_info,
    bitLink: data.bit_link,
    payboxLink: data.paybox_link,
    defaultPrices: data.default_prices,
  }
}

export async function adminListSales() {
  const { data, error } = await supabase
    .from('sales')
    .select('id, name, stock_enabled, stock_total, prices')
    .order('open_date', { ascending: false })
    .limit(4)

  if (error) throw error

  return data.map((s) => ({
    id: s.id,
    name: s.name,
    stockEnabled: s.stock_enabled,
    stockTotal: s.stock_total,
    prices: s.prices,
  }))
}

export async function adminCreateSale({ name, deadline, prices, stockEnabled, stockTotal, closeCurrent }) {
  const { data, error } = await supabase.rpc('admin_create_sale', {
    p_name: name,
    p_deadline: deadline,
    p_prices: prices,
    p_stock_enabled: !!stockEnabled,
    p_stock_total: stockTotal ?? null,
    p_close_current: closeCurrent !== false,
  })

  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('admin_create_sale returned no row')

  return {
    id: row.id,
    name: row.name,
    openDate: row.open_date,
    closeDate: row.close_date,
    status: row.status,
    stockEnabled: row.stock_enabled,
    stockTotal: row.stock_total,
    prices: row.prices,
    orderSeq: row.order_seq,
    deadline: row.deadline,
  }
}
