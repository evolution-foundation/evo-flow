import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  NotFoundException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { ClickProcessorService } from '../services';
import { CustomDomainsService } from '../services/custom-domains.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * Redirect Controller
 * PUBLIC endpoint for short link redirects
 * No authentication required - this is the main entry point for users clicking links
 */
@ApiTags('Link Redirect')
@Controller('link')
@Public()
export class RedirectController {
  private readonly logger = new CustomLoggerService(RedirectController.name);
  private readonly baseDomain =
    process.env.SHORT_URL_BASE_DOMAIN || 'https://evo.link';

  constructor(
    private readonly clickProcessorService: ClickProcessorService,
    private readonly customDomainsService: CustomDomainsService,
  ) {}

  /**
   * Redirect short code to original URL
   * GET /link/:shortCode
   */
  @Get(':shortCode')
  @ApiOperation({
    summary: 'Redirect short link',
    description:
      'Public endpoint that redirects a short code to its original URL and tracks the click',
  })
  @ApiParam({
    name: 'shortCode',
    description: 'The short code identifier',
    example: 'abc123',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to original URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Short link not found or inactive',
  })
  async redirect(
    @Param('shortCode') shortCode: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const host = request.headers.host || '';
      this.logger.debug(`Redirect request for ${shortCode} on host ${host}`);

      // Check if this is a custom domain
      const customDomain = await this.customDomainsService.findByDomain(host);

      let linkIdentifier:
        | { shortCode: string }
        | { customDomainId: string; customSlug: string };

      if (customDomain) {
        // Custom domain: use domain + slug
        this.logger.log(`Custom domain detected: ${customDomain.domain}`);
        linkIdentifier = {
          customDomainId: customDomain.id,
          customSlug: shortCode, // The :shortCode param is actually the slug
        };
      } else {
        // Default domain: use short code
        linkIdentifier = {
          shortCode,
        };
      }

      // Process the click
      const result = await this.clickProcessorService.processClick(
        linkIdentifier,
        request,
      );

      if (!result.redirectUrl) {
        this.logger.warn(`Short link not found or inactive: ${JSON.stringify(linkIdentifier)}`);
        throw new NotFoundException('Link not found or no longer active');
      }

      // Perform the redirect (302 temporary redirect)
      this.logger.debug(`Redirecting to ${result.redirectUrl}`);
      response.redirect(HttpStatus.FOUND, result.redirectUrl);
    } catch (error) {
      this.logger.error(
        `Error processing redirect for ${shortCode}: ${error.message}`,
        error.stack,
      );

      if (error instanceof NotFoundException) {
        response.status(HttpStatus.NOT_FOUND).send('Link not found');
      } else {
        response
          .status(HttpStatus.INTERNAL_SERVER_ERROR)
          .send('Error processing link');
      }
    }
  }

}
