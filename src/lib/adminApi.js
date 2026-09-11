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
