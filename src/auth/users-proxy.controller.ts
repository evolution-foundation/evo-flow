import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Headers,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import axios from 'axios';
import { getAuthConfig } from './config/auth.config';

@ApiTags('Users Proxy')
@Controller('users-proxy')
export class UsersProxyController {
  @Get()
  @ApiOperation({ summary: 'Get users with pagination via EvoAuth service' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, description: 'Search term' })
  @ApiQuery({ name: 'sortBy', required: false, description: 'Sort field' })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    description: 'Sort order (ASC/DESC)',
  })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getUsers(
    @Headers() headers: Record<string, string>,
    @Query() queryParams: Record<string, any>,
  ) {
    const config = getAuthConfig();
    const usersUrl = `${config.evoAuth.serviceUrl}/api/v1/users`;

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
      const response = await axios.get(usersUrl, {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        params: queryParams,
        timeout: 10000,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const message = error.response?.data?.error || 'Failed to fetch users';

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

  @Get(':id')
  @ApiOperation({
    summary: 'Get user by ID with relations via EvoAuth service',
  })
  @ApiResponse({ status: 200, description: 'User retrieved successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUserById(
    @Headers() headers: Record<string, string>,
    @Param('id') userId: string,
  ) {
    const config = getAuthConfig();
    const userUrl = `${config.evoAuth.serviceUrl}/api/v1/users/${userId}`;

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
      const response = await axios.get(userUrl, {
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
        const message = error.response?.data?.error || 'Failed to fetch user';

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

  @Post()
  @ApiOperation({ summary: 'Create user via EvoAuth service' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  async createUser(
    @Headers() headers: Record<string, string>,
    @Body() userData: any,
  ) {
    const config = getAuthConfig();
    const usersUrl = `${config.evoAuth.serviceUrl}/api/v1/users`;

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
      const response = await axios.post(usersUrl, userData, {
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
        const message = error.response?.data?.error || 'Failed to create user';

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

  @Put(':id')
  @ApiOperation({ summary: 'Update user via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateUser(
    @Headers() headers: Record<string, string>,
    @Param('id') userId: string,
    @Body() userData: any,
  ) {
    const config = getAuthConfig();
    const userUrl = `${config.evoAuth.serviceUrl}/api/v1/users/${userId}`;

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
      const response = await axios.put(userUrl, userData, {
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
        const message = error.response?.data?.error || 'Failed to update user';

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

  @Delete(':id')
  @ApiOperation({ summary: 'Delete user via EvoAuth service' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteUser(
    @Headers() headers: Record<string, string>,
    @Param('id') userId: string,
  ) {
    const config = getAuthConfig();
    const userUrl = `${config.evoAuth.serviceUrl}/api/v1/users/${userId}`;

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
      const response = await axios.delete(userUrl, {
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
        const message = error.response?.data?.error || 'Failed to delete user';

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
