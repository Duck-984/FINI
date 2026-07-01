
/*
# Step 1: Archive columns on orders + stock/product updates
Adds is_archived, is_visible_to_client, cancel_reason, cancelled_by, archive_reason, archived_at to orders.
Adds reserved_stock to products.
Creates decrement_stock_safe, restore_stock_for_order, cancel_order_by_client, create_order_with_stock, append_order_status functions.
Updates RLS so clients only see is_visible_to_client=true orders.
*/

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_archived           boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at           timestamptz,
  ADD COLUMN IF NOT EXISTS archive_reason        text,
  ADD COLUMN IF NOT EXISTS is_visible_to_client  boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cancelled_by          text,
  ADD COLUMN IF NOT EXISTS cancel_reason         text;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS reserved_stock integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_is_archived ON orders(is_archived);
CREATE INDEX IF NOT EXISTS idx_orders_is_visible  ON orders(is_visible_to_client);
CREATE INDEX IF NOT EXISTS idx_orders_tg_user     ON orders(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at  ON orders(created_at DESC);

CREATE OR REPLACE FUNCTION decrement_stock_safe(p_product_id uuid, p_quantity integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_available integer;
BEGIN
  SELECT stock INTO v_available FROM products WHERE id = p_product_id FOR UPDATE;
  IF v_available IS NULL OR v_available < p_quantity THEN RETURN false; END IF;
  UPDATE products SET stock = stock - p_quantity, updated_at = now() WHERE id = p_product_id;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION restore_stock_for_order(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_item record;
BEGIN
  FOR v_item IN
    SELECT (item->>'productId')::uuid AS product_id, (item->>'quantity')::integer AS quantity
    FROM orders, jsonb_array_elements(items::jsonb) AS item
    WHERE id = p_order_id
  LOOP
    IF v_item.product_id IS NOT NULL AND v_item.quantity > 0 THEN
      UPDATE products SET stock = GREATEST(0, stock + v_item.quantity), updated_at = now()
      WHERE id = v_item.product_id;
    END IF;
  END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION cancel_order_by_client(
  p_order_id uuid, p_telegram_user_id bigint, p_reason text DEFAULT 'Отменено клиентом'
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_order record;
BEGIN
  SELECT * INTO v_order FROM orders
  WHERE id = p_order_id AND telegram_user_id = p_telegram_user_id
    AND status NOT IN ('delivered','cancelled','returned','refunded');
  IF v_order IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Order not found or cannot be cancelled');
  END IF;
  UPDATE orders SET
    status = 'cancelled', is_archived = true, archived_at = now(),
    archive_reason = p_reason, is_visible_to_client = false,
    cancelled_by = 'client', cancel_reason = p_reason, updated_at = now(),
    status_history = COALESCE(status_history,'[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('status','cancelled','changed_at',now()::text,'changed_by','client','note',p_reason)
    )
  WHERE id = p_order_id;
  PERFORM restore_stock_for_order(p_order_id);
  RETURN json_build_object('success', true, 'order_id', p_order_id);
END; $$;

CREATE OR REPLACE FUNCTION create_order_with_stock(
  p_telegram_user_id bigint, p_items jsonb, p_total_amount numeric,
  p_customer_info jsonb, p_delivery_type text, p_delivery_cost numeric,
  p_payment_method text, p_notes text, p_coupon_id uuid,
  p_discount_amount numeric, p_status text DEFAULT 'new'
)
RETURNS orders LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_order orders; v_item jsonb; v_pid uuid; v_qty integer; v_ok boolean;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_pid := (v_item->>'productId')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    IF v_pid IS NOT NULL AND v_qty > 0 THEN
      SELECT decrement_stock_safe(v_pid, v_qty) INTO v_ok;
      IF NOT v_ok THEN RAISE EXCEPTION 'Insufficient stock for product %', v_pid; END IF;
    END IF;
  END LOOP;
  INSERT INTO orders (
    telegram_user_id, items, total_amount, customer_info, delivery_type,
    delivery_cost, payment_method, notes, coupon_id, discount_amount,
    status, status_history, is_archived, is_visible_to_client
  ) VALUES (
    p_telegram_user_id, p_items, p_total_amount, p_customer_info, p_delivery_type,
    p_delivery_cost, p_payment_method, p_notes, p_coupon_id, COALESCE(p_discount_amount,0),
    p_status,
    jsonb_build_array(jsonb_build_object('status',p_status,'changed_at',now()::text,'changed_by','system')),
    false, true
  ) RETURNING * INTO v_order;
  RETURN v_order;
END; $$;

CREATE OR REPLACE FUNCTION append_order_status(
  p_order_id uuid, p_status text, p_changed_by text DEFAULT 'admin', p_note text DEFAULT NULL
)
RETURNS orders LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_order orders;
BEGIN
  UPDATE orders SET
    status = p_status,
    status_history = COALESCE(status_history,'[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('status',p_status,'changed_at',now()::text,'changed_by',p_changed_by,'note',COALESCE(p_note,''))
    ),
    is_archived = CASE WHEN p_status IN ('cancelled','returned') THEN true ELSE is_archived END,
    archived_at = CASE WHEN p_status IN ('cancelled','returned') AND NOT is_archived THEN now() ELSE archived_at END,
    cancelled_by = CASE WHEN p_status = 'cancelled' THEN p_changed_by ELSE cancelled_by END,
    is_visible_to_client = CASE WHEN p_status IN ('cancelled','returned') THEN false ELSE is_visible_to_client END,
    updated_at = now()
  WHERE id = p_order_id RETURNING * INTO v_order;
  IF p_status = 'cancelled' THEN PERFORM restore_stock_for_order(p_order_id); END IF;
  RETURN v_order;
END; $$;

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_own_orders" ON orders;
CREATE POLICY "anon_select_own_orders" ON orders FOR SELECT TO anon, authenticated
  USING (is_visible_to_client = true);
DROP POLICY IF EXISTS "anon_insert_orders" ON orders;
CREATE POLICY "anon_insert_orders" ON orders FOR INSERT TO anon, authenticated
  WITH CHECK (true);
