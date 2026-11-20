// Shapes taken from https://pay.oncade.xyz/docs/api-reference/platform and the guides.
// Fields we don't rely on are left open with an index signature: the docs don't publish full schemas.

export interface MeResponse {
  platformId?: string;
  name?: string;
  status?: string;
  /** Scopes approved for the platform (not in the docs' example, but returned by the API). */
  approvedScopes?: string[];
  /** Docs show activeScopes at the top level; the API actually returns it under keyInfo. */
  keyInfo?: { keyId?: string; environment?: 'test' | 'live'; activeScopes?: string[]; [k: string]: unknown };
  activeScopes?: string[];
  pendingScopes?: string[];
  [k: string]: unknown;
}

/** Normalized result of GET /me. See GLOSSARY.md: Platform identity, Effective scopes. */
export interface PlatformIdentity {
  platformId: string;
  environment: 'test' | 'live';
  status?: string;
  /** Effective scopes: approvedScopes ∩ key activeScopes. */
  effectiveScopes: ReadonlySet<string>;
  /** Scopes on the key that the platform hasn't approved (FEEDBACK #13). */
  unapprovedKeyScopes: string[];
  can(scope: string): boolean;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
}

export interface BusinessMember {
  email: string;
  roles: Array<'admin' | 'game_editor' | 'viewer'>;
  isOwner?: boolean;
}

export interface CreateBusinessInput {
  name: string;
  members: BusinessMember[];
  address?: Address;
  logoUrl?: string;
  payoutWallet?: string;
  invoiceRecipients?: string[];
  /** Auto-grants this platform access. Must be a subset of the platform's approved scopes. */
  grantScopes?: string[];
}

export interface CreateBusinessResponse {
  business: { _id: string; name: string; [k: string]: unknown };
  members?: unknown[];
  grant?: { _id: string; grantedScopes: string[]; status: string };
  links?: { home?: string; kyb?: string; signIn?: string };
  [k: string]: unknown;
}

export interface BusinessReadiness {
  ready: boolean;
  steps?: Record<string, string>;
  links?: Record<string, string>;
  [k: string]: unknown;
}

export interface InvoiceItem {
  description: string;
  quantity: number;
  /** dollars */
  rate: number;
  /** dollars */
  amount: number;
}

export interface CreateInvoiceInput {
  receiverName?: string;
  receiverEmail?: string;
  recipientBusinessId?: string;
  /** ISO 8601 */
  date: string;
  dueDate?: string;
  payToTarget: 'BUSINESS';
  items: InvoiceItem[];
  invoiceNumber?: string;
  tax?: number;
  total?: number;
  note?: string;
  /** NOTE: `metadata` is rejected with 400 per the invoices guide; use externalMetadata. */
  externalMetadata?: Record<string, string>;
  status?: 'draft' | 'sent';
}

export type InvoiceStatus = 'draft' | 'sent' | 'processing' | 'paid' | 'cancelled';

export interface Invoice {
  _id: string;
  invoiceNumber?: string;
  total?: number;
  status: InvoiceStatus;
  paymentSummary?: { invoiceAmount?: number; payerFee?: number; totalCharged?: number };
  publicInvoiceId?: string;
  environment?: string;
  externalMetadata?: Record<string, string>;
  links?: { invoice?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface WebhookEvent<T = Record<string, unknown>> {
  event: string;
  data: T;
  /** Absent on User.Account.Link.* examples in the reference. */
  timestamp?: string;
}
