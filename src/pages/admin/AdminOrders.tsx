import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, ChevronDown, Clock, User, MapPin, Package, History,
  Inbox, Hourglass, Archive, Search, Filter, X, RotateCcw,
} from 'lucide-react';
import { supabase, type StatusHistoryEntry, type CustomerInfo, type OrderItem, Database } from '../../lib/supabase';
import { getCurrentAdmin, ROLE_LABELS } from '../../lib/auth';
import { formatPrice } from '../../lib/utils';
import { toast } from '../../components/Toast';
import { ORDER_STATUSES, getStatusInfo } from '../../lib/orderStatuses';
import { adminQueries } from '../../lib/adminApi';
import { auditLogQueries } from '../../lib/supabase/queries';

type Order = Database['public']['Tables']['orders']['Row'] & {
  is_archived?: boolean;
  archived_at?: string;
  archive_reason?: string;
  is_visible_to_client?: boolean;
  cancelled_by?: string;
  cancel_reason?: string;
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

const StatusBadge = ({ status }: { status: string }) => {
  const info = getStatusInfo(status);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${info.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${info.dot}`} />
      {info.label_ru}
    </span>
  );
};

type TabType = 'new' | 'active' | 'archive' | 'all';

export const AdminOrders = () => {
  const admin = getCurrentAdmin();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('new');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => { loadOrders(); }, []);

  const loadOrders = async () => {
    try {
      setLoading(true);
      // Admin sees ALL orders including archived via service_role (bypasses RLS)
      const data = await adminQueries.getOrders();
      setOrders((data ?? []) as Order[]);
    } catch {
      toast.error('Не удалось загрузить заказы.');
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (orderId: string, newStatus: string) => {
    if (updatingId) return;
    setUpdatingId(orderId);
    try {
      const updatedOrder = await adminQueries.updateOrderStatus(
        orderId, newStatus, admin?.first_name ?? 'Admin'
      );
      setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, ...updatedOrder } : o));
      toast.success(`Статус: ${getStatusInfo(newStatus).label_ru}`);

      auditLogQueries.log({
        admin_id: admin?.id ?? 'unknown',
        action: 'status_change',
        entity_type: 'orders',
        entity_id: orderId,
        details: { new_status: newStatus, admin_name: admin?.first_name },
      }).catch(() => {});

      // Send Telegram notification to client
      const order = orders.find((o) => o.id === orderId);
      if (order?.telegram_user_id) {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
        const STATUS_TEXTS: Record<string, string> = {
          processing: '⚙️ Ваш заказ принят в обработку',
          assembling: '📦 Ваш заказ собирается',
          assembled: '✅ Ваш заказ собран и готов к отправке',
          shipping: '🚚 Ваш заказ передан курьеру',
          shipped: '📬 Ваш заказ отправлен',
          delivered: '🎉 Ваш заказ доставлен! Спасибо за покупку!',
          cancelled: '❌ Ваш заказ отменён',
        };
        const text = STATUS_TEXTS[newStatus];
        if (text) {
          await fetch(`${supabaseUrl}/functions/v1/send-message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${anonKey}`,
              'Apikey': anonKey,
            },
            body: JSON.stringify({
              telegram_user_id: order.telegram_user_id,
              message: `${text}\n\n📋 Заказ <b>#${orderId.slice(0, 8).toUpperCase()}</b>`,
              parse_mode: 'HTML',
            }),
          }).catch(() => {});

          // Also create in-app notification
          const { error: notifInsertErr } = await supabase.from('notifications').insert({
            telegram_user_id: order.telegram_user_id,
            type: `order_${newStatus}`,
            title: `Заказ #${orderId.slice(0, 8).toUpperCase()}`,
            body: text.replace(/[🎉⚙️📦✅🚚📬❌]/g, '').trim(),
            data: { order_id: orderId, status: newStatus },
            notification_channel: 'both',
          });
          if (notifInsertErr) console.error('Notif error:', notifInsertErr);
        }
      }
    } catch {
      toast.error('Ошибка при обновлении статуса.');
    } finally {
      setUpdatingId(null);
    }
  };

  // Filter & search logic
  const { newOrders, activeOrders, archiveOrders, allOrders, counts } = useMemo(() => {
    let filtered = orders;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = orders.filter((o) => {
        const info = o.customer_info as CustomerInfo | null;
        const idMatch = o.id.toLowerCase().includes(q);
        const nameMatch = info?.name?.toLowerCase().includes(q);
        const phoneMatch = info?.phone?.toLowerCase().includes(q);
        const itemMatch = Array.isArray(o.items)
          ? (o.items as OrderItem[]).some((item) => {
              const n = typeof item.name === 'object' ? (item.name as { ru: string }).ru : item.name;
              return n?.toLowerCase().includes(q);
            })
          : false;
        return idMatch || nameMatch || phoneMatch || itemMatch;
      });
    }
    const newOrders = filtered.filter((o) => o.status === 'new');
    const activeOrders = filtered.filter((o) =>
      ['processing', 'assembling', 'assembled', 'shipping', 'paid', 'shipped'].includes(o.status ?? '')
    );
    const archiveOrders = filtered.filter((o) =>
      ['delivered', 'cancelled', 'returned', 'return_requested'].includes(o.status ?? '') ||
      (o as Order).is_archived
    );
    return {
      newOrders,
      activeOrders,
      archiveOrders,
      allOrders: filtered,
      counts: {
        new: newOrders.length,
        active: activeOrders.length,
        archive: archiveOrders.length,
        all: filtered.length,
      },
    };
  }, [orders, searchQuery]);

  const displayedOrders =
    activeTab === 'new' ? newOrders :
    activeTab === 'active' ? activeOrders :
    activeTab === 'archive' ? archiveOrders :
    allOrders;

  if (!admin) return null;

  const TABS: { key: TabType; label: string; icon: React.ReactNode }[] = [
    { key: 'new', label: 'Новые', icon: <Inbox className="w-4 h-4" /> },
    { key: 'active', label: 'В работе', icon: <Hourglass className="w-4 h-4" /> },
    { key: 'archive', label: 'Архив', icon: <Archive className="w-4 h-4" /> },
    { key: 'all', label: 'Все', icon: <Filter className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-surface-50 dark:bg-surface-900">
      <header className="sticky top-0 z-40 bg-white dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/admin/dashboard" className="p-2 rounded-lg text-surface-500 hover:text-surface-900 dark:hover:text-white hover:bg-surface-100 dark:hover:bg-surface-700 transition">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-lg font-bold text-surface-900 dark:text-white">Заказы</h1>
              <p className="text-xs text-surface-500 dark:text-surface-400">{orders.length} всего</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`p-2 rounded-lg transition ${showSearch ? 'bg-surface-900 text-white' : 'text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-700'}`}
            >
              <Search className="w-5 h-5" />
            </button>
            <div className="text-right hidden sm:block">
              <p className="text-sm font-semibold text-surface-900 dark:text-white leading-none">{admin.first_name}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                admin.role === 'admin'
                  ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                  : 'bg-surface-100 dark:bg-surface-700 text-surface-700 dark:text-surface-300'
              }`}>
                {ROLE_LABELS[admin.role]}
              </span>
            </div>
          </div>
        </div>

        {showSearch && (
          <div className="px-4 sm:px-6 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск по ID, клиенту, телефону, товару..."
                className="w-full pl-10 pr-10 py-2.5 bg-surface-50 dark:bg-surface-700 border border-surface-200 dark:border-surface-600 rounded-xl text-sm text-surface-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-surface-900"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-700">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* Tab Navigation */}
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-shrink-0 flex items-center gap-2 text-xs font-semibold px-4 py-2.5 rounded-xl transition ${
                activeTab === tab.key
                  ? 'bg-surface-900 dark:bg-white text-white dark:text-surface-900'
                  : 'bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
              }`}
            >
              {tab.icon}
              {tab.label}
              {counts[tab.key] > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  activeTab === tab.key ? 'bg-white/20 dark:bg-surface-900/20' : 'bg-surface-100 dark:bg-surface-700'
                }`}>
                  {counts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <span className="w-8 h-8 border-4 border-surface-900 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : displayedOrders.length === 0 ? (
          <div className="text-center py-20 text-surface-400 dark:text-surface-500 text-sm">
            {searchQuery ? `Ничего не найдено по запросу "${searchQuery}"` :
             activeTab === 'new' ? 'Новых заказов нет' :
             activeTab === 'active' ? 'Нет заказов в обработке' :
             activeTab === 'archive' ? 'Архив пуст' : 'Заказов нет'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {displayedOrders.map((order) => {
              const expanded = expandedId === order.id;
              const showHistory = historyId === order.id;
              const info = order.customer_info as CustomerInfo;
              const history: StatusHistoryEntry[] = Array.isArray(order.status_history)
                ? order.status_history : [];
              const isArchived = (order as Order).is_archived;

              return (
                <div key={order.id} className={`bg-white dark:bg-surface-800 rounded-2xl border shadow-sm overflow-hidden ${
                  isArchived
                    ? 'border-surface-300 dark:border-surface-600 opacity-80'
                    : 'border-surface-200 dark:border-surface-700'
                }`}>
                  {isArchived && (
                    <div className="px-5 py-1.5 bg-surface-100 dark:bg-surface-700 flex items-center gap-2">
                      <Archive className="w-3 h-3 text-surface-500" />
                      <span className="text-xs text-surface-500 dark:text-surface-400">
                        Архив{(order as Order).archive_reason ? ` · ${(order as Order).archive_reason}` : ''}
                        {(order as Order).cancelled_by ? ` · отменил: ${(order as Order).cancelled_by}` : ''}
                      </span>
                    </div>
                  )}

                  <div className="px-5 py-4">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div>
                            <p className="font-bold text-surface-900 dark:text-white text-sm">
                              #{order.id.slice(0, 8).toUpperCase()}
                            </p>
                            <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDate(order.created_at)}
                            </p>
                            {/* Client info summary */}
                            {info?.name && (
                              <p className="text-xs text-surface-400 mt-0.5 flex items-center gap-1">
                                <User className="w-3 h-3" />
                                {info.name}
                                {info.phone && ` · ${info.phone}`}
                              </p>
                            )}
                          </div>
                          <p className="text-xl font-bold text-surface-900 dark:text-white whitespace-nowrap">
                            {formatPrice(Number(order.total_amount))}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={order.status ?? 'new'} />

                          {!isArchived && (
                            <select
                              value={order.status ?? 'new'}
                              onChange={(e) => updateStatus(order.id, e.target.value)}
                              disabled={updatingId === order.id}
                              className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-700 text-surface-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-surface-900 cursor-pointer disabled:opacity-50"
                            >
                              {ORDER_STATUSES.map((s) => (
                                <option key={s.value} value={s.value}>{s.label_ru}</option>
                              ))}
                            </select>
                          )}

                          {order.payment_method && (
                            <span className="text-xs px-2.5 py-1 rounded-full bg-surface-100 dark:bg-surface-700 text-surface-600 dark:text-surface-400 font-medium">
                              {order.payment_method}
                            </span>
                          )}

                          {history.length > 0 && (
                            <button
                              onClick={() => setHistoryId(showHistory ? null : order.id)}
                              className="text-xs px-2.5 py-1 rounded-full bg-surface-100 dark:bg-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-600 font-medium flex items-center gap-1 transition"
                            >
                              <History className="w-3 h-3" />
                              История ({history.length})
                            </button>
                          )}
                        </div>
                      </div>

                      <button
                        onClick={() => setExpandedId(expanded ? null : order.id)}
                        className="p-2 rounded-lg text-surface-500 hover:text-surface-900 dark:hover:text-white hover:bg-surface-100 dark:hover:bg-surface-700 transition flex-shrink-0 mt-1"
                      >
                        <ChevronDown className={`w-5 h-5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {/* Status History */}
                  {showHistory && history.length > 0 && (
                    <div className="border-t border-surface-100 dark:border-surface-700 px-5 py-4 bg-surface-50/40 dark:bg-surface-700/10">
                      <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                        <History className="w-3.5 h-3.5" />
                        История изменений
                      </p>
                      <div className="space-y-2.5">
                        {[...history].reverse().map((entry: StatusHistoryEntry, i) => (
                          <div key={i} className="flex items-start gap-3">
                            <div className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${getStatusInfo(entry.status).dot}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-surface-900 dark:text-white">
                                  {getStatusInfo(entry.status).label_ru}
                                </span>
                                <span className="text-xs text-surface-500 dark:text-surface-400">
                                  — {entry.changed_by}
                                </span>
                              </div>
                              <p className="text-xs text-surface-400 dark:text-surface-500 mt-0.5">
                                {formatDate(entry.changed_at)}
                              </p>
                              {entry.note && (
                                <p className="text-xs text-surface-600 dark:text-surface-300 mt-0.5 italic">{entry.note}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Expanded Details */}
                  {expanded && (
                    <div className="border-t border-surface-100 dark:border-surface-700 px-5 py-4 bg-surface-50/50 dark:bg-surface-700/20 space-y-4">
                      {/* Customer info */}
                      {info && (
                        <div>
                          <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5" />
                            Покупатель
                          </p>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                            {info.name && (
                              <div>
                                <p className="text-xs text-surface-500 dark:text-surface-400">Имя</p>
                                <p className="font-medium text-surface-900 dark:text-white">{info.name}</p>
                              </div>
                            )}
                            {info.phone && (
                              <div>
                                <p className="text-xs text-surface-500 dark:text-surface-400">Телефон</p>
                                <p className="font-medium text-surface-900 dark:text-white">{info.phone}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Delivery address */}
                      {info && (info.city || info.address) && (
                        <div>
                          <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                            <MapPin className="w-3.5 h-3.5" />
                            Адрес
                          </p>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                            {info.city && (
                              <div>
                                <p className="text-xs text-surface-500 dark:text-surface-400">Город</p>
                                <p className="font-medium text-surface-900 dark:text-white">{info.city}</p>
                              </div>
                            )}
                            {info.address && (
                              <div>
                                <p className="text-xs text-surface-500 dark:text-surface-400">Адрес</p>
                                <p className="font-medium text-surface-900 dark:text-white">{info.address}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Items */}
                      {Array.isArray(order.items) && order.items.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                            <Package className="w-3.5 h-3.5" />
                            Товары
                          </p>
                          <div className="space-y-1.5">
                            {(order.items as OrderItem[]).map((item, i) => (
                              <div key={i} className="flex justify-between text-sm">
                                <span className="text-surface-700 dark:text-surface-300">
                                  {typeof item.name === 'object' ? (item.name as { ru: string }).ru : item.name ?? '—'}
                                  {item.size && <span className="text-surface-500"> / {item.size}</span>}
                                  {item.color && <span className="text-surface-500"> / {item.color}</span>}
                                  {' '}× {item.quantity}
                                </span>
                                <span className="font-semibold text-surface-900 dark:text-white ml-3 whitespace-nowrap">
                                  {formatPrice(Number(item.price) * Number(item.quantity))}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {Number(order.delivery_cost) > 0 && (
                        <div className="flex justify-between text-sm pt-2 border-t border-surface-200 dark:border-surface-600">
                          <span className="text-surface-500 dark:text-surface-400">Доставка</span>
                          <span className="font-medium text-surface-900 dark:text-white">
                            {formatPrice(Number(order.delivery_cost))}
                          </span>
                        </div>
                      )}

                      {order.notes && (
                        <div>
                          <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wide mb-1">
                            Примечание
                          </p>
                          <p className="text-sm text-surface-700 dark:text-surface-300">{order.notes}</p>
                        </div>
                      )}

                      {/* Archive info */}
                      {isArchived && (order as Order).archive_reason && (
                        <div className="bg-surface-100 dark:bg-surface-700 rounded-xl p-3">
                          <p className="text-xs font-semibold text-surface-500 dark:text-surface-400 mb-1 flex items-center gap-1">
                            <Archive className="w-3 h-3" />
                            Причина архивирования
                          </p>
                          <p className="text-sm text-surface-700 dark:text-surface-300">{(order as Order).archive_reason}</p>
                          {(order as Order).archived_at && (
                            <p className="text-xs text-surface-400 mt-1">{formatDate((order as Order).archived_at!)}</p>
                          )}
                        </div>
                      )}

                      {/* Cancel reason */}
                      {(order as Order).cancel_reason && (
                        <div className="bg-red-50 dark:bg-red-900/10 rounded-xl p-3">
                          <p className="text-xs font-semibold text-red-500 mb-1 flex items-center gap-1">
                            <RotateCcw className="w-3 h-3" />
                            Причина отмены {(order as Order).cancelled_by ? `(${(order as Order).cancelled_by})` : ''}
                          </p>
                          <p className="text-sm text-red-700 dark:text-red-300">{(order as Order).cancel_reason}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};
