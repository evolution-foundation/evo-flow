import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nanoid, customAlphabet } from 'nanoid';
import { ShortLink } from '../entities/short-link.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class UrlShortenerService {
  private readonly logger = new CustomLoggerService(UrlShortenerService.name);
  private readonly shortCodeLength = parseInt(
    process.env.SHORT_URL_LENGTH || '7',
    10,
  );
  private readonly baseDomain =
    process.env.SHORT_URL_BASE_DOMAIN || 'https://evo.link';

  // Use only safe characters (avoid confusion like 0/O, 1/l/I)
  private readonly customNanoid = customAlphabet(
    '0123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz',
    this.shortCodeLength,
  );

  constructor(
    @InjectRepository(ShortLink)
    private shortLinkRepository: Repository<ShortLink>,
  ) {}

  /**
   * Generate a unique short code
   * @param customCode Optional custom code provided by user
   * @returns Unique short code
   */
  async generateShortCode(customCode?: string): Promise<string> {
    if (customCode) {
      // Validate and sanitize custom code
      const sanitized = this.sanitizeCustomCode(customCode);
      if (await this.isCodeAvailable(sanitized)) {
        return sanitized;
      }
      throw new Error(
        `Custom code "${customCode}" is already in use or invalid`,
      );
    }

    // Generate random code and check for collisions
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const code = this.customNanoid();

      if (await this.isCodeAvailable(code)) {
        this.logger.debug(`Generated short code: ${code} (attempt ${attempts + 1})`);
        return code;
      }

      attempts++;
    }

    // Fallback to longer code if collision persists
    const fallbackCode = nanoid(this.shortCodeLength + 2);
    this.logger.warn(
      `Using fallback code after ${maxAttempts} attempts: ${fallbackCode}`,
    );
    return fallbackCode;
  }

  /**
   * Check if a short code is available
   */
  async isCodeAvailable(code: string): Promise<boolean> {
    const existing = await this.shortLinkRepository.findOne({
      where: { shortCode: code },
    });
    return !existing;
  }

  /**
   * Build full short URL
   */
  buildShortUrl(shortCode: string): string {
    // Remove trailing slash from base domain
    const base = this.baseDomain.replace(/\/$/, '');
    return `${base}/link/${shortCode}`;
  }

  /**
   * Sanitize custom code
   * - Convert to lowercase
   * - Replace spaces and special chars with hyphens
   * - Remove consecutive hyphens
   * - Max length 20 chars
   */
  private sanitizeCustomCode(code: string): string {
    return code
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 20);
  }
}
