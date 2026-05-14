import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import axios from 'axios';
import { getAuthConfig } from '../config/auth.config';

export interface EvoAuthUser {
  id: string;
  email: string;
  name: string;
  role?: { name?: string; permissions?: string[] };
  scopes?: string[];
}

/**
 * EvoAuthStrategy: passport-custom strategy that validates tokens via
 * evo-auth-service-community using `POST /api/v1/auth/validate`.
 *
 * Note: most requests in this app are validated by BearerAuthGuard (APP_GUARD).
 * This strategy is kept for routes that explicitly use AuthGuard('evo-auth').
 */
@Injectable()
export class EvoAuthStrategy extends PassportStrategy(Strategy, 'evo-auth') {
  constructor() {
    super();
  }

  async validate(req: Request): Promise<EvoAuthUser> {
    const authHeader = req.headers.authorization as string | undefined;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token required');
    }

    const config = getAuthConfig();
    const validationUrl = `${config.evoAuth.serviceUrl}${config.evoAuth.validateEndpoint}`;

    try {
      const response = await axios.post(
        validationUrl,
        {},
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        },
      );

      if (response.status === 200 && response.data) {
        const payload = response.data?.data ?? response.data;
        const user = payload?.user ?? payload;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          scopes: user.scopes,
        };
      }

      throw new UnauthorizedException('Token validation failed');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new UnauthorizedException('Invalid or expired token');
        }
        if (error.response?.status === 422) {
          throw new UnauthorizedException('expired');
        }
        if (error.code === 'ECONNREFUSED') {
          throw new UnauthorizedException('Auth service unavailable');
        }
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
