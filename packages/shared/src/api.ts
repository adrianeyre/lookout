export interface LoginRequest {
  password: string;
}

export interface ApiError {
  error: string;
}

export interface SessionInfo {
  authenticated: true;
}

export interface DockerStatus {
  available: boolean;
}
