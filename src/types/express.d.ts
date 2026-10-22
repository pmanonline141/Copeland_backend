import type { Role } from '../auth/roles.js';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
      partnerId?: string;
    }
  }
}

export {};
