import { randomUUID } from 'node:crypto';
import type {
  BusinessReadiness, CreateBusinessInput, CreateBusinessResponse, CreateInvoiceInput, Invoice, MeResponse, PlatformIdentity,
} from './types.ts';

const TEST_KEY_PREFIX = 'oncade_platform_test_';

export class OncadeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} -> HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'OncadeApiError';
  }
}

export interface ClientOptions {
  apiKey: string;
  /** e.g. https://www.oncade.gg/api */
  baseUrl: string;
  /** Sent as X-Target-Business-Id. Required by most business-scoped endpoints. */
  businessId?: string;
  debug?: boolean;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Pass a stable key to make retries safe. Generated automatically for POST/PUT/PATCH. */
  idempotencyKey?: string;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH']);
// The API returns 400 for non-UUID Idempotency-Keys (not documented). Fail fast client-side instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal typed client for the Oncade Platform API (v1). */
export class OncadeClient {
  constructor(private readonly opts: ClientOptions) {
    // This PoC must never move live money: refuse anything but a test key, for every caller.
    if (!opts.apiKey.startsWith(TEST_KEY_PREFIX)) {
      throw new Error(`OncadeClient only accepts a test key (prefix ${TEST_KEY_PREFIX}). Refusing to run.`);
    }
  }

  /** Returns a client that acts on behalf of a business (X-Target-Business-Id). */
  forBusiness(businessId: string): OncadeClient {
    return new OncadeClient({ ...this.opts, businessId });
  }

  get businessId(): string | undefined {
    return this.opts.businessId;
  }

  async request<T>(method: string, path: string, { body, query, idempotencyKey }: RequestOptions = {}): Promise<T> {
    if (idempotencyKey !== undefined && !UUID_RE.test(idempotencyKey)) {
      throw new TypeError(`Idempotency-Key must be a UUID (Oncade rejects other formats), got "${idempotencyKey}"`);
    }
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'X-Oncade-API-Version': 'v1',
      Accept: 'application/json',
    };
    if (this.opts.businessId) headers['X-Target-Business-Id'] = this.opts.businessId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Getting-started: "an Idempotency-Key on every POST, PUT, and PATCH".
    if (MUTATING.has(method)) headers['Idempotency-Key'] = idempotencyKey ?? randomUUID();

    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body, keep text */ }

    if (this.opts.debug) {
      const shown = { ...headers, Authorization: 'Bearer ***' };
      console.debug(`[oncade] ${method} ${url.pathname}${url.search} -> ${res.status}`, { headers: shown, body, response: parsed });
    }
    if (!res.ok) throw new OncadeApiError(res.status, parsed, method, url.pathname);
    return parsed as T;
  }

  // --- Platform -----------------------------------------------------------
  /** Raw `GET /v1/platform/me`. Prefer `platform()`, which normalizes it. */
  me() {
    return this.request<MeResponse>('GET', '/v1/platform/me');
  }

  /**
   * Platform identity, normalized: hides the gap between the documented /me shape (top-level activeScopes)
   * and the real one (keyInfo.activeScopes + approvedScopes). `can(scope)` uses the effective scopes:
   * approved ∩ key. The business grant narrows them further server-side, so a 403 is still possible.
   */
  async platform(): Promise<PlatformIdentity> {
    const me = await this.me();
    const environment = me.keyInfo?.environment;
    if (environment && environment !== 'test') throw new Error(`Key reports environment "${environment}"; refusing a live platform`);
    const keyScopes = me.keyInfo?.activeScopes ?? me.activeScopes ?? [];
    const scopes = new Set(me.approvedScopes ? keyScopes.filter(s => me.approvedScopes!.includes(s)) : keyScopes);
    return {
      platformId: me.platformId ?? '',
      environment: environment ?? 'test',
      status: me.status,
      scopes,
      unapprovedKeyScopes: keyScopes.filter(s => !scopes.has(s)),
      can: (scope: string) => scopes.has(scope),
    };
  }

  // --- Businesses ---------------------------------------------------------
  createBusiness(input: CreateBusinessInput, idempotencyKey?: string) {
    return this.request<CreateBusinessResponse>('POST', '/v1/platform/business', { body: input, idempotencyKey });
  }
  getBusiness() {
    return this.request<Record<string, unknown>>('GET', '/v1/platform/business');
  }
  updateBusiness(patch: Partial<Pick<CreateBusinessInput, 'name' | 'logoUrl' | 'address' | 'payoutWallet' | 'invoiceRecipients'>>) {
    return this.request<Record<string, unknown>>('PATCH', '/v1/platform/business', { body: patch });
  }
  readiness() {
    return this.request<BusinessReadiness>('GET', '/v1/platform/business/readiness');
  }

  // --- Invoices -----------------------------------------------------------
  createInvoice(input: CreateInvoiceInput, idempotencyKey?: string) {
    return this.request<Invoice>('POST', '/v1/platform/invoices', { body: input, idempotencyKey });
  }
  getInvoice(invoiceId: string) {
    return this.request<Invoice>('GET', `/v1/platform/invoices/${encodeURIComponent(invoiceId)}`);
  }
  listInvoices(query: { page?: number; limit?: number; status?: string } = {}) {
    return this.request<{ invoices?: Invoice[]; pagination?: unknown }>('GET', '/v1/platform/invoices', { query });
  }
  sendInvoice(invoiceId: string, opts: { sendEmail?: boolean } = {}) {
    return this.request<Invoice & { emailSuppressed?: boolean }>(
      'POST', `/v1/platform/invoices/${encodeURIComponent(invoiceId)}/send`, { body: opts });
  }
  cancelInvoice(invoiceId: string) {
    return this.request<Invoice>('POST', `/v1/platform/invoices/${encodeURIComponent(invoiceId)}/cancel`, { body: {} });
  }
}
