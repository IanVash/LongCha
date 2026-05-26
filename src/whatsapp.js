const DEFAULT_NOTIFY_STATUSES = ['Aceptado', 'Listo'];

function envList(name, fallback) {
  return String(process.env[name] || fallback.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const countryCode = String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '503').replace(/\D/g, '');
  if (countryCode && digits.length <= 9 && !digits.startsWith(countryCode)) {
    return `${countryCode}${digits}`;
  }
  return digits;
}

export function whatsappStatusMessage(order, business) {
  const businessName = business?.name || 'el negocio';
  const statusText = {
    Aceptado: 'fue aceptado y pronto empezaremos a prepararlo.',
    'En preparacion': 'esta en preparacion.',
    Listo: order.deliveryMethod?.slug === 'delivery'
      ? 'esta listo y pronto saldra a delivery.'
      : 'esta listo para retirar o entregar en local.',
    'En camino': 'va en camino.',
    Entregado: 'fue entregado. Gracias por tu compra.',
    Cancelado: 'fue cancelado. Si tienes dudas, escribenos.'
  }[order.status] || `cambio a estado: ${order.status}.`;

  return [
    `Hola ${order.customer.name},`,
    `tu pedido ${order.orderNumber} en ${businessName} ${statusText}`,
    `Total: $${Number(order.total || 0).toFixed(2)}`
  ].join('\n');
}

export function whatsappStatusUrl(order, business) {
  const phone = normalizePhone(order.customer?.phone);
  if (!phone) return '';
  return `https://wa.me/${phone}?text=${encodeURIComponent(whatsappStatusMessage(order, business))}`;
}

export function isWhatsAppCloudConfigured() {
  return Boolean(process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export async function sendWhatsAppStatus(order, business) {
  const enabled = String(process.env.WHATSAPP_AUTO_STATUS_UPDATES || 'false').toLowerCase() === 'true';
  const allowedStatuses = envList('WHATSAPP_NOTIFY_STATUSES', DEFAULT_NOTIFY_STATUSES);
  if (!enabled) return { sent: false, skipped: true, reason: 'disabled' };
  if (!allowedStatuses.includes(order.status)) return { sent: false, skipped: true, reason: 'status_not_enabled' };
  if (!isWhatsAppCloudConfigured()) return { sent: false, skipped: true, reason: 'missing_credentials' };

  const to = normalizePhone(order.customer?.phone);
  if (!to) return { sent: false, skipped: true, reason: 'missing_customer_phone' };

  const version = process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const endpoint = `${process.env.WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com'}/${version}/${phoneNumberId}/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: whatsappStatusMessage(order, business)
      }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      sent: false,
      skipped: false,
      reason: body.error?.message || `whatsapp_http_${response.status}`,
      response: body
    };
  }
  return { sent: true, skipped: false, response: body };
}
