
/*
# Step 2: Create missing tables — admin_accounts, audit_log, coupons, coupon_usage,
#          favorites, returns, notifications, bot_users, delivery_zones, banners (if not exists),
#          product_collections, broadcast_queue
*/

-- admin_accounts
CREATE TABLE IF NOT EXISTS admin_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text UNIQUE NOT NULL,
  first_name  text NOT NULL,
  role        text NOT NULL DEFAULT 'manager' CHECK (role IN ('admin','manager','viewer')),
  password_hash text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE admin_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_admin_accounts" ON admin_accounts;
CREATE POLICY "service_role_admin_accounts" ON admin_accounts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- audit_log
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  details     jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_audit_log" ON audit_log;
CREATE POLICY "service_role_audit_log" ON audit_log FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- coupons
CREATE TABLE IF NOT EXISTS coupons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text UNIQUE NOT NULL,
  discount_type   text NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed')),
  discount_value  numeric NOT NULL DEFAULT 0,
  min_order_amount numeric DEFAULT 0,
  max_uses        integer,
  used_count      integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,
  created_at      timestamptz DEFAULT now()
);
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_coupons" ON coupons;
CREATE POLICY "anon_select_coupons" ON coupons FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "service_all_coupons" ON coupons;
CREATE POLICY "service_all_coupons" ON coupons FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- coupon_usage
CREATE TABLE IF NOT EXISTS coupon_usage (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id        uuid REFERENCES coupons(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  order_id         uuid REFERENCES orders(id) ON DELETE CASCADE,
  created_at       timestamptz DEFAULT now()
);
ALTER TABLE coupon_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_coupon_usage" ON coupon_usage;
CREATE POLICY "anon_coupon_usage" ON coupon_usage FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- favorites
CREATE TABLE IF NOT EXISTS favorites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint NOT NULL,
  product_id       uuid REFERENCES products(id) ON DELETE CASCADE,
  created_at       timestamptz DEFAULT now(),
  UNIQUE(telegram_user_id, product_id)
);
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_favorites" ON favorites;
CREATE POLICY "anon_favorites" ON favorites FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(telegram_user_id);

-- returns
CREATE TABLE IF NOT EXISTS returns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason           text NOT NULL,
  photos           text[] DEFAULT '{}',
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','refunded')),
  admin_note       text,
  stock_restored   boolean NOT NULL DEFAULT false,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_returns" ON returns;
CREATE POLICY "anon_returns" ON returns FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_returns_order_id ON returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_user    ON returns(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_returns_status  ON returns(status);

-- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id     bigint NOT NULL,
  type                 text NOT NULL,
  title                text NOT NULL,
  body                 text NOT NULL,
  data                 jsonb DEFAULT '{}'::jsonb,
  is_read              boolean NOT NULL DEFAULT false,
  notification_channel text DEFAULT 'in_app',
  notification_sent_at timestamptz,
  created_at           timestamptz DEFAULT now()
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_notifications" ON notifications;
CREATE POLICY "anon_notifications" ON notifications FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(telegram_user_id, is_read) WHERE is_read = false;

-- bot_users
CREATE TABLE IF NOT EXISTS bot_users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id      bigint UNIQUE NOT NULL,
  first_name       text,
  username         text,
  language_code    text DEFAULT 'ru',
  is_subscribed    boolean NOT NULL DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
ALTER TABLE bot_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_bot_users" ON bot_users;
CREATE POLICY "anon_bot_users" ON bot_users FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- delivery_zones
CREATE TABLE IF NOT EXISTS delivery_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        jsonb NOT NULL DEFAULT '{"ru":"","uz":""}'::jsonb,
  cost        numeric NOT NULL DEFAULT 0,
  min_days    integer DEFAULT 1,
  max_days    integer DEFAULT 3,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_delivery_zones" ON delivery_zones;
CREATE POLICY "anon_delivery_zones" ON delivery_zones FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- banners (if not exists already)
CREATE TABLE IF NOT EXISTS banners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       jsonb DEFAULT '{"ru":"","uz":""}'::jsonb,
  subtitle    jsonb DEFAULT '{"ru":"","uz":""}'::jsonb,
  image_url   text NOT NULL,
  link        text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE banners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_banners" ON banners;
CREATE POLICY "anon_banners" ON banners FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- product_collections
CREATE TABLE IF NOT EXISTS product_collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        jsonb NOT NULL DEFAULT '{"ru":"","uz":""}'::jsonb,
  slug        text UNIQUE NOT NULL,
  image_url   text,
  product_ids uuid[] DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE product_collections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_collections" ON product_collections;
CREATE POLICY "anon_collections" ON product_collections FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- broadcast_queue
CREATE TABLE IF NOT EXISTS broadcast_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message          text NOT NULL,
  target_type      text NOT NULL DEFAULT 'all' CHECK (target_type IN ('all','segment')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  sent_count       integer DEFAULT 0,
  total_count      integer DEFAULT 0,
  created_at       timestamptz DEFAULT now(),
  processed_at     timestamptz
);
ALTER TABLE broadcast_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_broadcast_queue" ON broadcast_queue;
CREATE POLICY "anon_broadcast_queue" ON broadcast_queue FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
