const { Resend } = require('resend');
const { db, escapeHtml } = require('./_shared');

async function sendOrderEmails(orderId) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error('Email provider is not configured');
  const supabase = db();
  const { data: order, error: oe } = await supabase.from('orders').select('*, order_items(*)').eq('id', orderId).single();
  if (oe || !order) throw oe || new Error('Order not found');
  const { data: messages, error: me } = await supabase.from('email_outbox').select('*').eq('order_id', orderId).neq('state','sent');
  if (me) throw me;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const lines = order.order_items.map(i => `${i.product_name} × ${i.quantity} — ৳${i.line_total}`).join('\n');
  const htmlLines = order.order_items.map(i => `<li>${escapeHtml(i.product_name)} × ${i.quantity} — ৳${i.line_total}</li>`).join('');
  const results = [];
  for (const message of messages || []) {
    const admin = message.kind === 'admin_notification';
    const subject = admin ? 'New Order Received - Haworer Deshi Mach' : `অর্ডার নিশ্চিতকরণ - ${order.order_code}`;
    const html = `<h2>${admin ? 'New Order Notification' : 'আপনার অর্ডার গ্রহণ করা হয়েছে'}</h2>
      <p><b>Order ID:</b> ${escapeHtml(order.order_code)}</p>
      <p><b>Customer:</b> ${escapeHtml(order.customer_name)}<br><b>Mobile:</b> ${escapeHtml(order.customer_phone)}<br><b>Address:</b> ${escapeHtml(order.customer_address)}</p>
      <p><b>Items:</b></p><ul>${htmlLines}</ul>
      <p><b>Delivery:</b> ৳${order.delivery_charge}<br><b>Total:</b> ৳${order.total}<br><b>Payment:</b> ${escapeHtml(order.payment_method)}<br><b>Transaction ID:</b> ${escapeHtml(order.transaction_id || 'N/A')}<br><b>Order date:</b> ${escapeHtml(order.created_at)}</p>`;
    let state = 'sent'; let errorText = null;
    try {
      const { error } = await resend.emails.send({ from: process.env.EMAIL_FROM, to: message.recipient,
        subject, html, text: `${subject}\nOrder ID: ${order.order_code}\nCustomer: ${order.customer_name}\nPhone: ${order.customer_phone}\nAddress: ${order.customer_address}\nItems:\n${lines}\nTotal: ৳${order.total}\nPayment: ${order.payment_method}\nTransaction: ${order.transaction_id || 'N/A'}\nDate: ${order.created_at}` });
      if (error) throw new Error(error.message || 'Email delivery request failed');
    } catch (e) { state = 'failed'; errorText = String(e.message || e).slice(0, 500); }
    await supabase.from('email_outbox').update({ state, attempts: message.attempts + 1, last_error: errorText, sent_at: state === 'sent' ? new Date().toISOString() : null }).eq('id', message.id);
    results.push({ kind: message.kind, state });
  }
  return results;
}
module.exports = { sendOrderEmails };
