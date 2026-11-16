const { db, json, readBody, fail, validateText, requireAdmin } = require('./_shared');
const { sendOrderEmails } = require('./_email');

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const path = (event.path || '').replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '').replace(/\/$/, '') || '/';
    const supabase = db();

    if (method === 'GET' && path === '/products') {
      const { data, error } = await supabase.from('products').select('id,name,description,category,unit,price,old_price,image_url,stock_quantity,available,created_at').eq('available', true).gt('stock_quantity', 0).order('created_at', { ascending: false });
      if (error) throw error;
      return json(200, { products: data });
    }

    if (method === 'POST' && path === '/orders') {
      const body = readBody(event);
      const customer_name = validateText(body.customer_name, 'name', 160);
      const customer_phone = validateText(body.customer_phone, 'phone', 25, 7);
      const customer_address = validateText(body.customer_address, 'address', 1000, 5);
      const delivery_area = validateText(body.delivery_area, 'delivery area', 120);
      const cutting_note = typeof body.cutting_note === 'string' ? body.cutting_note.slice(0,300) : '';
      const customer_email = body.customer_email ? validateText(body.customer_email,'email',254) : null;
      if (customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) throw Object.assign(new Error('Invalid email'), {status:400});
      const payment_method = body.payment_method;
      const transaction_id = body.transaction_id ? validateText(body.transaction_id,'transaction ID',100) : null;
      if (!['Cash on Delivery','bKash','Nagad'].includes(payment_method)) throw Object.assign(new Error('Invalid payment method'), {status:400});
      if (payment_method !== 'Cash on Delivery' && !transaction_id) throw Object.assign(new Error('Transaction ID required'), {status:400});
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) throw Object.assign(new Error('Invalid items'), {status:400});
      const items = body.items.map(i => ({ product_id: validateText(i.product_id,'product id',50), quantity: Number(i.quantity) }));
      const delivery_charge = Number(body.delivery_charge);
      const { data: created, error } = await supabase.rpc('create_customer_order', {
        p_order: { customer_name,customer_phone,customer_email,customer_address,cutting_note,delivery_area,delivery_charge,payment_method,transaction_id },
        p_items: items,
        p_notification_email: process.env.ORDER_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL
      });
      if (error) {
        if (/unavailable|insufficient stock/i.test(error.message)) return json(409,{error:'একটি পণ্য আর উপলব্ধ নেই বা পর্যাপ্ত stock নেই।'});
        if (/invalid|required/i.test(error.message)) return json(400,{error:'অর্ডারের তথ্য যাচাই করা যায়নি।'});
        throw error;
      }
      let emailResults = [];
      try { emailResults = await sendOrderEmails(created.id); } catch (e) { console.error('Order saved; email delivery failed', e); }
      return json(201,{order:{order_id:created.order_code,created_at:created.created_at,total:created.total},email_status:emailResults});
    }

    if (method === 'POST' && path === '/orders/track') {
      const body = readBody(event);
      const orderId = validateText(body.order_id,'order ID',40);
      const phone = validateText(body.phone,'phone',25,7).replace(/[\s()-]/g,'');
      const { data, error } = await supabase.from('orders').select('order_code,status,created_at,customer_phone').eq('order_code',orderId).maybeSingle();
      if (error) throw error;
      if (!data || data.customer_phone.replace(/[\s()-]/g,'') !== phone) return json(404,{error:'অর্ডার পাওয়া যায়নি।'});
      return json(200,{order:{order_id:data.order_code,status:data.status,created_at:data.created_at}});
    }

    if (!path.startsWith('/admin/')) return json(404,{error:'Not found'});
    await requireAdmin(event);

    if (method === 'GET' && path === '/admin/products') {
      const { data,error } = await supabase.from('products').select('*').order('created_at',{ascending:false});
      if(error) throw error; return json(200,{products:data});
    }
    if (method === 'POST' && path === '/admin/products') {
      const b=readBody(event); const payload={
        name:validateText(b.name,'name',180), description:typeof b.description==='string'?b.description.slice(0,3000):'',
        category:validateText(b.category,'category',80), unit:validateText(b.unit||'১ কেজি','unit',80),
        price:Number(b.price), old_price:b.old_price==null||b.old_price===''?null:Number(b.old_price),
        image_url:typeof b.image_url==='string'?b.image_url.slice(0,2000):'', stock_quantity:Number(b.stock_quantity), available:Boolean(b.available)
      };
      if(!Number.isFinite(payload.price)||payload.price<0||!Number.isInteger(payload.stock_quantity)||payload.stock_quantity<0|| (payload.old_price!==null&&(!Number.isFinite(payload.old_price)||payload.old_price<0))) throw Object.assign(new Error('Invalid price or stock'),{status:400});
      const {data,error}=await supabase.from('products').insert(payload).select().single(); if(error)throw error; return json(201,{product:data});
    }
    const productMatch=path.match(/^\/admin\/products\/([0-9a-f-]{36})$/i);
    if(productMatch&&method==='PUT'){
      const b=readBody(event); const payload={};
      for(const field of ['name','description','category','unit','image_url','price','old_price','stock_quantity','available']) if(field in b) payload[field]=b[field];
      if('name'in payload)payload.name=validateText(payload.name,'name',180);
      if('category'in payload)payload.category=validateText(payload.category,'category',80);
      if('unit'in payload)payload.unit=validateText(payload.unit,'unit',80);
      if('description'in payload&&typeof payload.description!=='string')throw Object.assign(new Error('Invalid description'),{status:400});
      if('image_url'in payload&&typeof payload.image_url!=='string')throw Object.assign(new Error('Invalid image URL'),{status:400});
      for(const f of ['price','old_price'])if(f in payload){payload[f]=payload[f]===''||payload[f]===null?null:Number(payload[f]);if(payload[f]!==null&&(!Number.isFinite(payload[f])||payload[f]<0))throw Object.assign(new Error('Invalid price'),{status:400});}
      if('stock_quantity'in payload){payload.stock_quantity=Number(payload.stock_quantity);if(!Number.isInteger(payload.stock_quantity)||payload.stock_quantity<0)throw Object.assign(new Error('Invalid stock'),{status:400});}
      if('available'in payload&&typeof payload.available!=='boolean')throw Object.assign(new Error('Invalid availability'),{status:400});
      payload.updated_at=new Date().toISOString(); const {data,error}=await supabase.from('products').update(payload).eq('id',productMatch[1]).select().maybeSingle();if(error)throw error;if(!data)return json(404,{error:'Product not found'});return json(200,{product:data});
    }
    if(productMatch&&method==='DELETE'){const {error}=await supabase.from('products').delete().eq('id',productMatch[1]);if(error)throw error;return json(200,{ok:true});}
    if(method==='GET'&&path==='/admin/orders'){
      const query=event.queryStringParameters||{};let q=supabase.from('orders').select('*,order_items(*)').order('created_at',{ascending:false}).limit(200);
      if(query.search){const term=query.search.replace(/[,%()]/g,'').slice(0,80);q=q.or(`order_code.ilike.%${term}%,customer_phone.ilike.%${term}%`);}
      const {data,error}=await q;if(error)throw error;return json(200,{orders:data});
    }
    const orderMatch=path.match(/^\/admin\/orders\/([0-9a-f-]{36})$/i);
    if(orderMatch&&method==='PATCH'){
      const {status}=readBody(event);if(!['Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].includes(status))throw Object.assign(new Error('Invalid status'),{status:400});
      const {data,error}=await supabase.from('orders').update({status}).eq('id',orderMatch[1]).select('id,order_code,status').maybeSingle();if(error)throw error;if(!data)return json(404,{error:'Order not found'});return json(200,{order:data});
    }
    if(orderMatch&&method==='DELETE'){const {error}=await supabase.from('orders').delete().eq('id',orderMatch[1]);if(error)throw error;return json(200,{ok:true});}
    const retryMatch=path.match(/^\/admin\/orders\/([0-9a-f-]{36})\/retry-email$/i);
    if(retryMatch&&method==='POST'){const result=await sendOrderEmails(retryMatch[1]);return json(200,{results:result});}
    return json(404,{error:'Not found'});
  } catch (error) { return fail(error); }
};
