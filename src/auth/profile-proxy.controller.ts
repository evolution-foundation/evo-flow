import {
  Controller,
  Get,
  Put,
  Body,
  Headers,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import axios from 'axios';
import { getAuthConfig } from './config/auth.config';

@ApiTags('Profile Proxy')
@Controller('profile')
export class ProfileProxyController {
  @Get()
  @ApiBearerAuth('Bearer')
  @ApiSecurity('api_access_token')
  @ApiOperation({ summary: 'Get user profile via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@Headers() headers: Record<string, string>) {
    const config = getAuthConfig();
    const profileUrl = `${config.evoAuth.serviceUrl}/api/v1/profile`;

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
      const response = await axios.get(profileUrl, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Failed to fetch profile';

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

  @Put()
  @ApiOperation({ summary: 'Update user profile via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  async updateProfile(
    @Headers() headers: Record<string, string>,
    @Body() profileData: any,
  ) {
    const config = getAuthConfig();
    const profileUrl = `${config.evoAuth.serviceUrl}/api/v1/profile`;

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
      const response = await axios.put(profileUrl, profileData, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Failed to update profile';

        return {
          success: false,
          error: message,
          status,
          validation_errors: error.response?.data?.validation_errors,
        };
      }

      return {
        success: false,
        error: 'Authentication service unavailable',
        status: 503,
      };
    }
  }

  @Put('avatar')
  @ApiOperation({ summary: 'Update user avatar via EvoAuth service' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 200, description: 'Avatar updated successfully' })
  @UseInterceptors(FileInterceptor('avatar'))
  async updateAvatar(
    @Headers() headers: Record<string, string>,
    @UploadedFile() file: any,
  ) {
    const config = getAuthConfig();
    const avatarUrl = `${config.evoAuth.serviceUrl}/api/v1/profile/avatar`;

    // Extract Bearer token from Authorization header
    const authHeader = headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return {
        success: false,
        error: 'Bearer token required',
        status: 401,
      };
    }

    if (!file) {
      return {
        success: false,
        error: 'No file uploaded',
        status: 400,
      };
    }

    try {
      const FormData = require('form-data');
      const formData = new FormData();
      formData.append('avatar', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });

      const response = await axios.put(avatarUrl, formData, {
        headers: {
          Authorization: authHeader,
          ...formData.getHeaders(),
        },
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Failed to update avatar';

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

  @Put('password')
  @ApiOperation({ summary: 'Change user password via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid password data' })
  async changePassword(
    @Headers() headers: Record<string, string>,
    @Body()
    passwordData: {
      current_password: string;
      password: string;
      password_confirmation: string;
    },
  ) {
    const config = getAuthConfig();
    const passwordUrl = `${config.evoAuth.serviceUrl}/api/v1/profile/password`;

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
      const response = await axios.put(passwordUrl, passwordData, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Failed to change password';

        return {
          success: false,
          error: message,
          status,
          validation_errors: error.response?.data?.validation_errors,
        };
      }

      return {
        success: false,
        error: 'Authentication service unavailable',
        status: 503,
      };
    }
  }

  @Get('notifications')
  @ApiOperation({ summary: 'Get user notification preferences' })
  @ApiResponse({
    status: 200,
    description: 'Notifications retrieved successfully',
  })
  async getNotifications(@Headers() headers: Record<string, string>) {
    const config = getAuthConfig();
    const notificationsUrl = `${config.evoAuth.serviceUrl}/api/v1/profile/notifications`;

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
      const response = await axios.get(notificationsUrl, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Failed to fetch notifications';

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

  @Put('notifications')
  @ApiOperation({ summary: 'Update user notification preferences' })
  @ApiResponse({
    status: 200,
    description: 'Notifications updated successfully',
  })
  async updateNotifications(
    @Headers() headers: Record<string, string>,
    @Body() notificationData: any,
  ) {
    const config = getAuthConfig();
    const notificationsUrl = `${config.evoAuth.serviceUrl}/api/v1/profile/notifications`;

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
      const response = await axios.put(notificationsUrl, notificationData, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message =
          error.response?.data?.error || 'Failed to update notifications';

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
