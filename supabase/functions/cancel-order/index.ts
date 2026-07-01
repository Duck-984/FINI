import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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
    const { order_id, telegram_user_id, reason } = body;

    if (!order_id || !telegram_user_id) {
      return new Response(
        JSON.stringify({ error: "order_id and telegram_user_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify order belongs to this user and is cancellable
    const { data: order, error: fetchErr } = await supabase
      .from("orders")
      .select("id, status, items, telegram_user_id, total_amount")
      .eq("id", order_id)
      .eq("telegram_user_id", telegram_user_id)
      .maybeSingle();

    if (fetchErr || !order) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const nonCancellableStatuses = ["delivered", "cancelled", "returned", "refunded", "shipped"];
    if (nonCancellableStatuses.includes(order.status)) {
      return new Response(
        JSON.stringify({ error: `Cannot cancel order with status: ${order.status}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cancelReason = reason || "Отменено клиентом";

    // Update order: cancel + hide from client + archive
    const { error: updateErr } = await supabase
      .from("orders")
      .update({
        status: "cancelled",
        is_archived: true,
        archived_at: new Date().toISOString(),
        archive_reason: cancelReason,
        is_visible_to_client: false,
        cancelled_by: "client",
        cancel_reason: cancelReason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order_id);

    if (updateErr) {
      console.error("Cancel order update error:", updateErr);
      return new Response(
        JSON.stringify({ error: "Failed to cancel order" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Restore stock for each item
    const items = Array.isArray(order.items) ? order.items : [];
    for (const item of items as Array<{ productId?: string; quantity?: number }>) {
      if (item.productId && (item.quantity ?? 0) > 0) {
        await supabase
          .from("products")
          .update({
            stock: supabase.rpc("greatest", { a: 0, b: supabase.rpc("coalesce_stock", { product_id: item.productId }) }),
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.productId);

        // Direct stock increment using RPC if available, fallback to SQL
        await supabase.rpc("restore_stock_for_order", { p_order_id: order_id }).maybeSingle().catch(async () => {
          // Manual fallback
          const { data: product } = await supabase
            .from("products")
            .select("stock")
            .eq("id", item.productId)
            .maybeSingle();
          if (product) {
            await supabase
              .from("products")
              .update({ stock: (product.stock || 0) + (item.quantity || 0), updated_at: new Date().toISOString() })
              .eq("id", item.productId);
          }
        });

        break; // restore_stock_for_order handles all items in one call
      }
    }

    // Try calling restore_stock_for_order RPC (handles all items atomically)
    await supabase.rpc("restore_stock_for_order", { p_order_id: order_id }).maybeSingle().catch(() => {
      // RPC might not exist yet - handled above per-item
    });

    // Add status_history entry
    const { data: currentOrder } = await supabase
      .from("orders")
      .select("status_history")
      .eq("id", order_id)
      .maybeSingle();

    const history = Array.isArray(currentOrder?.status_history) ? currentOrder.status_history : [];
    await supabase
      .from("orders")
      .update({
        status_history: [
          ...history,
          {
            status: "cancelled",
            changed_at: new Date().toISOString(),
            changed_by: "client",
            note: cancelReason,
          },
        ],
      })
      .eq("id", order_id);

    // Send Telegram notification to admin bot
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const adminId = Deno.env.get("ADMIN_ID");
    if (botToken && adminId) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminId,
          text: `❌ <b>Заказ отменён клиентом</b>\n\n📦 #${order_id.slice(0, 8).toUpperCase()}\n👤 Telegram ID: ${telegram_user_id}\n💰 Сумма: ${order.total_amount} сум\n📝 Причина: ${cancelReason}`,
          parse_mode: "HTML",
        }),
      }).catch(() => {});
    }

    // Create in-app notification for the client
    await supabase.from("notifications").insert({
      telegram_user_id,
      type: "order_cancelled",
      title: `Заказ #${order_id.slice(0, 8).toUpperCase()} отменён`,
      body: `Ваш заказ отменён. Причина: ${cancelReason}`,
      data: { order_id, status: "cancelled" },
      notification_channel: "in_app",
    }).catch(() => {});

    // Send Telegram message to client
    if (botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegram_user_id,
          text: `✅ Ваш заказ <b>#${order_id.slice(0, 8).toUpperCase()}</b> отменён.\n\nПричина: ${cancelReason}\n\nЕсли у вас есть вопросы, свяжитесь с поддержкой.`,
          parse_mode: "HTML",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ success: true, order_id, status: "cancelled" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Cancel order error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
