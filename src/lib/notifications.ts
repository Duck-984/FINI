/**
 * Notification system — in-app + Telegram bot
 *
 * All notification sending goes through this module.
 * In-app: writes to `notifications` table (polled by client)
 * Telegram: calls send-message edge function
 */

import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Notification event types ─────────────────────────────────────────────────
export type NotificationEvent =
  | 'order_new'
  | 'order_processing'
  | 'order_assembling'
  | 'order_assembled'
  | 'order_shipping'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_cancelled'
  | 'return_received'
  | 'return_approved'
  | 'return_rejected'
  | 'return_refunded'
  | 'price_drop'
  | 'stock_available';

// ─── Message templates ────────────────────────────────────────────────────────
const TEMPLATES: Record<NotificationEvent, {
  title: (orderId?: string) => string;
  body: (orderId?: string, extra?: string) => string;
  telegram: (orderId?: string, extra?: string) => string;
}> = {
  order_new: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} принят`,
    body: () => 'Ваш заказ принят. Мы свяжемся с вами в ближайшее время.',
    telegram: (id) => `✅ Ваш заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> принят!\n\nМы свяжемся с вами в ближайшее время для подтверждения.`,
  },
  order_processing: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} в обработке`,
    body: () => 'Ваш заказ принят в обработку.',
    telegram: (id) => `⚙️ Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> принят в обработку.`,
  },
  order_assembling: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} собирается`,
    body: () => 'Ваш заказ комплектуется на складе.',
    telegram: (id) => `📦 Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> собирается на складе.`,
  },
  order_assembled: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} собран`,
    body: () => 'Ваш заказ готов к отправке.',
    telegram: (id) => `✅ Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> собран и готов к отправке!`,
  },
  order_shipping: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} передан курьеру`,
    body: () => 'Ваш заказ передан курьеру.',
    telegram: (id) => `🚚 Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> передан курьеру!\n\nОжидайте доставку.`,
  },
  order_shipped: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} отправлен`,
    body: () => 'Ваш заказ отправлен и скоро будет у вас.',
    telegram: (id) => `📬 Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> отправлен!\n\nСкоро будет у вас.`,
  },
  order_delivered: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} доставлен`,
    body: () => 'Ваш заказ доставлен. Спасибо за покупку! Если что-то не так — оформите возврат в течение 14 дней.',
    telegram: (id) => `🎉 Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> доставлен!\n\nСпасибо за покупку! Если что-то не так — вы можете оформить возврат в течение 14 дней.`,
  },
  order_cancelled: {
    title: (id) => `Заказ #${id?.slice(0, 8).toUpperCase()} отменён`,
    body: (_, reason) => `Ваш заказ отменён${reason ? `. Причина: ${reason}` : ''}. Если вы оплатили — средства вернутся в течение 3-5 рабочих дней.`,
    telegram: (id, reason) => `❌ Заказ <b>#${id?.slice(0, 8).toUpperCase()}</b> отменён.\n\n${reason ? `Причина: ${reason}\n\n` : ''}Если вы оплатили — средства вернутся в течение 3-5 рабочих дней. По вопросам свяжитесь с поддержкой.`,
  },
  return_received: {
    title: () => 'Заявка на возврат получена',
    body: () => 'Мы получили вашу заявку на возврат. Рассмотрим в течение 1-2 рабочих дней.',
    telegram: (id) => `📋 Заявка на возврат по заказу <b>#${id?.slice(0, 8).toUpperCase()}</b> получена.\n\nМы рассмотрим её в течение 1-2 рабочих дней.`,
  },
  return_approved: {
    title: () => 'Возврат одобрен',
    body: () => 'Ваша заявка на возврат одобрена. Скоро свяжемся для организации забора товара.',
    telegram: (id) => `✅ Возврат по заказу <b>#${id?.slice(0, 8).toUpperCase()}</b> одобрен!\n\nМы скоро свяжемся с вами для организации забора товара.`,
  },
  return_rejected: {
    title: () => 'Возврат отклонён',
    body: (_, reason) => `Ваша заявка на возврат отклонена${reason ? `. Причина: ${reason}` : ''}. Свяжитесь с поддержкой для уточнения.`,
    telegram: (id, reason) => `❌ Возврат по заказу <b>#${id?.slice(0, 8).toUpperCase()}</b> отклонён.\n\n${reason ? `Причина: ${reason}\n\n` : ''}По вопросам свяжитесь с поддержкой.`,
  },
  return_refunded: {
    title: () => 'Деньги возвращены',
    body: () => 'Средства успешно возвращены. Ожидайте поступления на счёт в течение 3-5 рабочих дней.',
    telegram: (id) => `💰 Возврат средств по заказу <b>#${id?.slice(0, 8).toUpperCase()}</b> выполнен!\n\nСредства поступят на ваш счёт в течение 3-5 рабочих дней.`,
  },
  price_drop: {
    title: (productName) => `Скидка на "${productName}"`,
    body: (productName) => `На товар "${productName}" из вашего вишлиста снизилась цена!`,
    telegram: (productName, newPrice) => `🔥 Цена на <b>${productName}</b> снизилась!\n\n💰 Новая цена: ${newPrice} сум\n\nУспейте купить!`,
  },
  stock_available: {
    title: (productName) => `"${productName}" снова в наличии`,
    body: (productName) => `Товар "${productName}" из вашего вишлиста снова в наличии!`,
    telegram: (productName) => `📦 <b>${productName}</b> снова в наличии!\n\nУспейте заказать!`,
  },
};

// ─── Send in-app notification (writes to DB) ──────────────────────────────────
export async function createInAppNotification(params: {
  telegramUserId: number;
  event: NotificationEvent;
  orderId?: string;
  extra?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const { telegramUserId, event, orderId, extra, data } = params;
  const template = TEMPLATES[event];
  if (!template) return;

  const title = template.title(orderId ?? extra);
  const body = template.body(orderId, extra);

  const { error } = await supabase.from('notifications').insert({
    telegram_user_id: telegramUserId,
    type: event,
    title,
    body,
    data: { order_id: orderId, ...data },
    is_read: false,
    notification_channel: 'in_app',
  });
  if (error) console.error('Notification error:', error);
}

// ─── Send Telegram message ────────────────────────────────────────────────────
export async function sendTelegramNotification(params: {
  telegramUserId: number;
  event: NotificationEvent;
  orderId?: string;
  extra?: string;
}): Promise<boolean> {
  if (!SUPABASE_URL || !ANON_KEY) return false;

  const { telegramUserId, event, orderId, extra } = params;
  const template = TEMPLATES[event];
  if (!template) return false;

  const message = template.telegram(orderId, extra);

  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANON_KEY}`,
        'Apikey': ANON_KEY,
      },
      body: JSON.stringify({
        telegram_user_id: telegramUserId,
        message,
        parse_mode: 'HTML',
      }),
    });
    const result = await resp.json();
    return result.success === true;
  } catch {
    return false;
  }
}

// ─── Send both in-app + Telegram ─────────────────────────────────────────────
export async function notifyClient(params: {
  telegramUserId: number;
  event: NotificationEvent;
  orderId?: string;
  extra?: string;
  channels?: ('in_app' | 'telegram')[];
  data?: Record<string, unknown>;
}): Promise<void> {
  const { channels = ['in_app', 'telegram'] } = params;

  const promises: Promise<unknown>[] = [];

  if (channels.includes('in_app')) {
    promises.push(createInAppNotification(params));
  }

  if (channels.includes('telegram')) {
    promises.push(sendTelegramNotification(params));
  }

  await Promise.allSettled(promises);
}

// ─── Order status → notification event mapping ────────────────────────────────
export function orderStatusToNotificationEvent(status: string): NotificationEvent | null {
  const map: Record<string, NotificationEvent> = {
    new:         'order_new',
    processing:  'order_processing',
    assembling:  'order_assembling',
    assembled:   'order_assembled',
    shipping:    'order_shipping',
    shipped:     'order_shipped',
    delivered:   'order_delivered',
    cancelled:   'order_cancelled',
  };
  return map[status] ?? null;
}
