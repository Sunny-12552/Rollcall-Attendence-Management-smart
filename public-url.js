import os from 'node:os';

function isLoopback(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

function getLanAddress(networkInterfaces = os.networkInterfaces()) {
  const interfaces = Object.entries(networkInterfaces);
  const wifiInterfaces = interfaces.filter(([name]) => /(^|[^a-z])(wi[\s-]?fi|wlan|wireless)([^a-z]|$)/i.test(name));
  const orderedInterfaces = [...wifiInterfaces, ...interfaces.filter(([name]) => !wifiInterfaces.some(([wifiName]) => wifiName === name))];
  for (const [, addresses] of orderedInterfaces) {
    for (const address of addresses || []) {
      if (
        address.family === 'IPv4'
        && !address.internal
        && !address.address.startsWith('169.254.')
        && address.address !== '0.0.0.0'
      ) {
        return address.address;
      }
    }
  }
  return '';
}

function replaceLoopbackHost(url, networkInterfaces) {
  if (!isLoopback(url.hostname)) return url;
  const address = getLanAddress(networkInterfaces);
  if (!address) {
    throw new Error('No LAN IPv4 address is available; set APP_URL to a phone-accessible address.');
  }
  url.hostname = address;
  return url;
}

function validateWebUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('APP_URL must use HTTP or HTTPS and include a host.');
  }
  return url;
}

function requestPublicUrl(req, { httpsEnabled, port, networkInterfaces }) {
  const forwardedProto = Array.isArray(req?.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req?.headers['x-forwarded-proto'];
  const forwardedHost = Array.isArray(req?.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req?.headers['x-forwarded-host'];
  const host = forwardedHost || req?.headers.host || `localhost:${port}`;
  let url;
  try {
    url = new URL(`${forwardedProto || (httpsEnabled ? 'https' : 'http')}://${host}`);
  } catch (error) {
    throw new Error('The request host is invalid; set APP_URL to a phone-accessible HTTP or HTTPS URL.', { cause: error });
  }
  validateWebUrl(url);
  replaceLoopbackHost(url, networkInterfaces);
  return url.toString().replace(/\/$/, '');
}

export function resolvePublicUrl(req, {
  configuredUrl = '',
  httpsEnabled = false,
  port = 3000,
  networkInterfaces
} = {}) {
  const configured = String(configuredUrl || '').trim();
  if (configured) {
    let configuredUrlObject;
    try {
      configuredUrlObject = new URL(configured);
    } catch (error) {
      throw new Error('APP_URL must be a valid absolute URL.', { cause: error });
    }
    validateWebUrl(configuredUrlObject);
    if (isLoopback(configuredUrlObject.hostname) && req) {
      const forwardedHost = Array.isArray(req.headers['x-forwarded-host'])
        ? req.headers['x-forwarded-host'][0]
        : req.headers['x-forwarded-host'];
      const requestHost = forwardedHost || req.headers.host;
      if (requestHost) {
        try {
          const requestUrl = new URL(`${req.headers['x-forwarded-proto'] || configuredUrlObject.protocol.slice(0, -1)}://${requestHost}`);
          if (!isLoopback(requestUrl.hostname)) {
            return validateWebUrl(requestUrl).toString().replace(/\/$/, '');
          }
        } catch (error) {
          throw new Error('The request host is invalid; set APP_URL to a phone-accessible HTTP or HTTPS URL.', { cause: error });
        }
      }
    }
    return replaceLoopbackHost(configuredUrlObject, networkInterfaces).toString().replace(/\/$/, '');
  }
  return requestPublicUrl(req, { httpsEnabled, port, networkInterfaces });
}
