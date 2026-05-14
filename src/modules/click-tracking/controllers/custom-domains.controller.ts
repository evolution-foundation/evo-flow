import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { CustomDomainsService } from '../services/custom-domains.service';

/**
 * Custom Domains Controller
 * API for managing custom domains for short links
 */
@ApiTags('Custom Domains')
@Controller('custom-domains')
export class CustomDomainsController {
  constructor(
    private readonly customDomainsService: CustomDomainsService,
    private readonly cls: ClsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Register Custom Domain',
    description:
      'Register a new custom domain for short links (e.g., evolution-api.com)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          example: 'evolution-api.com',
          description: 'The custom domain to register',
        },
        targetCname: {
          type: 'string',
          example: 'redirect.evo.link',
          description:
            'Target CNAME hostname (optional). Must be a hostname only, not a URL. Defaults to "redirect.evo.link" in production or "localhost" in development.',
        },
      },
      required: ['domain'],
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Custom domain registered successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Domain already registered',
  })
  async createDomain(@Body() body: { domain: string; targetCname?: string }) {
    return await this.customDomainsService.create(
      body.domain,
      body.targetCname,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List Custom Domains',
    description: 'Get all custom domains for the account',
  })
  @ApiQuery({
    name: 'isVerified',
    required: false,
    description: 'Filter by verification status',
    type: 'boolean',
  })
  @ApiQuery({
    name: 'isActive',
    required: false,
    description: 'Filter by active status',
    type: 'boolean',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of results to return',
    type: 'number',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of results to skip',
    type: 'number',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Custom domains retrieved successfully',
  })
  async listDomains(
    @Query('isVerified') isVerified?: boolean,
    @Query('isActive') isActive?: boolean,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return await this.customDomainsService.findAll({
      isVerified,
      isActive,
      limit,
      offset,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get Custom Domain',
    description: 'Get a specific custom domain by ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Custom domain ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Custom domain retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Custom domain not found',
  })
  async getDomain(@Param('id') id: string) {
    return await this.customDomainsService.findById(id);
  }

  @Get(':id/dns-instructions')
  @ApiOperation({
    summary: 'Get DNS Setup Instructions',
    description: 'Get DNS records that need to be configured for the domain',
  })
  @ApiParam({
    name: 'id',
    description: 'Custom domain ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'DNS instructions retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        txtRecord: {
          type: 'object',
          properties: {
            name: { type: 'string', example: '_evo-verify.evolution-api.com' },
            value: { type: 'string', example: 'evo-verify-abc123...' },
          },
        },
        cnameRecord: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'evolution-api.com' },
            value: { type: 'string', example: 'redirect.evo.link' },
          },
        },
      },
    },
  })
  async getDnsInstructions(@Param('id') id: string) {
    const domain = await this.customDomainsService.findById(id);
    return this.customDomainsService.getDnsInstructions(domain);
  }

  @Post(':id/verify')
  @ApiOperation({
    summary: 'Verify Domain DNS',
    description:
      'Verify that DNS records are correctly configured and activate the domain',
  })
  @ApiParam({
    name: 'id',
    description: 'Custom domain ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Domain verified successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'DNS verification failed',
  })
  async verifyDomain(@Param('id') id: string) {
    return await this.customDomainsService.verifyDomain(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update Custom Domain',
    description: 'Update custom domain configuration',
  })
  @ApiParam({
    name: 'id',
    description: 'Custom domain ID (UUID)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        isActive: { type: 'boolean' },
        sslMode: { type: 'string', enum: ['auto', 'manual', 'none'] },
        metadata: { type: 'object' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Custom domain updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Custom domain not found',
  })
  async updateDomain(
    @Param('id') id: string,
    @Body() data: { isActive?: boolean; sslMode?: string; metadata?: any },
  ) {
    return await this.customDomainsService.update(id, data);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete Custom Domain',
    description: 'Delete a custom domain',
  })
  @ApiParam({
    name: 'id',
    description: 'Custom domain ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Custom domain deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Custom domain not found',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDomain(@Param('id') id: string) {
    await this.customDomainsService.delete(id);
  }
}
