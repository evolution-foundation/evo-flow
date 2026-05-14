import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Custom Domain Entity
 * Represents a custom domain configured for short links
 * Example: evolution-api.com, seucliente.com.br
 */
@Entity('custom_domains')
@Index(['domain'], { unique: true })
export class CustomDomain {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Custom domain name
   * Example: evolution-api.com
   */
  @Column({ unique: true })
  domain: string;

  /**
   * Whether the domain DNS is verified
   * Requires CNAME pointing to redirect service
   */
  @Column({ name: 'is_verified', default: false })
  isVerified: boolean;

  /**
   * Token for DNS verification
   * User must add TXT record: _evo-verify.domain.com TXT "token"
   */
  @Column({ name: 'verification_token', nullable: true })
  verificationToken: string;

  /**
   * Whether the domain is active and can be used
   */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /**
   * SSL certificate status
   * auto, manual, none
   */
  @Column({ name: 'ssl_mode', default: 'auto' })
  sslMode: string;

  /**
   * SSL certificate data (if manual)
   */
  @Column({ name: 'ssl_certificate', type: 'text', nullable: true })
  sslCertificate: string;

  /**
   * SSL private key (if manual)
   */
  @Column({ name: 'ssl_private_key', type: 'text', nullable: true })
  sslPrivateKey: string;

  /**
   * Target CNAME that DNS should point to
   * Example: redirect.evo.link
   */
  @Column({ name: 'target_cname', nullable: true })
  targetCname: string;

  /**
   * Last verification attempt timestamp
   */
  @Column({ name: 'last_verified_at', type: 'timestamp', nullable: true })
  lastVerifiedAt: Date;

  /**
   * Metadata for additional configuration
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
