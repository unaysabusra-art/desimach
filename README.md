# হাওরের দেশি মাছ — Backend Setup

এই repository-তে বর্তমানে ওয়েবসাইটের HTML/CSS/JS নেই। এখানে নিরাপদ backend foundation, database schema ও deploy configuration রাখা হয়েছে। আপনার দেওয়া design files (index.html, style.css, script.js) যোগ না করা পর্যন্ত এটি পূর্ণাঙ্গ storefront নয় এবং বর্তমান Netlify site-এ publish করবেন না।

## Stack
- Netlify Functions (Node.js 20+), Supabase PostgreSQL/Auth/Storage, Resend.
- Browser থেকে service-role key বা Resend key ব্যবহার হয় না। Backend function-এ এগুলো Netlify environment variables হিসেবে রাখতে হবে।
- API: `GET /api/products`, `POST /api/orders`, `POST /api/orders/track`, admin paths under `/api/admin/*`.

## Setup
1. Supabase project তৈরি করুন; SQL Editor-এ `supabase/schema.sql` সম্পূর্ণ run করুন.
2. Supabase Auth > Users থেকে **admin email**-এর user-ийг manually invite/create করুন. Public sign-up-ийг Auth settings-এ disable করুন. Password নিজে সেট করুন; email confirmation/MFA এবং Auth rate limits চালু রাখুন.
3. Storage-এ `product-images` public bucket তৈরি করুন. SQL-এ দেওয়া policies অনুযায়ী শুধু authenticated admin upload/update/delete করতে পারবেন.
4. Netlify-তে repository connect করুন, Node 20 নির্বাচন করুন. Site settings > Environment variables-এ সেট করুন:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (শুধু server/functions; কখনো `VITE_`/frontend variable নয়)
   - `ADMIN_EMAIL` (অনুমোদিত admin-এর সঠিক email)
   - `RESEND_API_KEY`
   - `ORDER_NOTIFICATION_EMAIL` (অর্ডার নোটিফিকেশনের recipient)
   - `EMAIL_FROM` (Resend-এ verified sender, যেমন `Orders <orders@your-verified-domain>`)
   - `SITE_URL` (https://deshimach.com)
5. Resend-এ sender domain verify এবং DNS records configure করুন. Resend থেকে বাস্তব delivery পরীক্ষা করুন.
6. `npm install`, `npm run dev` দিয়ে locally Netlify Dev চালাতে `.env` ব্যবহার করতে পারেন; `.env` কখনো commit করবেন না. Production deploy-এ Netlify UI-তে secrets যোগ করুন, তারপর deploy.
7. Static frontend integration (Supabase browser client/Auth login + API calls) хийхийн өмнө original design files-ийг repository-তে যোগ করুন. Frontend-এ কেবল Supabase URL ও anon key রাখা নিরাপদ; service-role/Resend secret নয়.

## Admin security
- Admin account public API দিয়ে তৈরি করা যায় না. Auth user allowlist `ADMIN_EMAIL`-এর সঙ্গে মিলিয়ে যাচাই হয়; প্রতিটি protected function verified Supabase access token চায়.
- Product/order mutation frontend থেকে সরাসরি database-এ নয়; functions service-role client ব্যবহার করে এবং নিজেই auth/validation/allowlist যাচাই করে. SQL-এ RLS enabled, public write policies নেই.
- Supabase Auth rate limiting, breached-password protection, email confirmation, CAPTCHA (public-facing auth), MFA এবং short session lifetime সেট করুন. Function token verification ছাড়া কোনো admin route চলবে না.
- Database API exposed হলে RLS-ই সুরক্ষা দেয়; service-role key কখনও browser-এ নয়.

## API summary
- `GET /api/products`: available products.
- `POST /api/orders`: validated checkout; database-এ order, line items এবং email outbox atomic ভাবে save হয়; server-side catalog price/stock authoritative.
- `POST /api/orders/track`: `{orderId, phone}` যাচাই করে শুধুমাত্র status/date/id ফেরত দেয়; customer details/items প্রকাশ করে না.
- Admin: `GET/POST /api/admin/products`, `PUT/DELETE /api/admin/products/:id`, `GET /api/admin/orders`, `PATCH /api/admin/orders/:id`, `POST /api/admin/orders/:id/retry-email`.

Email attempt ব্যর্থ হলে order অক্ষত থাকে এবং outbox row `failed` থাকে; admin-কে authenticated retry API দেওয়া আছে. Production operation-এ failed outbox scan/alert এবং retry endpoint-এর admin UI যোগ করুন.

## Important deployment note
বর্তমান repository-তে original storefront source file অনুপস্থিত. তাই frontend-এর visual parity, login UI, admin screens, mobile behavior, end-to-end ordering/email delivery এখানে verify করা সম্ভব হয়নি. Backend scaffold-কে “সম্পূর্ণ tested production site” বলা হচ্ছে না. Original HTML/CSS/JS যোগ ও frontend integration করার পরে staging-এ সব flows পরীক্ষা করে তবেই launch করুন.
