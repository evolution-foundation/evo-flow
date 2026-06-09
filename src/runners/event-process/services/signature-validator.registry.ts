import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { Platform } from 'src/shared/broker/contracts/platform.enum';
import { ISignatureValidator } from '../validators/signature-validator.interface';
import { EvolutionApiValidator } from '../validators/evolution-api.validator';
import { SparkPostValidator } from '../validators/sparkpost.validator';
import { SendGridValidator } from '../validators/sendgrid.validator';
import { MailerSendValidator } from '../validators/mailersend.validator';
import { ResendValidator } from '../validators/resend.validator';
import { SesValidator } from '../validators/ses.validator';
import { MandrillValidator } from '../validators/mandrill.validator';

/**
 * Resolves the signature validator for a given `events.received.<platform>`
 * envelope (story 3.4 / EVO-1210). Validators are plain classes (not Nest
 * providers) constructed here with their per-provider secrets read from env via
 * ConfigService, which keeps each validator trivially unit-testable with a
 * known secret. `for` returns null for `unknown` or any unregistered platform —
 * the caller drops those envelopes.
 */
@Injectable()
export class SignatureValidatorRegistry {
  private readonly logger = new CustomLoggerService(
    SignatureValidatorRegistry.name,
  );
  private readonly validators: Map<Platform, ISignatureValidator>;

  constructor(config: ConfigService) {
    const evolutionToken = config.get<string>('EVOLUTION_API_WEBHOOK_TOKEN');
    const sparkpostUser = config.get<string>('SPARKPOST_WEBHOOK_USER');
    const sparkpostPassword = config.get<string>('SPARKPOST_WEBHOOK_PASSWORD');
    const sendgridKey = config.get<string>('SENDGRID_WEBHOOK_VERIFICATION_KEY');
    const mailersendSecret = config.get<string>('MAILERSEND_WEBHOOK_SECRET');
    const resendSecret = config.get<string>('RESEND_WEBHOOK_SECRET');
    const mandrillSecret = config.get<string>('MANDRILL_WEBHOOK_SECRET');
    const mandrillUrl = config.get<string>('MANDRILL_WEBHOOK_URL');

    this.validators = new Map<Platform, ISignatureValidator>([
      ['evolution-api', new EvolutionApiValidator(evolutionToken)],
      ['sparkpost', new SparkPostValidator(sparkpostUser, sparkpostPassword)],
      ['sendgrid', new SendGridValidator(sendgridKey)],
      ['mailersend', new MailerSendValidator(mailersendSecret)],
      ['resend', new ResendValidator(resendSecret)],
      ['ses', new SesValidator()],
      ['mandrill', new MandrillValidator(mandrillSecret, mandrillUrl)],
    ]);

    this.warnUnconfigured({
      'evolution-api': !evolutionToken,
      sparkpost: !sparkpostUser || !sparkpostPassword,
      mailersend: !mailersendSecret,
      resend: !resendSecret,
      mandrill: !mandrillSecret || !mandrillUrl,
    });
  }

  for(platform: string): ISignatureValidator | null {
    return this.validators.get(platform as Platform) ?? null;
  }

  /**
   * Logs once at boot for every provider whose secret is unset, so a
   * fail-closed drop caused by missing config surfaces as misconfiguration
   * instead of masquerading as an attack in the signature-invalid metric.
   * `sendgrid` (opt-in, passes through without a key) and `ses` (cert-based, no
   * shared secret) are intentionally excluded.
   */
  private warnUnconfigured(missingByPlatform: Record<string, boolean>): void {
    const missing = Object.keys(missingByPlatform).filter(
      (platform) => missingByPlatform[platform],
    );
    if (missing.length === 0) return;
    this.logger.warn('event-process.signature.unconfigured-secrets', {
      action: 'event-process.signature.unconfigured-secrets',
      platforms: missing,
      hint: 'these providers fail-closed (drop every event) until their *_WEBHOOK_SECRET is configured',
    });
  }
}
