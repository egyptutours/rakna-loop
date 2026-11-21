/** Typed business errors. API routes translate `status` to an HTTP status and `code` to a localized message. */
export type DomainErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "report_expired"
  | "report_not_available"
  | "self_confirmation"
  | "not_claimer"
  | "already_confirmed"
  | "too_far"
  | "low_accuracy"
  | "outside_service_area"
  | "duplicate_report"
  | "daily_report_limit"
  | "insufficient_balance"
  | "reward_unavailable"
  | "reward_ineligible"
  | "partner_not_approved"
  | "space_not_bookable"
  | "outside_schedule"
  | "capacity_full"
  | "rate_limited"
  | "already_claimed_other"
  | "verification_required"
  | "waitlist_only"
  | "entitlement_invalid"
  | "buffer_conflict"
  | "outside_geofence"
  | "access_not_ready"
  | "payment_required"
  | "conflict";

const STATUS: Record<DomainErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  report_expired: 410,
  report_not_available: 409,
  self_confirmation: 403,
  not_claimer: 403,
  already_confirmed: 409,
  too_far: 422,
  low_accuracy: 422,
  outside_service_area: 422,
  duplicate_report: 409,
  daily_report_limit: 429,
  insufficient_balance: 422,
  reward_unavailable: 409,
  reward_ineligible: 403,
  partner_not_approved: 403,
  space_not_bookable: 409,
  outside_schedule: 422,
  capacity_full: 409,
  rate_limited: 429,
  already_claimed_other: 409,
  verification_required: 403,
  waitlist_only: 409,
  entitlement_invalid: 422,
  buffer_conflict: 409,
  outside_geofence: 422,
  access_not_ready: 425,
  payment_required: 402,
  conflict: 409,
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
