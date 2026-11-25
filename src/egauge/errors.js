// -----------------------------------------------------------------------------
// The errors of the meter. An EgaugeError message never holds the address,
// the user name, the password, the token, the serial number nor a text of the
// meter: it may be logged and shown.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  /** No TCP connection (refused, no route, DNS). */
  UNREACHABLE: 'unreachable',
  /** No complete answer within the deadline. */
  TIMEOUT: 'timeout',
  /** The session changed (a new configuration, a stop) before the request was written. */
  LATE: 'late',
  /** An answer above the size cap. */
  TOO_LARGE: 'too_large',
  /** Something answered, but not the eGauge WebAPI (another protocol, not JSON, wrong shape). */
  BAD_ANSWER: 'bad_answer',
  /** An HTTP status this code does not expect (`status`). */
  HTTP: 'http',
  /** HTTP 429: the meter asks to slow down (`retryAfter`, ms). */
  RATE_LIMITED: 'rate_limited',
  /** HTTP 5xx (`status`, `retryAfter`). */
  SERVER: 'server',
  /** The login was refused (user name or password): final until they change. */
  CREDENTIALS: 'credentials',
  /** A route refused with a token just obtained (not a refusal of the password). */
  ACCESS: 'access',
  /** A redirection: never followed. */
  REDIRECT: 'redirect',
  /** No certificate confirmed yet: nothing sent (`fingerprint` holds the one met). */
  CERTIFICATE_UNCONFIRMED: 'certificate_unconfirmed',
  /** The certificate is not the one confirmed (`fingerprint` holds the one met). */
  CERTIFICATE: 'certificate',
  /** The certificate is not the fingerprint typed in the configuration (`fingerprint`). */
  CERTIFICATE_TYPED: 'certificate_typed',
  /** A TLS handshake the meter refused. */
  TLS: 'tls',
});

export class EgaugeError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message safe to log
   * @param {{ notSent?: boolean, status?: number, retryAfter?: number, fingerprint?: string }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EgaugeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** The certificate failures: nothing is sent until the user acts (or the confirmed one comes back). */
export const isCertificate = (err) =>
  err?.code === CODES.CERTIFICATE ||
  err?.code === CODES.CERTIFICATE_TYPED ||
  err?.code === CODES.CERTIFICATE_UNCONFIRMED;
