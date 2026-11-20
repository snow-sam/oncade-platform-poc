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

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);
// The API returns 400 for non-UUID Idempotency-Keys (not documented). Fail fast client-side instead.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal typed client for the Oncade Platform API (v1). */
export class OncadeClient {
  constructor(private readonly options: ClientOptions) {
    // This PoC must never move live money: refuse anything but a test key, for every caller.
    if (!options.apiKey.startsWith(TEST_KEY_PREFIX)) {
      throw new Error(`OncadeClient only accepts a test key (prefix ${TEST_KEY_PREFIX}). Refusing to run.`);
    }
  }

  /** Returns a client that acts on behalf of a business (X-Target-Business-Id). */
  forBusiness(businessId: string): OncadeClient {
    return new OncadeClient({ ...this.options, businessId });
  }

  get businessId(): string | undefined {
    return this.options.businessId;
  }

  async request<T>(method: string, path: string, { body, query, idempotencyKey }: RequestOptions = {}): Promise<T> {
    if (idempotencyKey !== undefined && !UUID_PATTERN.test(idempotencyKey)) {
      throw new TypeError(`Idempotency-Key must be a UUID (Oncade rejects other formats), got "${idempotencyKey}"`);
    }
    const url = new URL(this.options.baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'X-Oncade-API-Version': 'v1',
      Accept: 'application/json',
    };
    if (this.options.businessId) headers['X-Target-Business-Id'] = this.options.businessId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Getting-started: "an Idempotency-Key on every POST, PUT, and PATCH".
    if (MUTATING_METHODS.has(method)) headers['Idempotency-Key'] = idempotencyKey ?? randomUUID();

    const fetchFn = this.options.fetchImpl ?? fetch;
    const response = await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const responseText = await response.text();
    let responseBody: unknown = responseText;
    try { responseBody = responseText ? JSON.parse(responseText) : undefined; } catch { /* non-JSON body, keep text */ }

    if (this.options.debug) {
      const redactedHeaders = { ...headers, Authorization: 'Bearer ***' };
      console.debug(`[oncade] ${method} ${url.pathname}${url.search} -> ${response.status}`,
        { headers: redactedHeaders, body, response: responseBody });
    }
    if (!response.ok) throw new OncadeApiError(response.status, responseBody, method, url.pathname);
    return responseBody as T;
  }

  // --- Platform -----------------------------------------------------------
  /**
   * Platform identity (see GLOSSARY.md), normalized from `GET /v1/platform/me`. It hides the gap between the
   * documented shape (top-level activeScopes) and the real one (keyInfo.activeScopes + approvedScopes).
   * `can(scope)` checks the effective scopes: approved ∩ key. The business grant narrows them further on the server,
   * so a 403 is still possible. Throws if the key reports a live environment.
   */
  async getPlatformIdentity(): Promise<PlatformIdentity> {
    const me = await this.getMe();
    const environment = me.keyInfo?.environment;
    if (environment && environment !== 'test') throw new Error(`Key reports environment "${environment}"; refusing a live platform`);
    const keyScopes = me.keyInfo?.activeScopes ?? me.activeScopes ?? [];
    const approvedScopes = me.approvedScopes;
    const effectiveScopes = new Set(approvedScopes ? keyScopes.filter(scope => approvedScopes.includes(scope)) : keyScopes);
    return {
      platformId: me.platformId ?? '',
      environment: environment ?? 'test',
      status: me.status,
      effectiveScopes,
      unapprovedKeyScopes: keyScopes.filter(scope => !effectiveScopes.has(scope)),
      can: (scope: string) => effectiveScopes.has(scope),
    };
  }

  /** Raw `GET /v1/platform/me`. Callers use getPlatformIdentity(), which normalizes it. */
  private getMe() {
    return this.request<MeResponse>('GET', '/v1/platform/me');
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
  getReadiness() {
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
  sendInvoice(invoiceId: string, options: { sendEmail?: boolean } = {}) {
    return this.request<Invoice & { emailSuppressed?: boolean }>(
      'POST', `/v1/platform/invoices/${encodeURIComponent(invoiceId)}/send`, { body: options });
  }
  cancelInvoice(invoiceId: string) {
    return this.request<Invoice>('POST', `/v1/platform/invoices/${encodeURIComponent(invoiceId)}/cancel`, { body: {} });
  }
}
