/**
 * Os data centers da Zoho (cada um com os seus endereços de contas, de API e do Mail). A volta do login diz o da conta
 * (`accounts-server`), e ele só é aceito se estiver nesta lista: a troca do código leva o segredo do app, e um endereço
 * inventado na volta o mandaria para outro lugar. Referência: Zoho Accounts, "Multi DC support" (OAuth 2.0).
 */
export type ZohoDc = 'com' | 'eu' | 'in' | 'com.au' | 'jp' | 'ca' | 'sa' | 'uk' | 'com.cn';
export const ZOHO_DCS: Record<ZohoDc, { accounts: string; api: string; mail: string; crm: string; books: string }> = {
  com: { accounts: 'accounts.zoho.com', api: 'www.zohoapis.com', mail: 'mail.zoho.com', crm: 'crm.zoho.com', books: 'books.zoho.com' },
  eu: { accounts: 'accounts.zoho.eu', api: 'www.zohoapis.eu', mail: 'mail.zoho.eu', crm: 'crm.zoho.eu', books: 'books.zoho.eu' },
  in: { accounts: 'accounts.zoho.in', api: 'www.zohoapis.in', mail: 'mail.zoho.in', crm: 'crm.zoho.in', books: 'books.zoho.in' },
  'com.au': { accounts: 'accounts.zoho.com.au', api: 'www.zohoapis.com.au', mail: 'mail.zoho.com.au', crm: 'crm.zoho.com.au', books: 'books.zoho.com.au' },
  jp: { accounts: 'accounts.zoho.jp', api: 'www.zohoapis.jp', mail: 'mail.zoho.jp', crm: 'crm.zoho.jp', books: 'books.zoho.jp' },
  ca: { accounts: 'accounts.zohocloud.ca', api: 'www.zohoapis.ca', mail: 'mail.zohocloud.ca', crm: 'crm.zohocloud.ca', books: 'books.zohocloud.ca' },
  sa: { accounts: 'accounts.zoho.sa', api: 'www.zohoapis.sa', mail: 'mail.zoho.sa', crm: 'crm.zoho.sa', books: 'books.zoho.sa' },
  uk: { accounts: 'accounts.zoho.uk', api: 'www.zohoapis.uk', mail: 'mail.zoho.uk', crm: 'crm.zoho.uk', books: 'books.zoho.uk' },
  'com.cn': { accounts: 'accounts.zoho.com.cn', api: 'www.zohoapis.com.cn', mail: 'mail.zoho.com.cn', crm: 'crm.zoho.com.cn', books: 'books.zoho.com.cn' },
};
export const ehZohoDc = (x: unknown): x is ZohoDc => typeof x === 'string' && Object.prototype.hasOwnProperty.call(ZOHO_DCS, x);
/** O data center pelo `accounts-server` da volta do login (só os da lista; qualquer outro é recusado). */
export function zohoDcDoServidor(servidor: string | null | undefined): ZohoDc | null {
  if (!servidor) return null;
  let host: string;
  try { const u = new URL(servidor); if (u.protocol !== 'https:' || u.port || u.pathname.replace(/\/+$/, '') !== '' || u.search || u.username) return null; host = u.hostname.toLowerCase(); } catch { return null; }
  return (Object.entries(ZOHO_DCS) as Array<[ZohoDc, { accounts: string }]>).find(([, d]) => d.accounts === host)?.[0] ?? null;
}
