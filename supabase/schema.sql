create extension if not exists pgcrypto;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 180),
  description text not null default '',
  category text not null check (char_length(category) between 1 and 80),
  unit text not null default '১ কেজি',
  price numeric(12,2) not null check (price >= 0),
  old_price numeric(12,2) check (old_price is null or old_price >= 0),
  image_url text not null default '',
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null unique default ('HDM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  customer_name text not null check (char_length(customer_name) between 1 and 160),
  customer_phone text not null check (char_length(customer_phone) between 7 and 25),
  customer_email text,
  customer_address text not null check (char_length(customer_address) between 5 and 1000),
  cutting_note text not null default '',
  delivery_area text not null,
  delivery_charge numeric(12,2) not null check (delivery_charge >= 0),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  total numeric(12,2) not null check (total >= 0),
  payment_method text not null check (payment_method in ('Cash on Delivery', 'bKash', 'Nagad')),
  transaction_id text,
  status text not null default 'Pending' check (status in ('Pending','Confirmed','Processing','Shipped','Delivered','Cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity between 1 and 100),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0)
);

create table if not exists public.email_outbox (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('admin_notification','customer_confirmation')),
  recipient text not null,
  state text not null default 'pending' check (state in ('pending','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);

create index if not exists orders_phone_code_idx on public.orders (customer_phone, order_code);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists email_outbox_pending_idx on public.email_outbox (state, created_at);

alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.email_outbox enable row level security;

-- Anonymous clients can only read products marked available. All writes go through
-- the server function, which authenticates and allowlists the admin explicitly.
drop policy if exists "public reads available products" on public.products;
create policy "public reads available products" on public.products
  for select to anon, authenticated using (available = true and stock_quantity > 0);
-- No customer-readable policies for orders, order_items, or the email outbox.
-- Service role is used only inside Netlify Functions, never in the browser.

-- Storage bucket may be created in Supabase UI as public `product-images`.
-- Public object reads are needed for product cards; restrict all mutations to the
-- admin user in the server function. Do not grant anon insert/update/delete.

-- Atomic order creation. Called only by Netlify using service-role credentials.
create or replace function public.create_customer_order(p_order jsonb, p_items jsonb, p_notification_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_subtotal numeric(12,2) := 0;
  v_delivery numeric(12,2);
  v_total numeric(12,2);
  v_customer_email text;
  v_method text;
  v_tx text;
  v_lines jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then
    raise exception 'Invalid order items';
  end if;
  v_method := p_order->>'payment_method';
  if v_method not in ('Cash on Delivery','bKash','Nagad') then raise exception 'Invalid payment method'; end if;
  v_delivery := (p_order->>'delivery_charge')::numeric;
  if v_delivery not in (80,120,150) then raise exception 'Invalid delivery charge'; end if;
  v_customer_email := nullif(trim(p_order->>'customer_email'), '');
  v_tx := nullif(trim(p_order->>'transaction_id'), '');
  if v_method in ('bKash','Nagad') and v_tx is null then raise exception 'Transaction ID required'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 100 then raise exception 'Invalid quantity'; end if;
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and available = true and stock_quantity >= v_qty
      for update;
    if not found then raise exception 'Product unavailable or insufficient stock'; end if;
    v_subtotal := v_subtotal + (v_product.price * v_qty);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id',v_product.id,'product_name',v_product.name,'quantity',v_qty,
      'unit_price',v_product.price,'line_total',v_product.price*v_qty
    ));
  end loop;
  v_total := v_subtotal + v_delivery;
  insert into public.orders(customer_name,customer_phone,customer_email,customer_address,cutting_note,
      delivery_area,delivery_charge,subtotal,total,payment_method,transaction_id)
    values (trim(p_order->>'customer_name'),trim(p_order->>'customer_phone'),v_customer_email,
      trim(p_order->>'customer_address'),coalesce(p_order->>'cutting_note',''),
      trim(p_order->>'delivery_area'),v_delivery,v_subtotal,v_total,v_method,v_tx)
    returning * into v_order;

  for v_item in select value from jsonb_array_elements(v_lines) loop
    insert into public.order_items(order_id,product_id,product_name,quantity,unit_price,line_total)
    values (v_order.id,(v_item->>'product_id')::uuid,v_item->>'product_name',
      (v_item->>'quantity')::integer,(v_item->>'unit_price')::numeric,(v_item->>'line_total')::numeric);
    update public.products set stock_quantity = stock_quantity - (v_item->>'quantity')::integer,
      available = (stock_quantity - (v_item->>'quantity')::integer) > 0,
      updated_at = now()
      where id = (v_item->>'product_id')::uuid;
  end loop;

  insert into public.email_outbox(order_id,kind,recipient)
    values (v_order.id,'admin_notification',p_notification_email)
    on conflict (order_id,kind) do nothing;
  if v_customer_email is not null then
    insert into public.email_outbox(order_id,kind,recipient)
      values (v_order.id,'customer_confirmation',v_customer_email)
      on conflict (order_id,kind) do nothing;
  end if;
  return jsonb_build_object('id',v_order.id,'order_code',v_order.order_code,
    'created_at',v_order.created_at,'subtotal',v_subtotal,'delivery_charge',v_delivery,'total',v_total,
    'items',v_lines);
end;
$$;

revoke all on function public.create_customer_order(jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.create_customer_order(jsonb,jsonb,text) to service_role;
