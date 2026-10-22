import type {} from '../types/express.js';
import { Request, Response, NextFunction } from 'express';
import { auth } from '../auth/auth.js';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import { isRole, hasRole, Role } from '../auth/roles.js';
import { db } from '../db/index.js';
import { partners } from '../db/schema/index.js';
import { apiError } from '../http/responses.js';

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) return res.status(401).json(apiError('UNAUTHORIZED', 'Authentication is required'));
  if (!isRole(session.user.role)) return res.status(403).json(apiError('INVALID_ROLE', 'Account role is invalid'));
  req.user = { id: session.user.id, role: session.user.role };
  next();
};

export const requireRole = (...allowedRoles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json(apiError('UNAUTHORIZED', 'Authentication is required'));
    if (!hasRole(req.user.role, allowedRoles)) return res.status(403).json(apiError('FORBIDDEN', 'You do not have permission to perform this action'));
    next();
  };
};

export const requireApprovedPartner = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json(apiError('UNAUTHORIZED', 'Authentication is required'));
  if (req.user.role !== 'supplier' && req.user.role !== 'shipping') {
    return res.status(403).json(apiError('FORBIDDEN', 'An approved partner role is required'));
  }

  const [partner] = await db.select({ id: partners.id, status: partners.status, partnerType: partners.partnerType })
    .from(partners)
    .where(eq(partners.userId, req.user.id));
  if (!partner || partner.status !== 'approved' || partner.partnerType !== req.user.role) {
    return res.status(403).json(apiError('PARTNER_NOT_APPROVED', 'An approved, active partner account is required'));
  }

  req.partnerId = partner.id;
  next();
};

export const requirePartnerAccount = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json(apiError('UNAUTHORIZED', 'Authentication is required'));
  const [partner] = await db.select({ id: partners.id, status: partners.status })
    .from(partners)
    .where(eq(partners.userId, req.user.id));
  if (!partner || partner.status === 'suspended') {
    return res.status(403).json(apiError('PARTNER_NOT_ACTIVE', 'An active partner application is required'));
  }
  req.partnerId = partner.id;
  next();
};
