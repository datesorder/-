import { supabase } from './supabaseClient'

// שכבת API נפרדת לגמרי ל-Admin, שמדברת ישירות מול Supabase (מאומת, תחת RLS).
// לא נוגעת ב-db הקיים, שממשיך לשרת את הצד הציבורי כרגיל.
// כל פונקציה כאן ממפה במפורש מ-snake_case (Supabase) ל-camelCase, כדי
// שה-UI הקיים ימשיך לקבל בדיוק את אותו מבנה נתונים שהוא כבר מצפה לו.

export async function adminGetSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('id, seller_name, phone, customer_intro, pickup_info, bit_link, paybox_link, default_prices')
    .limit(1)
    .single()

  if (error) {
    throw error
  }

  return {
    id: data.id,
    sellerName: data.seller_name,
    phone: data.phone,
    customerIntro: data.customer_intro,
    pickupInfo: data.pickup_info,
    bitLink: data.bit_link,
    payboxLink: data.paybox_link,
    defaultPrices: data.default_prices,
  }
}

export async function adminSaveSettings(settings) {
  const { error } = await supabase
    .from('settings')
    .update({
      seller_name: settings.sellerName,
      phone: settings.phone,
      customer_intro: settings.customerIntro,
      pickup_info: settings.pickupInfo,
      bit_link: settings.bitLink,
      paybox_link: settings.payboxLink,
      default_prices: settings.defaultPrices,
    })
    .eq('id', settings.id)

  if (error) throw error
}

export async function adminListSales() {
  const { data, error } = await supabase
    .from('sales')
    .select('id, name, status, open_date, deadline, stock_enabled, stock_total, prices')
    .order('open_date', { ascending: false })
    .limit(4)

  if (error) throw error

  return data.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    openDate: s.open_date,
    deadline: s.deadline,
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

// מזהי מכירה ישנים מה-DEMO/window.storage (כמו "demo-sale-2026-09") אינם
// uuid תקין, ו-orders.sale_id הוא עמודת uuid - שליחת מזהה כזה ל-Supabase
// תיכשל בשגיאת טיפוס. Guard פשוט: אם saleId לא נראה כמו uuid, מחזירים []
// בבטחה בלי לפנות ל-Supabase בכלל (אין fallback ל-window.storage בכוונה).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function adminGetOrders(saleId) {
  if (!UUID_RE.test(saleId)) {
    return []
  }

  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, order_number, first_name, last_name, phone, area, qty, amount, pricing_snapshot, payment_method, payment_status, order_status, notes, internal_note, created_at'
    )
    .eq('sale_id', saleId)
    .order('created_at', { ascending: false })

  if (error) throw error

  return (data || []).map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    firstName: o.first_name,
    lastName: o.last_name,
    phone: o.phone,
    area: o.area,
    qty: o.qty,
    amount: o.amount,
    pricingSnapshot: o.pricing_snapshot,
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    orderStatus: o.order_status,
    notes: o.notes,
    internalNote: o.internal_note,
    createdAt: o.created_at,
  }))
}

export async function adminGetCustomer(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('phone, first_name, last_name, area, total_orders, total_packages')
    .eq('phone', phone)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return {
    phone: data.phone,
    firstName: data.first_name,
    lastName: data.last_name,
    area: data.area,
    totalOrders: data.total_orders,
    totalPackages: data.total_packages,
  }
}

// Whitelist מדויקת של השדות היחידים שמותר לעדכן דרך adminUpdateOrder/
// adminBulkUpdateOrders. id, order_number, sale_id, created_at,
// pricing_snapshot ו-notes אינם ניתנים לעדכון דרך הפונקציות האלה בכוונה.
const ORDER_UPDATABLE_FIELDS = {
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  area: 'area',
  qty: 'qty',
  amount: 'amount',
  paymentMethod: 'payment_method',
  paymentStatus: 'payment_status',
  orderStatus: 'order_status',
  internalNote: 'internal_note',
}

function buildOrderPatch(patch) {
  const dbPatch = {}
  for (const [camelKey, snakeKey] of Object.entries(ORDER_UPDATABLE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(patch, camelKey)) {
      dbPatch[snakeKey] = patch[camelKey]
    }
  }
  return dbPatch
}

export async function adminUpdateOrder(orderId, patch) {
  const dbPatch = buildOrderPatch(patch)
  if (Object.keys(dbPatch).length === 0) {
    throw new Error('adminUpdateOrder: no whitelisted fields to update')
  }

  const { error } = await supabase.from('orders').update(dbPatch).eq('id', orderId)

  if (error) throw error
}

export async function adminBulkUpdateOrders(orderIds, patch) {
  if (!orderIds || orderIds.length === 0) {
    return
  }

  const dbPatch = buildOrderPatch(patch)
  if (Object.keys(dbPatch).length === 0) {
    throw new Error('adminBulkUpdateOrders: no whitelisted fields to update')
  }

  const { error } = await supabase.from('orders').update(dbPatch).in('id', orderIds)

  if (error) throw error
}

export async function adminCloseSale(saleId) {
  const { error } = await supabase
    .from('sales')
    .update({ status: 'closed', close_date: new Date().toISOString() })
    .eq('id', saleId)

  if (error) throw error
}
