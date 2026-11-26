export interface LoginRequest {
  password: string;
}

export interface ApiError {
  error: string;
}

export interface SessionInfo {
  authenticated: true;
  /** Whether the password can be changed in Settings (LOOKOUT_DATA_DIR is set). */
  passwordChangeable: boolean;
}

/** POST /api/password: change the login password, from Settings. */
export interface PasswordChange {
  currentPassword: string;
  newPassword: string;
}

/** The shortest password Settings or `hash-password` accepts. */
export const MIN_PASSWORD_LENGTH = 8;

export interface DockerStatus {
  available: boolean;
}
