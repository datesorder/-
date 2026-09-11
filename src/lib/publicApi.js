import { supabase } from './supabaseClient'

// שכבת API ציבורית מינימלית, נפרדת מ-adminApi.js, מדברת ישירות מול
// Supabase (בלי חיבור ל-window.storage/db בכלל). ממפה snake_case -> camelCase
// כדי שה-UI הקיים ימשיך לקבל בדיוק את אותו מבנה נתונים שהוא כבר מצפה לו.

export async function getOpenSale() {
  const { data, error } = await supabase.rpc('get_open_sale')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    openDate: row.open_date,
    closeDate: row.close_date,
    deadline: row.deadline,
    prices: row.prices,
    stockEnabled: row.stock_enabled,
    stockTotal: row.stock_total,
    stockRemaining: row.stock_remaining,
  }
}

export async function createOrder({ saleId, firstName, lastName, phone, area, qty, notes, paymentMethod, markPaid }) {
  const { data, error } = await supabase.rpc('create_order', {
    p_sale_id: saleId,
    p_first_name: firstName,
    p_last_name: lastName,
    p_phone: phone,
    p_area: area,
    p_qty: qty,
    p_notes: notes,
    p_payment_method: paymentMethod,
    p_mark_paid: !!markPaid,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data

  return {
    id: row.id,
    orderNumber: row.order_number,
    amount: row.amount,
    paymentMethod: row.payment_method,
  }
}
