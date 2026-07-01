import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const ALLOWED_TABLES = [
  "products", "categories", "orders", "users", "banners",
  "delivery_zones", "coupons", "coupon_usage", "returns",
  "reviews", "audit_log", "admin_accounts", "product_collections",
  "promotions", "favorites", "notifications", "product_relations",
  "referrals",
];

// Tables that only require read (no session needed for SELECT)
// ALL mutations require a valid admin session token
const MUTATION_ACTIONS = ["insert", "update", "delete", "updateOrderStatus"];

async function hashToken(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyAdminSession(
  supabase: ReturnType<typeof createClient>,
  admin_session: { admin_id: string; token: string } | undefined
): Promise<{ ok: boolean; error?: string }> {
  if (!admin_session?.admin_id || !admin_session?.token) {
    return { ok: false, error: "Admin session required" };
  }
  const tokenHash = await hashToken(admin_session.token);
  const { data } = await supabase
    .from("admin_accounts")
    .select("id, is_active")
    .eq("id", admin_session.admin_id)
    .eq("session_token", tokenHash)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) {
    return { ok: false, error: "Invalid or expired admin session" };
  }
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { action, table, data, filters, id, admin_session } = body;

    if (!action || !table) {
      return new Response(
        JSON.stringify({ error: "Missing action or table" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!ALLOWED_TABLES.includes(table)) {
      return new Response(
        JSON.stringify({ error: "Table not allowed" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ALL mutation actions require a valid admin session
    if (MUTATION_ACTIONS.includes(action)) {
      const check = await verifyAdminSession(supabase, admin_session);
      if (!check.ok) {
        return new Response(
          JSON.stringify({ error: check.error }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let result;

    switch (action) {
      case "select": {
        let query = supabase.from(table).select(data || "*");
        if (filters) {
          for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
              query = query.eq(key, value as string);
            }
          }
        }
        if (table === "orders") {
          query = query.order("created_at", { ascending: false }).range(0, 499);
        } else if (table === "audit_log") {
          query = query.order("created_at", { ascending: false }).limit(200);
        } else {
          query = query.order("created_at", { ascending: false }).range(0, 499);
        }
        const { data: rows, error } = await query;
        if (error) throw error;
        result = rows;
        break;
      }

      case "insert": {
        const { data: inserted, error } = await supabase
          .from(table)
          .insert(data)
          .select()
          .single();
        if (error) throw error;
        result = inserted;
        break;
      }

      case "update": {
        if (id === "__bulk__" && filters) {
          let query = supabase
            .from(table)
            .update({ ...data, updated_at: new Date().toISOString() });
          for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
              query = query.eq(key, value as string);
            }
          }
          const { error } = await query;
          if (error) throw error;
          result = { success: true };
        } else {
          if (!id) throw new Error("ID required for update");
          const { error } = await supabase
            .from(table)
            .update({ ...data, updated_at: new Date().toISOString() })
            .eq("id", id);
          if (error) throw error;
          result = { success: true };
        }
        break;
      }

      case "delete": {
        if (id === "__filter__" && filters) {
          let query = supabase.from(table).delete();
          for (const [key, value] of Object.entries(filters)) {
            if (value !== undefined && value !== null) {
              query = query.eq(key, value as string);
            }
          }
          const { error } = await query;
          if (error) throw error;
        } else {
          if (!id) throw new Error("ID required for delete");
          const { error } = await supabase.from(table).delete().eq("id", id);
          if (error) throw error;
        }
        result = { success: true };
        break;
      }

      case "updateOrderStatus": {
        if (!id) throw new Error("ID required");
        const { status, changed_by, note } = data;
        const { data: order, error: fetchErr } = await supabase
          .from("orders")
          .select("status_history, telegram_user_id, total_amount")
          .eq("id", id)
          .maybeSingle();
        if (fetchErr) throw fetchErr;

        const history = Array.isArray(order?.status_history) ? order.status_history : [];
        const newEntry = {
          status,
          changed_at: new Date().toISOString(),
          changed_by: changed_by || "Admin",
          note: note || "",
        };

        // Auto-archive cancelled/returned orders + hide from client
        const archiveStatuses = ["cancelled", "returned"];
        const isArchiving = archiveStatuses.includes(status);

        const { data: updatedOrder, error: updateErr } = await supabase
          .from("orders")
          .update({
            status,
            status_history: [...history, newEntry],
            updated_at: new Date().toISOString(),
            ...(isArchiving ? {
              is_archived: true,
              archived_at: new Date().toISOString(),
              archive_reason: note || `Статус изменён на: ${status}`,
              is_visible_to_client: false,
              cancelled_by: changed_by || "admin",
            } : {}),
          })
          .eq("id", id)
          .select()
          .single();
        if (updateErr) throw updateErr;

        // Restore stock on cancellation by admin
        if (status === "cancelled") {
          await supabase.rpc("restore_stock_for_order", { p_order_id: id }).maybeSingle().catch(() => {});
        }

        // Send in-app + Telegram notifications to client
        if (order?.telegram_user_id) {
          const NOTIF_TEXTS: Record<string, { title: string; body: string; telegram: string }> = {
            new:              { title: "Заказ принят",              body: "Ваш заказ принят. Мы свяжемся с вами.",                    telegram: "✅ Ваш заказ принят! Мы свяжемся с вами в ближайшее время." },
            processing:       { title: "Заказ в обработке",         body: "Ваш заказ принят в обработку.",                              telegram: "⚙️ Ваш заказ принят в обработку." },
            assembling:       { title: "Заказ собирается",          body: "Ваш заказ комплектуется на складе.",                         telegram: "📦 Ваш заказ собирается на складе." },
            assembled:        { title: "Заказ собран",              body: "Ваш заказ готов к отправке.",                               telegram: "✅ Ваш заказ собран и готов к отправке!" },
            shipping:         { title: "Заказ передан курьеру",     body: "Ваш заказ в пути.",                                          telegram: "🚚 Ваш заказ передан курьеру! Ожидайте доставку." },
            shipped:          { title: "Заказ отправлен",           body: "Ваш заказ отправлен.",                                       telegram: "📬 Ваш заказ отправлен! Скоро будет у вас." },
            delivered:        { title: "Заказ доставлен",           body: "Ваш заказ доставлен! Спасибо за покупку!",                  telegram: "🎉 Ваш заказ доставлен! Спасибо за покупку! Если что-то не так — оформите возврат в течение 14 дней." },
            cancelled:        { title: "Заказ отменён",             body: `Ваш заказ отменён${note ? `. Причина: ${note}` : ""}.`,     telegram: `❌ Ваш заказ отменён.${note ? `\n\nПричина: ${note}` : ""}\n\nЕсли вы оплатили — средства вернутся в течение 3-5 рабочих дней.` },
            return_requested: { title: "Заявка на возврат получена",body: "Мы получили вашу заявку на возврат.",                        telegram: "📋 Ваша заявка на возврат получена. Рассмотрим в течение 1-2 рабочих дней." },
          };

          const notif = NOTIF_TEXTS[status];
          if (notif) {
            // In-app notification
            await supabase.from("notifications").insert({
              telegram_user_id: order.telegram_user_id,
              type: `order_${status}`,
              title: `${notif.title} #${id.slice(0, 8).toUpperCase()}`,
              body: notif.body,
              data: { order_id: id, status },
              notification_channel: "both",
            }).catch(() => {});

            // Telegram message via send-message edge function
            const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
            if (botToken) {
              await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: order.telegram_user_id,
                  text: `${notif.telegram}\n\n📋 Заказ <b>#${id.slice(0, 8).toUpperCase()}</b>`,
                  parse_mode: "HTML",
                }),
              }).catch(() => {});
            }
          }
        }

        result = updatedOrder;
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return new Response(
      JSON.stringify({ success: true, data: result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Admin API error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
