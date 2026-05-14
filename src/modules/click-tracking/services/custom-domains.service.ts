import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomDomain } from '../entities/custom-domain.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { randomBytes } from 'crypto';
import * as dns from 'dns';
import { promisify } from 'util';

const resolveTxt = promisify(dns.resolveTxt);
const resolveCname = promisify(dns.resolveCname);

/**
 * Custom Domains Service
 * Handles custom domain registration, verification, and management
 */
@Injectable()
export class CustomDomainsService {
  private readonly logger = new CustomLoggerService(
    CustomDomainsService.name,
  );

  constructor(
    @InjectRepository(CustomDomain)
    private readonly customDomainRepository: Repository<CustomDomain>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new custom domain
   */
  async create(
    domain: string,
    targetCname?: string,
  ): Promise<CustomDomain> {
    try {
      // Validate domain format
      if (!this.isValidDomain(domain)) {
        throw new BadRequestException('Invalid domain format');
      }

      // Validate targetCname format (must not include protocol or port)
      if (targetCname) {
        if (targetCname.includes('://') || targetCname.includes(':')) {
          throw new BadRequestException(
            'Target CNAME must be a hostname only (e.g., "redirect.evo.link"), not a URL',
          );
        }
      }

      // Check if domain already exists
      const existing = await this.customDomainRepository.findOne({
        where: { domain },
      });

      if (existing) {
        throw new ConflictException('Domain already registered');
      }

      // Generate verification token
      const verificationToken = this.generateVerificationToken();

      // Default targetCname for development vs production
      const defaultCname =
        process.env.NODE_ENV === 'production'
          ? 'redirect.evo.link'
          : 'localhost';

      // Create custom domain
      const customDomain = this.customDomainRepository.create({
        domain,
        verificationToken,
        targetCname:
          targetCname ||
          process.env.SHORT_URL_BASE_DOMAIN ||
          defaultCname,
        isVerified: false,
        isActive: false, // Only active after verification
      });

      const saved = await this.customDomainRepository.save(customDomain);

      this.eventEmitter.emit('custom-domain.created', {
        id: saved.id,
        domain,
      });

      this.logger.log(`Created custom domain ${domain}`);

      return saved;
    } catch (error) {
      this.logger.error(
        `Error creating custom domain: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Verify domain DNS configuration
   */
  async verifyDomain(id: string): Promise<CustomDomain> {
    const domain = await this.findById(id);

    try {
      this.logger.log(`🔍 Verifying DNS for domain ${domain.domain}`);

      // In development, allow bypassing DNS verification
      const isDevelopment = process.env.NODE_ENV !== 'production';
      const skipDnsVerification = process.env.SKIP_DNS_VERIFICATION === 'true';

      this.logger.log(
        `DNS Verification Check - isDevelopment: ${isDevelopment}, skipDnsVerification: ${skipDnsVerification}, NODE_ENV: ${process.env.NODE_ENV}`,
      );

      if (isDevelopment && skipDnsVerification) {
        this.logger.warn(
          `⚠️ Skipping DNS verification for ${domain.domain} (development mode)`,
        );

        domain.isVerified = true;
        domain.isActive = true;
        domain.lastVerifiedAt = new Date();

        await this.customDomainRepository.save(domain);

        this.eventEmitter.emit('custom-domain.verified', {
          id: domain.id,
          domain: domain.domain,
        });

        this.logger.log(
          `Domain ${domain.domain} verified (DNS check bypassed)`,
        );

        return domain;
      }

      // Check TXT record for verification token
      const txtVerified = await this.verifyTxtRecord(domain);

      // Check CNAME record pointing to our service
      const cnameVerified = await this.verifyCnameRecord(domain);

      if (txtVerified && cnameVerified) {
        domain.isVerified = true;
        domain.isActive = true;
        domain.lastVerifiedAt = new Date();

        await this.customDomainRepository.save(domain);

        this.eventEmitter.emit('custom-domain.verified', {
          id: domain.id,
          domain: domain.domain,
        });

        this.logger.log(`Domain ${domain.domain} verified successfully`);
      } else {
        throw new BadRequestException(
          `DNS verification failed. TXT: ${txtVerified}, CNAME: ${cnameVerified}`,
        );
      }

      return domain;
    } catch (error) {
      this.logger.error(
        `DNS verification failed for ${domain.domain}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`DNS verification failed: ${error.message}`);
    }
  }

  /**
   * Verify TXT record for domain verification
   */
  private async verifyTxtRecord(domain: CustomDomain): Promise<boolean> {
    try {
      const txtRecords = await resolveTxt(`_evo-verify.${domain.domain}`);
      const flatRecords = txtRecords.flat();

      const found = flatRecords.some(record =>
        record.includes(domain.verificationToken)
      );

      this.logger.log(
        `TXT verification for ${domain.domain}: ${found ? '✅' : '❌'}`,
      );

      return found;
    } catch (error) {
      this.logger.warn(
        `TXT record not found for ${domain.domain}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Verify CNAME record pointing to our service
   */
  private async verifyCnameRecord(domain: CustomDomain): Promise<boolean> {
    try {
      const cnameRecords = await resolveCname(domain.domain);

      const found = cnameRecords.some(record =>
        record.includes(domain.targetCname) ||
        record.includes('evo.link') ||
        record.includes('localhost') // For development
      );

      this.logger.log(
        `CNAME verification for ${domain.domain}: ${found ? '✅' : '❌'} (${cnameRecords.join(', ')})`,
      );

      return found;
    } catch (error) {
      this.logger.warn(
        `CNAME record not found for ${domain.domain}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Find custom domain by ID
   */
  async findById(id: string): Promise<CustomDomain> {
    const domain = await this.customDomainRepository.findOne({
      where: { id },
    });

    if (!domain) {
      throw new NotFoundException(`Custom domain ${id} not found`);
    }

    return domain;
  }

  /**
   * Find custom domain by domain name
   */
  async findByDomain(domain: string): Promise<CustomDomain | null> {
    return await this.customDomainRepository.findOne({
      where: { domain, isActive: true, isVerified: true },
    });
  }

  /**
   * List all custom domains for account
   */
  async findAll(options?: {
    isVerified?: boolean;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ domains: CustomDomain[]; total: number }> {
    const query = this.customDomainRepository.createQueryBuilder('domain');

    // Apply filters
    if (options?.isVerified !== undefined) {
      query.andWhere('domain.isVerified = :isVerified', {
        isVerified: options.isVerified,
      });
    }

    if (options?.isActive !== undefined) {
      query.andWhere('domain.isActive = :isActive', {
        isActive: options.isActive,
      });
    }

    // Get total count
    const total = await query.getCount();

    // Apply pagination
    if (options?.limit) {
      query.take(options.limit);
    }

    if (options?.offset) {
      query.skip(options.offset);
    }

    // Order by most recent
    query.orderBy('domain.createdAt', 'DESC');

    const domains = await query.getMany();

    return { domains, total };
  }

  /**
   * Update custom domain
   */
  async update(
    id: string,
    data: Partial<CustomDomain>,
  ): Promise<CustomDomain> {
    const domain = await this.findById(id);

    // Update allowed fields
    if (data.isActive !== undefined) {
      domain.isActive = data.isActive;
    }

    if (data.sslMode !== undefined) {
      domain.sslMode = data.sslMode;
    }

    if (data.metadata !== undefined) {
      domain.metadata = data.metadata;
    }

    const updated = await this.customDomainRepository.save(domain);

    this.eventEmitter.emit('custom-domain.updated', { id });

    this.logger.log(`Updated custom domain ${id}`);

    return updated;
  }

  /**
   * Delete custom domain
   */
  async delete(id: string): Promise<void> {
    const domain = await this.findById(id);

    await this.customDomainRepository.remove(domain);

    this.eventEmitter.emit('custom-domain.deleted', {
      id,
      domain: domain.domain,
    });

    this.logger.log(`Deleted custom domain ${id}`);
  }

  /**
   * Generate verification token
   */
  private generateVerificationToken(): string {
    return `evo-verify-${randomBytes(16).toString('hex')}`;
  }

  /**
   * Validate domain format
   */
  private isValidDomain(domain: string): boolean {
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
    return domainRegex.test(domain);
  }

  /**
   * Get DNS setup instructions
   */
  getDnsInstructions(domain: CustomDomain): {
    txtRecord: { name: string; value: string };
    cnameRecord: { name: string; value: string };
  } {
    // Clean targetCname: remove protocol and port if present (fallback for legacy data)
    let cleanCname = domain.targetCname;
    if (cleanCname.includes('://')) {
      // Remove protocol (http:// or https://)
      cleanCname = cleanCname.split('://')[1];
    }
    if (cleanCname.includes(':')) {
      // Remove port
      cleanCname = cleanCname.split(':')[0];
    }

    return {
      txtRecord: {
        name: `_evo-verify.${domain.domain}`,
        value: domain.verificationToken,
      },
      cnameRecord: {
        name: domain.domain,
        value: cleanCname, // Use cleaned value
      },
    };
  }
}
