import { Controller, Post, Get, Body, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from './decorators/public.decorator';
import axios from 'axios';
import { getAuthConfig } from './config/auth.config';

interface LoginRequest {
  email: string;
  password: string;
}

interface LoginResponse {
  data: {
    id: string;
    email: string;
    name: string;
    confirmed: boolean;
    accounts: Array<{
      id: string;
      name: string;
      role: string;
      permissions: string[];
    }>;
  };
}

@ApiTags('Authentication Proxy')
@Controller('auth-proxy')
export class AuthProxyController {
  @Post('login')
  @Public()
  @ApiOperation({ summary: 'Login via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginRequest: LoginRequest) {
    const config = getAuthConfig();
    // Use the Bearer token API endpoint
    const loginUrl = `${config.evoAuth.serviceUrl}/api/v1/auth/login`;

    try {
      const response = await axios.post(
        loginUrl,
        {
          email: loginRequest.email,
          password: loginRequest.password,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        },
      );

      // Return Bearer token response (simplified)
      return {
        success: true,
        data: {
          access_token: response.data.access_token,
          token_type: response.data.token_type || 'Bearer',
          user: response.data.user,
          accounts: response.data.accounts,
        },
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message = error.response?.data?.error || 'Login failed';

        return {
          success: false,
          error: message,
          status,
        };
      }

      return {
        success: false,
        error: 'Authentication service unavailable',
        status: 503,
      };
    }
  }

  @Post('logout')
  @Public()
  @ApiOperation({ summary: 'Logout via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  async logout(@Headers() headers: Record<string, string>) {
    const config = getAuthConfig();
    const logoutUrl = `${config.evoAuth.serviceUrl}/auth/sign_out`;

    try {
      await axios.delete(logoutUrl, {
        headers: {
          'access-token': headers['access-token'],
          client: headers['client'],
          uid: headers['uid'],
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      return {
        success: true,
        message: 'Logged out successfully',
      };
    } catch (error) {
      // Mesmo se falhar no backend, considerar logout local como sucesso
      return {
        success: true,
        message: 'Logged out locally',
      };
    }
  }

  @Get('me')
  @Public()
  @ApiOperation({ summary: 'Get current user via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'User data retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@Headers() headers: Record<string, string>) {
    const config = getAuthConfig();
    // Use the Bearer token API endpoint
    const meUrl = `${config.evoAuth.serviceUrl}/api/v1/auth/me`;

    // Extract Bearer token from Authorization header
    const authHeader = headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return {
        success: false,
        error: 'Bearer token required',
        status: 401,
      };
    }

    try {
      const response = await axios.get(meUrl, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      return {
        success: true,
        data: {
          user: response.data.user,
          accounts: response.data.accounts,
        },
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Token validation failed';

        return {
          success: false,
          error: message,
          status,
        };
      }

      return {
        success: false,
        error: 'Authentication service unavailable',
        status: 503,
      };
    }
  }
}
