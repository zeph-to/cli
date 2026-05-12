export class ZephError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ZephError';
    this.code = code;
    this.status = status;
  }
}

export class AuthenticationError extends ZephError {
  constructor(message = 'Authentication failed') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class QuotaExceededError extends ZephError {
  constructor(message = 'Quota exceeded') {
    super(message, 'QUOTA_EXCEEDED', 403);
    this.name = 'QuotaExceededError';
  }
}
